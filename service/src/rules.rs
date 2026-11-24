use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::host_identity::{self, Account, HostIdentityResolver};

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

const OVERRIDE_VERSION: u32 = 12;
const MAX_OVERRIDE_FILES: usize = 256;
const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OVERRIDE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOOL_OVERRIDES: usize = 256;
const MAX_WORKSPACE_MODES: usize = 32;
const MAX_MCP_SERVER_OVERRIDES: usize = 32;
const MAX_MCP_POLICY_LAYERS: usize = 256;
const MAX_MCP_RULES_PER_SERVER: usize = 256;
const MAX_MCP_RULES_TOTAL: usize = 1024;
const MAX_MCP_BYTES: usize = 256 * 1024;
const MAX_ENVIRONMENT_VARIABLE_NAME_BYTES: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8192;
const MAX_SECRET_PATH_BYTES: usize = 4096;
const MAX_SECRET_FILE_BYTES: usize = MAX_ENVIRONMENT_VALUE_BYTES + 2;
const MAX_ENVIRONMENT_VARIABLES_PER_SCOPE: usize = 128;
const MAX_EXTENSION_ENVIRONMENTS: usize = 64;
const MAX_ENVIRONMENT_VARIABLES_TOTAL: usize = 256;
const MAX_ENVIRONMENT_BYTES_TOTAL: usize = 64 * 1024;

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IdentityRecord<M = McpOverrides> {
    version: u32,
    uid: Option<u32>,
    user: Option<String>,
    gid: Option<u32>,
    group: Option<String>,
    #[serde(default)]
    environment: IdentityEnvironment,
    comment: Option<String>,
    #[serde(default)]
    overrides: IdentityOverrides<M>,
}

#[derive(Clone, Copy)]
enum RecordKind {
    User,
    Group,
}

impl<M: Default> IdentityRecord<M> {
    fn empty() -> Self {
        Self {
            version: OVERRIDE_VERSION,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IdentityEnvironment {
    #[serde(default)]
    pi: EnvironmentVariables<PiEnvironmentValue>,
    #[serde(default)]
    sandbox: EnvironmentVariables,
    #[serde(default)]
    extensions: ExtensionEnvironments,
}

/// The authored and wire object forms cannot cross their serialization boundary:
/// references are input-only, and opaque resolved literals are output-only.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum PiEnvironmentValue {
    Template(String),
    #[serde(skip_serializing)]
    File(SecretFileReference),
    #[serde(skip_deserializing)]
    Literal(ResolvedSecret),
}

impl PiEnvironmentValue {
    fn as_str(&self) -> &str {
        match self {
            Self::Template(value) => value,
            Self::File(reference) => &reference.file,
            Self::Literal(value) => &value.literal,
        }
    }
}

impl From<String> for PiEnvironmentValue {
    fn from(value: String) -> Self {
        Self::Template(value)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SecretFileReference {
    file: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct ResolvedSecret {
    literal: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct EnvironmentVariables<V = String>(BTreeMap<String, V>);

impl<V> Default for EnvironmentVariables<V> {
    fn default() -> Self {
        Self(BTreeMap::new())
    }
}

impl<V> EnvironmentVariables<V> {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter()
    }

    #[cfg(test)]
    fn get(&self, name: &str) -> Option<&V> {
        self.0.get(name)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for EnvironmentVariables<V> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct EnvironmentVariablesVisitor<V>(std::marker::PhantomData<V>);

        impl<'de, V: Deserialize<'de>> Visitor<'de> for EnvironmentVariablesVisitor<V> {
            type Value = EnvironmentVariables<V>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique environment variables")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((name, value)) = map.next_entry::<String, V>()? {
                    if values.insert(name.clone(), value).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate environment variable: {name}"
                        )));
                    }
                }
                Ok(EnvironmentVariables(values))
            }
        }

        deserializer.deserialize_map(EnvironmentVariablesVisitor(std::marker::PhantomData))
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct ExtensionEnvironments(BTreeMap<String, EnvironmentVariables>);

impl ExtensionEnvironments {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &EnvironmentVariables)> {
        self.0.iter()
    }
}

impl<'de> Deserialize<'de> for ExtensionEnvironments {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ExtensionEnvironmentsVisitor;

        impl<'de> Visitor<'de> for ExtensionEnvironmentsVisitor {
            type Value = ExtensionEnvironments;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique extension environments")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((name, environment)) =
                    map.next_entry::<String, EnvironmentVariables>()?
                {
                    if values.insert(name.clone(), environment).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate extension environment: {name}"
                        )));
                    }
                }
                Ok(ExtensionEnvironments(values))
            }
        }

        deserializer.deserialize_map(ExtensionEnvironmentsVisitor)
    }
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IdentityOverrides<M = McpOverrides> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace: Option<WorkspaceOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution: Option<ExecutionOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    network: Option<NetworkConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    filesystem: Option<FilesystemConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp: Option<M>,
    #[serde(default)]
    tools: ToolOverrides,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct WorkspaceOverrides {
    // Keep authored arrays intact until structural validation rejects duplicates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allowed: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct McpOverrides {
    servers: McpServerOverrides,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct McpServerOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_policy: Option<McpApprovalPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_rules: Option<Vec<McpToolRule>>,
}

/// Only invocation approval can change; audit and Bash command classes stay out.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct McpApprovalPolicy {
    mode: PolicyMode,
    session_grant: SessionGrantPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct McpToolRule {
    #[serde(rename = "match")]
    pattern: String,
    mode: PolicyMode,
    session_grant: SessionGrantPolicy,
}

/// A file's default remains attached to its ordered rules until tool discovery.
#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct McpPolicyLayer {
    #[serde(skip_serializing_if = "Option::is_none")]
    default_policy: Option<McpApprovalPolicy>,
    tool_rules: Vec<McpToolRule>,
}

/// Wire types deliberately cannot deserialize authored administrator files.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
struct ResolvedMcpOverrides {
    servers: ResolvedMcpServers,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct ResolvedMcpServers(BTreeMap<String, ResolvedMcpServerOverride>);

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
struct ResolvedMcpServerOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    policy_layers: Vec<McpPolicyLayer>,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct McpServerOverrides(BTreeMap<String, McpServerOverride>);

impl<'de> Deserialize<'de> for McpServerOverrides {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct McpServerOverridesVisitor;

        impl<'de> Visitor<'de> for McpServerOverridesVisitor {
            type Value = McpServerOverrides;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique MCP server overrides")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut servers = BTreeMap::new();
                while let Some((name, policy)) = map.next_entry::<String, McpServerOverride>()? {
                    if servers.insert(name.clone(), policy).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate MCP server override: {name}"
                        )));
                    }
                    if servers.len() > MAX_MCP_SERVER_OVERRIDES {
                        return Err(serde::de::Error::custom("too many MCP server overrides"));
                    }
                }
                Ok(McpServerOverrides(servers))
            }
        }

        deserializer.deserialize_map(McpServerOverridesVisitor)
    }
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ExecutionOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backend: Option<ExecutionBackend>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ExecutionBackend {
    Bubblewrap,
    Direct,
    Seatbelt,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FilesystemConfig {
    cwd_writable: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NetworkConfig {
    mode: NetworkMode,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum NetworkMode {
    None,
    Local,
    Host,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct ToolOverrides(BTreeMap<String, SubjectPolicy>);

impl ToolOverrides {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &SubjectPolicy)> {
        self.0.iter()
    }

    #[cfg(test)]
    fn get(&self, name: &str) -> Option<&SubjectPolicy> {
        self.0.get(name)
    }
}

impl<'de> Deserialize<'de> for ToolOverrides {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ToolOverridesVisitor;

        impl<'de> Visitor<'de> for ToolOverridesVisitor {
            type Value = ToolOverrides;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique tool policy overrides")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((name, policy)) = map.next_entry::<String, SubjectPolicy>()? {
                    if values.insert(name.clone(), policy).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate tool override: {name}"
                        )));
                    }
                }
                Ok(ToolOverrides(values))
            }
        }

        deserializer.deserialize_map(ToolOverridesVisitor)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SubjectPolicy {
    mode: PolicyMode,
    session_grant: SessionGrantPolicy,
    /// Bash-only command-class policy; see specs/bash-command-analysis.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    known_read_only: Option<ClassPolicy>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum PolicyMode {
    Allow,
    Ask,
    Deny,
    Disabled,
}

/// Ordered from least to most permissive.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum SessionGrantPolicy {
    Never,
    Offer,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ClassPolicy {
    mode: ClassMode,
    session_grant: SessionGrantPolicy,
}

/// Command-class modes, ordered from least to most permissive. Availability is
/// tool-level only, so `disabled` is not a class mode.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum ClassMode {
    Deny,
    Ask,
    Allow,
}

#[derive(Debug, PartialEq, Eq)]
enum LookupError {
    InvalidFile,
    Io,
    TimedOut,
}
impl LookupError {
    fn from_io(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::TimedOut {
            Self::TimedOut
        } else {
            Self::Io
        }
    }
    fn service_error(self) -> crate::protocol::Error {
        if self == Self::TimedOut {
            crate::protocol::Error("busy")
        } else {
            crate::protocol::CONFIG
        }
    }
}

struct BoundedWriter<W> {
    inner: W,
    remaining: usize,
}
impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::other("serialized policy exceeds limit"));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn bounded_json(value: &impl Serialize, maximum: usize) -> bool {
    serde_json::to_writer(
        BoundedWriter {
            inner: io::sink(),
            remaining: maximum,
        },
        value,
    )
    .is_ok()
}

trait IdentityResolver {
    fn account(&mut self, uid: u32) -> io::Result<Option<Account>>;
    fn groups(&mut self, account: &Account) -> io::Result<BTreeSet<u32>>;
    fn group(&mut self, name: &str) -> io::Result<Option<u32>>;
}
impl IdentityResolver for HostIdentityResolver {
    fn account(&mut self, uid: u32) -> io::Result<Option<Account>> {
        HostIdentityResolver::account(self, uid)
    }
    fn groups(&mut self, account: &Account) -> io::Result<BTreeSet<u32>> {
        HostIdentityResolver::groups(self, account)
    }
    fn group(&mut self, name: &str) -> io::Result<Option<u32>> {
        HostIdentityResolver::group(self, name)
    }
}

fn read_records(
    directory: &Path,
    owner: u32,
    deadline: Instant,
) -> Result<Vec<IdentityRecord>, LookupError> {
    use std::os::fd::AsRawFd;
    let config_dir = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(directory)
    {
        Ok(dir) => dir,
        Err(_) => return Err(LookupError::Io),
    };
    validate_directory_metadata(&config_dir, owner)?;
    let config_path = std::path::PathBuf::from(format!("/proc/self/fd/{}", config_dir.as_raw_fd()));
    let mut records = Vec::new();
    let mut bytes_total = 0;
    for (subdir, kind) in [
        ("users.d", RecordKind::User),
        ("groups.d", RecordKind::Group),
    ] {
        let path = config_path.join(subdir);
        let dir = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(LookupError::Io),
        };
        validate_directory_metadata(&dir, owner)?;
        // Enumerate the opened directory, so replacement of its pathname cannot redirect reads.
        let stable_path = std::path::PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()));
        for entry in std::fs::read_dir(&stable_path).map_err(LookupError::from_io)? {
            if Instant::now() >= deadline {
                return Err(LookupError::TimedOut);
            }
            let entry = entry.map_err(LookupError::from_io)?;
            if entry.path().extension().is_none_or(|ext| ext != "toml") {
                continue;
            }
            if records.len() == MAX_OVERRIDE_FILES {
                return Err(LookupError::InvalidFile);
            }
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(entry.path())
                .map_err(LookupError::from_io)?;
            validate_override_file_metadata(&file, owner)?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_OVERRIDE_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(LookupError::from_io)?;
            bytes_total += bytes.len();
            if bytes.len() as u64 > MAX_OVERRIDE_FILE_BYTES || bytes_total > MAX_STORE_BYTES {
                return Err(LookupError::InvalidFile);
            }
            records.push(parse_record(&bytes, kind)?);
        }
    }
    Ok(records)
}

#[cfg(test)]
fn resolve_records(
    records: Vec<IdentityRecord>,
    uid: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
) -> Result<IdentityRecord<ResolvedMcpOverrides>, LookupError> {
    resolve_records_with_reader(records, uid, resolver, deadline, &mut read_secret_file)
}
#[cfg(test)]
fn resolve_records_with_reader(
    records: Vec<IdentityRecord>,
    uid: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
    reader: &mut impl FnMut(&str, Instant) -> Result<String, LookupError>,
) -> Result<IdentityRecord<ResolvedMcpOverrides>, LookupError> {
    let mut result = join_records(records, uid, resolver, deadline)?;
    resolve_pi_environment(&mut result.environment, deadline, reader)?;
    Ok(result)
}

fn join_records(
    records: Vec<IdentityRecord>,
    uid: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
) -> Result<IdentityRecord<ResolvedMcpOverrides>, LookupError> {
    let needs_account = records
        .iter()
        .any(|r| r.user.is_some() || r.group.is_some() || r.gid.is_some());
    let account = if needs_account {
        Some(
            resolver
                .account(uid)
                .map_err(LookupError::from_io)?
                .ok_or(LookupError::Io)?,
        )
    } else {
        None
    };
    let needs_groups = records.iter().any(|r| r.group.is_some() || r.gid.is_some());
    let groups = if needs_groups {
        resolver
            .groups(account.as_ref().ok_or(LookupError::Io)?)
            .map_err(LookupError::from_io)?
    } else {
        BTreeSet::new()
    };
    let mut result = IdentityRecord::empty();
    let mut group_ids = BTreeMap::new();
    for record in records {
        if Instant::now() >= deadline {
            return Err(LookupError::TimedOut);
        }
        let matches = if let Some(id) = record.uid {
            id == uid
        } else if let Some(ref name) = record.user {
            account.as_ref().is_some_and(|a| a.user == *name)
        } else if let Some(id) = record.gid {
            groups.contains(&id)
        } else {
            let name = record.group.as_ref().ok_or(LookupError::InvalidFile)?;
            let id = match group_ids.get(name) {
                Some(id) => *id,
                None => {
                    let id = resolver
                        .group(name)
                        .map_err(LookupError::from_io)?
                        .ok_or(LookupError::Io)?;
                    group_ids.insert(name.clone(), id);
                    id
                }
            };
            groups.contains(&id)
        };
        if matches {
            merge_record(&mut result, record)?;
        }
    }
    if Instant::now() >= deadline {
        return Err(LookupError::TimedOut);
    }
    normalize_class_policies(&mut result.overrides.tools);
    // Joining an explicit true can shorten the encoding of false. Check this
    // non-monotone byte limit only after all matching records have combined.
    if result
        .overrides
        .mcp
        .as_ref()
        .is_some_and(|mcp| !bounded_json(mcp, MAX_MCP_BYTES))
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(result)
}

fn resolve_pi_environment(
    environment: &mut IdentityEnvironment,
    deadline: Instant,
    reader: &mut impl FnMut(&str, Instant) -> Result<String, LookupError>,
) -> Result<(), LookupError> {
    let mut cache = BTreeMap::new();
    for value in environment.pi.0.values_mut() {
        if Instant::now() >= deadline {
            return Err(LookupError::TimedOut);
        }
        if let PiEnvironmentValue::File(reference) = value {
            let literal = match cache.get(&reference.file) {
                Some(value) => String::clone(value),
                None => {
                    let value = reader(&reference.file, deadline)?;
                    cache.insert(reference.file.clone(), value.clone());
                    value
                }
            };
            *value = PiEnvironmentValue::Literal(ResolvedSecret { literal });
        }
    }
    if Instant::now() >= deadline {
        return Err(LookupError::TimedOut);
    }
    if !valid_environment(environment) {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

/// Deployment controls access and path integrity. Ordinary symlinks are followed;
/// O_NONBLOCK and the descriptor type check prevent reading a FIFO or device.
fn read_secret_file(path: &str, deadline: Instant) -> Result<String, LookupError> {
    if Instant::now() >= deadline {
        return Err(LookupError::TimedOut);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(LookupError::from_io)?;
    let metadata = file.metadata().map_err(LookupError::from_io)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_SECRET_FILE_BYTES as u64 {
        return Err(LookupError::InvalidFile);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_SECRET_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(LookupError::from_io)?;
    if Instant::now() >= deadline {
        return Err(LookupError::TimedOut);
    }
    if bytes.len() > MAX_SECRET_FILE_BYTES {
        return Err(LookupError::InvalidFile);
    }
    let mut value = String::from_utf8(bytes).map_err(|_| LookupError::InvalidFile)?;
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    if !valid_secret_value(&value) {
        return Err(LookupError::InvalidFile);
    }
    Ok(value)
}

fn valid_secret_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ENVIRONMENT_VALUE_BYTES && !value.contains('\0')
}

fn merge_equal<T: PartialEq>(
    target: &mut Option<T>,
    incoming: Option<T>,
) -> Result<(), LookupError> {
    if let Some(value) = incoming {
        if target.as_ref().is_some_and(|existing| *existing != value) {
            return Err(LookupError::InvalidFile);
        }
        *target = Some(value);
    }
    Ok(())
}
fn merge_environment<V: PartialEq>(
    target: &mut EnvironmentVariables<V>,
    incoming: EnvironmentVariables<V>,
) -> Result<(), LookupError> {
    for (name, value) in incoming.0 {
        if target.0.get(&name).is_some_and(|old| *old != value) {
            return Err(LookupError::InvalidFile);
        }
        target.0.insert(name, value);
    }
    Ok(())
}
fn policy_rank(policy: &SubjectPolicy) -> u8 {
    match policy.mode {
        PolicyMode::Disabled => 0,
        PolicyMode::Deny => 1,
        PolicyMode::Ask => {
            if matches!(policy.session_grant, SessionGrantPolicy::Offer) {
                3
            } else {
                2
            }
        }
        PolicyMode::Allow => 4,
    }
}
/// Whether `class` is strictly more permissive than the tool's main policy.
/// A class policy never applies under a disabled main policy.
fn class_exceeds_main(class: &ClassPolicy, main: &SubjectPolicy) -> bool {
    let main_mode = match main.mode {
        PolicyMode::Disabled => return false,
        PolicyMode::Deny => ClassMode::Deny,
        PolicyMode::Ask => ClassMode::Ask,
        PolicyMode::Allow => ClassMode::Allow,
    };
    class.mode > main_mode
        || (class.mode == ClassMode::Ask
            && main_mode == ClassMode::Ask
            && class.session_grant > main.session_grant)
}
/// Least-restrictive join of class policies; an absent policy is the identity.
fn join_class_policies(
    left: Option<ClassPolicy>,
    right: Option<ClassPolicy>,
) -> Option<ClassPolicy> {
    match (left, right) {
        (None, policy) | (policy, None) => policy,
        (Some(left), Some(right)) => {
            let mode = left.mode.max(right.mode);
            let session_grant = if mode == ClassMode::Ask {
                left.session_grant.max(right.session_grant)
            } else {
                SessionGrantPolicy::Never
            };
            Some(ClassPolicy {
                mode,
                session_grant,
            })
        }
    }
}
/// Drop combined class policies that no longer exceed their combined main policy.
fn normalize_class_policies(tools: &mut ToolOverrides) {
    for policy in tools.0.values_mut() {
        if policy
            .known_read_only
            .as_ref()
            .is_some_and(|class| !class_exceeds_main(class, policy))
        {
            policy.known_read_only = None;
        }
    }
}
fn merge_record(
    target: &mut IdentityRecord<ResolvedMcpOverrides>,
    incoming: IdentityRecord,
) -> Result<(), LookupError> {
    merge_environment(&mut target.environment.pi, incoming.environment.pi)?;
    merge_environment(
        &mut target.environment.sandbox,
        incoming.environment.sandbox,
    )?;
    for (name, vars) in incoming.environment.extensions.0 {
        merge_environment(
            target.environment.extensions.0.entry(name).or_default(),
            vars,
        )?;
    }
    let old = &mut target.overrides;
    let new = incoming.overrides;
    if let Some(workspace) = new.workspace {
        let current = old
            .workspace
            .get_or_insert_with(WorkspaceOverrides::default);
        merge_equal(&mut current.default, workspace.default)?;
        if let Some(allowed) = workspace.allowed {
            let combined = current.allowed.get_or_insert_with(Vec::new);
            combined.extend(allowed);
            combined.sort_unstable();
            combined.dedup();
        }
    }
    merge_equal(&mut old.models_file, new.models_file)?;
    if let Some(execution) = new.execution {
        let current = old
            .execution
            .get_or_insert_with(ExecutionOverrides::default);
        merge_equal(&mut current.backend, execution.backend)?;
    }
    if let Some(network) = new.network.filter(|network| {
        old.network
            .as_ref()
            .is_none_or(|old| network.mode > old.mode)
    }) {
        old.network = Some(network);
    }
    if let Some(filesystem) = new
        .filesystem
        .filter(|filesystem| old.filesystem.is_none() || filesystem.cwd_writable)
    {
        old.filesystem = Some(filesystem);
    }
    if let Some(mcp) = new.mcp {
        let current = old.mcp.get_or_insert_with(ResolvedMcpOverrides::default);
        for (name, policy) in mcp.servers.0 {
            let server = current.servers.0.entry(name).or_default();
            if let Some(enabled) = policy.enabled {
                server.enabled = Some(server.enabled.unwrap_or(false) || enabled);
            }
            if policy.default_policy.is_some() || policy.tool_rules.is_some() {
                let layer = McpPolicyLayer {
                    default_policy: policy.default_policy,
                    tool_rules: policy.tool_rules.unwrap_or_default(),
                };
                // Whole-layer deduplication is safe; merging individual patterns is not.
                if let Err(position) = server.policy_layers.binary_search(&layer) {
                    server.policy_layers.insert(position, layer);
                }
            }
        }
    }
    for (name, policy) in new.tools.0 {
        let Some(existing) = old.tools.0.get_mut(&name) else {
            old.tools.0.insert(name, policy);
            continue;
        };
        let known_read_only =
            join_class_policies(existing.known_read_only.take(), policy.known_read_only);
        if policy_rank(&policy) > policy_rank(existing) {
            existing.mode = policy.mode;
            existing.session_grant = policy.session_grant;
        }
        existing.known_read_only = known_read_only;
    }
    if !valid_environment(&target.environment) || !valid_overrides(old) {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

fn validate_directory_metadata(directory: &File, required_owner: u32) -> Result<(), LookupError> {
    let metadata = directory.metadata().map_err(LookupError::from_io)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != required_owner
        || metadata.mode() & 0o022 != 0
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

fn validate_override_file_metadata(file: &File, required_owner: u32) -> Result<(), LookupError> {
    let metadata = file.metadata().map_err(LookupError::from_io)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != required_owner
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() > MAX_OVERRIDE_FILE_BYTES
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

fn parse_record(bytes: &[u8], kind: RecordKind) -> Result<IdentityRecord, LookupError> {
    let source = std::str::from_utf8(bytes).map_err(|_| LookupError::InvalidFile)?;
    let record: IdentityRecord = toml::from_str(source).map_err(|_| LookupError::InvalidFile)?;
    let valid_selector = match kind {
        RecordKind::User => {
            record.uid.is_some() != record.user.is_some()
                && record.gid.is_none()
                && record.group.is_none()
        }
        RecordKind::Group => {
            record.gid.is_some() != record.group.is_some()
                && record.uid.is_none()
                && record.user.is_none()
        }
    };
    if record.version != OVERRIDE_VERSION
        || !valid_selector
        || record
            .user
            .as_deref()
            .is_some_and(|s| !host_identity::valid_name(s))
        || record
            .group
            .as_deref()
            .is_some_and(|s| !host_identity::valid_name(s))
        || !valid_environment(&record.environment)
        || !valid_annotation(record.comment.as_deref(), 1024)
        || !valid_overrides(&record.overrides)
        || !record_class_policies_exceed_main(&record.overrides.tools)
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(record)
}

/// Per-file rule: a class policy must be strictly more permissive than the same
/// file's main policy, which therefore cannot be `disabled`. Combined records
/// are normalized instead of rejected.
fn record_class_policies_exceed_main(tools: &ToolOverrides) -> bool {
    tools.iter().all(|(_, policy)| {
        policy
            .known_read_only
            .as_ref()
            .is_none_or(|class| class_exceeds_main(class, policy))
    })
}

fn valid_overrides<M: ValidMcpOverrides>(overrides: &IdentityOverrides<M>) -> bool {
    overrides
        .models_file
        .as_deref()
        .is_none_or(valid_models_file)
        && overrides
            .execution
            .as_ref()
            .is_none_or(|execution| execution.backend.is_some())
        && overrides.mcp.as_ref().is_none_or(ValidMcpOverrides::valid)
        && overrides
            .workspace
            .as_ref()
            .is_none_or(valid_workspace_overrides)
        && overrides.tools.len() <= MAX_TOOL_OVERRIDES
        && overrides.tools.iter().all(|(name, policy)| {
            valid_tool_name(name)
                && (!matches!(policy.session_grant, SessionGrantPolicy::Offer)
                    || matches!(policy.mode, PolicyMode::Ask))
                && policy.known_read_only.as_ref().is_none_or(|class| {
                    name == "bash"
                        && (class.session_grant == SessionGrantPolicy::Never
                            || class.mode == ClassMode::Ask)
                })
        })
}

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

fn valid_workspace_overrides(workspace: &WorkspaceOverrides) -> bool {
    (workspace.allowed.is_some() || workspace.default.is_some())
        && workspace.default.as_deref().is_none_or(valid_workspace_id)
        && workspace.allowed.as_ref().is_none_or(|allowed| {
            let mut seen = BTreeSet::new();
            allowed.len() <= MAX_WORKSPACE_MODES
                && allowed
                    .iter()
                    .all(|name| valid_workspace_id(name) && seen.insert(name))
        })
}

trait ValidMcpOverrides {
    fn valid(&self) -> bool;
}

impl ValidMcpOverrides for McpOverrides {
    fn valid(&self) -> bool {
        let mut rules_total = 0;
        !self.servers.0.is_empty()
            && self.servers.0.len() <= MAX_MCP_SERVER_OVERRIDES
            && self.servers.0.iter().all(|(name, server)| {
                valid_mcp_server_id(name)
                    && (server.enabled.is_some()
                        || server.default_policy.is_some()
                        || server.tool_rules.is_some())
                    && server.default_policy.as_ref().is_none_or(valid_mcp_pair)
                    && server.tool_rules.as_ref().is_none_or(|rules| {
                        rules_total += rules.len();
                        !rules.is_empty() && valid_mcp_rules(rules)
                    })
            })
            && rules_total <= MAX_MCP_RULES_TOTAL
            && bounded_json(self, MAX_MCP_BYTES)
    }
}

impl ValidMcpOverrides for ResolvedMcpOverrides {
    fn valid(&self) -> bool {
        let mut rules_total = 0;
        !self.servers.0.is_empty()
            && self.servers.0.len() <= MAX_MCP_SERVER_OVERRIDES
            && self.servers.0.iter().all(|(name, server)| {
                let rules_count = server
                    .policy_layers
                    .iter()
                    .map(|layer| layer.tool_rules.len())
                    .sum::<usize>();
                rules_total += rules_count;
                valid_mcp_server_id(name)
                    && (server.enabled.is_some() || !server.policy_layers.is_empty())
                    && server.policy_layers.len() <= MAX_MCP_POLICY_LAYERS
                    && rules_count <= MAX_MCP_RULES_PER_SERVER
                    && server
                        .policy_layers
                        .windows(2)
                        .all(|layers| layers[0] < layers[1])
                    && server.policy_layers.iter().all(|layer| {
                        (layer.default_policy.is_some() || !layer.tool_rules.is_empty())
                            && layer.default_policy.as_ref().is_none_or(valid_mcp_pair)
                            && valid_mcp_rules(&layer.tool_rules)
                    })
            })
            && rules_total <= MAX_MCP_RULES_TOTAL
    }
}

fn valid_mcp_pair(policy: &McpApprovalPolicy) -> bool {
    policy.session_grant != SessionGrantPolicy::Offer || policy.mode == PolicyMode::Ask
}

fn valid_mcp_rules(rules: &[McpToolRule]) -> bool {
    let mut patterns = BTreeSet::new();
    rules.len() <= MAX_MCP_RULES_PER_SERVER
        && rules.iter().all(|rule| {
            valid_mcp_pattern(&rule.pattern)
                && patterns.insert(&rule.pattern)
                && (rule.session_grant != SessionGrantPolicy::Offer || rule.mode == PolicyMode::Ask)
        })
}

fn valid_mcp_pattern(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            !character.is_control()
                && !character.is_whitespace()
                && !matches!(character, '\u{feff}' | '?' | '[' | ']' | '{' | '}' | '\\')
        })
}

fn valid_mcp_server_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_tool_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    value != "codemode"
        && !value.starts_with("mcp__")
        && !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_models_file(value: &str) -> bool {
    let Some(relative) = value.strip_prefix('/') else {
        return false;
    };
    !relative.is_empty()
        && value.len() <= 4096
        && value.chars().all(|character| !character.is_control())
        && relative
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn valid_annotation(value: Option<&str>, maximum_bytes: usize) -> bool {
    value.is_none_or(|annotation| {
        annotation.len() <= maximum_bytes
            && annotation.chars().all(|character| !character.is_control())
    })
}

fn valid_environment(environment: &IdentityEnvironment) -> bool {
    if environment.extensions.len() > MAX_EXTENSION_ENVIRONMENTS
        || !valid_pi_environment(&environment.pi)
        || !valid_environment_scope(&environment.sandbox, EnvironmentScope::Sandbox)
    {
        return false;
    }

    let mut variable_count = environment.pi.len() + environment.sandbox.len();
    let mut byte_count = environment
        .pi
        .iter()
        .map(|(name, value)| name.len() + value.as_str().len())
        .sum::<usize>()
        + environment_bytes(&environment.sandbox);
    for (extension_id, variables) in environment.extensions.iter() {
        if !valid_extension_id(extension_id)
            || !valid_environment_scope(variables, EnvironmentScope::Extension)
        {
            return false;
        }
        variable_count += variables.len();
        byte_count += environment_bytes(variables);
    }
    variable_count <= MAX_ENVIRONMENT_VARIABLES_TOTAL && byte_count <= MAX_ENVIRONMENT_BYTES_TOTAL
}

#[derive(Clone, Copy)]
enum EnvironmentScope {
    Sandbox,
    Extension,
}

fn valid_pi_environment(variables: &EnvironmentVariables<PiEnvironmentValue>) -> bool {
    variables.len() <= MAX_ENVIRONMENT_VARIABLES_PER_SCOPE
        && variables.iter().all(|(name, value)| {
            valid_environment_name(name)
                && !reserved_environment_name(name)
                && match value {
                    PiEnvironmentValue::Template(value) => {
                        value.len() <= MAX_ENVIRONMENT_VALUE_BYTES
                            && !value.contains('\0')
                            && valid_account_template(value)
                    }
                    PiEnvironmentValue::File(reference) => {
                        reference.file.len() <= MAX_SECRET_PATH_BYTES
                            && valid_models_file(&reference.file)
                    }
                    PiEnvironmentValue::Literal(value) => valid_secret_value(&value.literal),
                }
        })
}

fn valid_environment_scope(variables: &EnvironmentVariables, scope: EnvironmentScope) -> bool {
    variables.len() <= MAX_ENVIRONMENT_VARIABLES_PER_SCOPE
        && variables.iter().all(|(name, value)| {
            valid_environment_name(name)
                && !reserved_environment_name(name)
                && (!matches!(scope, EnvironmentScope::Sandbox)
                    || !fixed_sandbox_environment_name(name))
                && value.len() <= MAX_ENVIRONMENT_VALUE_BYTES
                && !value.contains('\0')
                && valid_account_template(value)
        })
}

// Validate only: the application resolves account/machine values after merging rules.
fn valid_account_template(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = &bytes[offset..];
        if remaining.starts_with(b"{{{{") || remaining.starts_with(b"}}}}") {
            offset += 4;
        } else if remaining.starts_with(b"{{username}}") {
            offset += 12;
        } else if remaining.starts_with(b"{{uid}}") {
            offset += 7;
        } else if remaining.starts_with(b"{{machine_id}}") {
            offset += 14;
        } else if remaining.starts_with(b"{{") || remaining.starts_with(b"}}") {
            return false;
        } else {
            offset += 1;
        }
    }
    true
}

fn environment_bytes(variables: &EnvironmentVariables) -> usize {
    variables
        .iter()
        .map(|(name, value)| name.len() + value.len())
        .sum()
}

fn valid_environment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_ENVIRONMENT_VARIABLE_NAME_BYTES
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn valid_extension_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn reserved_environment_name(value: &str) -> bool {
    value.starts_with("PI_SANDBOX_")
        || matches!(
            value,
            "BASH_ENV"
                | "BUN_OPTIONS"
                | "DYLD_INSERT_LIBRARIES"
                | "DYLD_LIBRARY_PATH"
                | "ENV"
                | "LD_AUDIT"
                | "LD_LIBRARY_PATH"
                | "LD_PRELOAD"
                | "NODE_OPTIONS"
                | "NODE_PATH"
                | "SHELLOPTS"
        )
}

fn fixed_sandbox_environment_name(value: &str) -> bool {
    matches!(
        value,
        "HOME"
            | "USER"
            | "LOGNAME"
            | "SHELL"
            | "PATH"
            | "LANG"
            | "LC_ALL"
            | "TMPDIR"
            | "XDG_CACHE_HOME"
            | "XDG_CONFIG_HOME"
            | "XDG_STATE_HOME"
            | "GIT_CONFIG_GLOBAL"
            | "GIT_TERMINAL_PROMPT"
            | "NO_COLOR"
    )
}

#[cfg(test)]
fn lookup_identity(
    directory: &Path,
    uid: u32,
    owner: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
) -> Result<IdentityRecord<ResolvedMcpOverrides>, LookupError> {
    let records = match read_records(directory, owner, deadline) {
        Err(LookupError::Io) if !directory.exists() => return Ok(IdentityRecord::empty()),
        result => result?,
    };
    resolve_records(records, uid, resolver, deadline)
}

pub(crate) enum Principal<'a> {
    Unix(u32),
    Https(&'a str),
}
pub(crate) struct ResolvedInputs {
    pub overrides: serde_json::Value,
    pub environment: serde_json::Value,
    pub models_file: String,
}

fn source_records(
    listener: &crate::manifest::Listener,
    owner: u32,
    deadline: Instant,
) -> Result<Vec<IdentityRecord>, LookupError> {
    let Some(directory) = &listener.rule_directory else {
        return Ok(Vec::new());
    };
    crate::sources::protected_directory(Path::new(directory), owner)
        .map_err(|_| LookupError::Io)?;
    if listener.transport == "https" {
        let group_path = Path::new(directory).join("groups.d");
        match std::fs::symlink_metadata(&group_path) {
            Ok(_) => {
                crate::sources::protected_directory(&group_path, owner)
                    .map_err(|_| LookupError::Io)?;
                if std::fs::read_dir(group_path)
                    .map_err(LookupError::from_io)?
                    .next()
                    .is_some()
                {
                    return Err(LookupError::InvalidFile);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(LookupError::Io),
        }
    }
    let records = read_records(Path::new(directory), owner, deadline)?;
    if listener.transport == "https"
        && records
            .iter()
            .any(|r| r.user.is_none() || r.uid.is_some() || r.gid.is_some() || r.group.is_some())
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(records)
}
pub(crate) fn validate_sources(
    listener: &crate::manifest::Listener,
    owner: u32,
    deadline: Instant,
) -> crate::protocol::Result<Vec<String>> {
    let records = source_records(listener, owner, deadline).map_err(LookupError::service_error)?;
    Ok(records
        .into_iter()
        .filter_map(|r| r.overrides.models_file)
        .collect())
}
pub(crate) fn resolve_inputs(
    policy: &serde_json::Value,
    listener: &crate::manifest::Listener,
    principal: Principal<'_>,
    owner: u32,
    deadline: Instant,
    resolve_secrets: bool,
) -> crate::protocol::Result<ResolvedInputs> {
    use crate::protocol::CONFIG;
    let records = source_records(listener, owner, deadline).map_err(LookupError::service_error)?;
    let mut joined = match principal {
        Principal::Unix(uid) => join_records(
            records,
            uid,
            &mut HostIdentityResolver::new(deadline.min(Instant::now() + Duration::from_secs(4))),
            deadline,
        )
        .map_err(LookupError::service_error)?,
        Principal::Https(username) => {
            let mut result = IdentityRecord::empty();
            for record in records {
                if record.user.as_deref() == Some(username) {
                    merge_record(&mut result, record).map_err(|_| CONFIG)?;
                }
            }
            normalize_class_policies(&mut result.overrides.tools);
            if result
                .overrides
                .mcp
                .as_ref()
                .is_some_and(|m| !bounded_json(m, MAX_MCP_BYTES))
            {
                return Err(CONFIG);
            }
            result
        }
    };
    let audit_tools = policy["audit"]["tools"].as_object().ok_or(CONFIG)?;
    if joined
        .overrides
        .tools
        .0
        .keys()
        .any(|k| !audit_tools.contains_key(k))
    {
        return Err(CONFIG);
    }
    if let Some(mcp) = &joined.overrides.mcp {
        let servers = policy["mcp"]["servers"].as_object().ok_or(CONFIG)?;
        if mcp.servers.0.keys().any(|k| !servers.contains_key(k)) {
            return Err(CONFIG);
        }
    }
    if let Some(workspace) = &joined.overrides.workspace {
        let modes = policy["workspace"]["modes"].as_object().ok_or(CONFIG)?;
        if workspace
            .allowed
            .iter()
            .flatten()
            .any(|k| !modes.contains_key(k))
            || workspace
                .default
                .as_ref()
                .is_some_and(|k| !modes.contains_key(k))
        {
            return Err(CONFIG);
        }
    }
    if joined
        .overrides
        .execution
        .as_ref()
        .and_then(|e| e.backend.as_ref())
        .is_some_and(|backend| match backend {
            ExecutionBackend::Bubblewrap => listener.platform != "linux",
            ExecutionBackend::Seatbelt => listener.platform != "darwin",
            ExecutionBackend::Direct => false,
        })
    {
        return Err(CONFIG);
    }
    let model = joined
        .overrides
        .models_file
        .take()
        .unwrap_or(policy["models_file"].as_str().ok_or(CONFIG)?.to_owned());
    let mut environment: IdentityEnvironment =
        serde_json::from_value(policy["environment"].clone()).map_err(|_| CONFIG)?;
    environment.pi.0.extend(joined.environment.pi.0);
    environment.sandbox.0.extend(joined.environment.sandbox.0);
    for (name, vars) in joined.environment.extensions.0 {
        environment
            .extensions
            .0
            .entry(name)
            .or_default()
            .0
            .extend(vars.0);
    }
    if !valid_environment(&environment) {
        return Err(CONFIG);
    }
    if resolve_secrets {
        resolve_pi_environment(&mut environment, deadline, &mut read_secret_file)
            .map_err(LookupError::service_error)?;
    }
    // Inspection never serializes unresolved File values or returns environment.
    let environment = if resolve_secrets {
        serde_json::to_value(environment).map_err(|_| CONFIG)?
    } else {
        serde_json::Value::Null
    };
    Ok(ResolvedInputs {
        overrides: serde_json::to_value(joined.overrides).map_err(|_| CONFIG)?,
        environment,
        models_file: model,
    })
}
pub(crate) fn validate_environment(value: &serde_json::Value) -> bool {
    serde_json::from_value::<IdentityEnvironment>(value.clone())
        .is_ok_and(|e| valid_environment(&e))
}
pub(crate) fn validate_tool(value: &serde_json::Value, tool: &str) -> bool {
    let mut value = value.clone();
    if tool == "bash"
        && let Some(map) = value.as_object_mut()
    {
        map.remove("command_sets");
    }
    serde_json::from_value::<SubjectPolicy>(value).is_ok_and(|p| {
        let mut tools = ToolOverrides::default();
        tools.0.insert(tool.into(), p);
        let overrides: IdentityOverrides = IdentityOverrides {
            tools,
            ..Default::default()
        };
        valid_overrides(&overrides) && record_class_policies_exceed_main(&overrides.tools)
    })
}

pub(crate) fn validate_main_mcp_policy(value: &serde_json::Value, rule: bool) -> bool {
    let mut value = value.clone();
    let Some(map) = value.as_object_mut() else {
        return false;
    };
    if !map.remove("audit").is_some_and(|v| v.is_boolean()) {
        return false;
    }
    if rule {
        serde_json::from_value::<McpToolRule>(value).is_ok_and(|r| valid_mcp_rules(&[r]))
    } else {
        serde_json::from_value::<McpApprovalPolicy>(value).is_ok_and(|p| valid_mcp_pair(&p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn parse_user_for_test(bytes: &[u8], uid: u32) -> Result<IdentityRecord, LookupError> {
        let record = parse_record(bytes, RecordKind::User)?;
        if record.uid != Some(uid) {
            return Err(LookupError::InvalidFile);
        }
        Ok(record)
    }

    #[test]
    fn parses_a_strict_per_uid_override() {
        let source = br#"
version = 12
uid = 1000

comment = "development account"

[environment.pi]
MODEL_TOKEN = "token-a"

[environment.sandbox]
PROJECT_MODE = "managed"

[environment.extensions.service-api]
SERVICE_API_TOKEN = "service-token"

[overrides]
models_file = "/etc/pi-sandbox/models/user.json"

[overrides.execution]
backend = "direct"

[overrides.network]
mode = "host"

[overrides.tools.write]
mode = "ask"
session_grant = "offer"
"#;
        let user = parse_user_for_test(source, 1000).expect("valid user override");
        assert_eq!(user.uid, Some(1000));
        assert_eq!(
            user.environment
                .pi
                .get("MODEL_TOKEN")
                .map(PiEnvironmentValue::as_str),
            Some("token-a")
        );
        assert_eq!(
            user.overrides.execution,
            Some(ExecutionOverrides {
                backend: Some(ExecutionBackend::Direct),
            })
        );
        assert_eq!(
            user.overrides.tools.get("write").cloned(),
            Some(SubjectPolicy {
                mode: PolicyMode::Ask,
                session_grant: SessionGrantPolicy::Offer,
                known_read_only: None,
            })
        );
    }

    const MAIN_POLICIES: [(&str, &str); 5] = [
        ("disabled", "never"),
        ("deny", "never"),
        ("ask", "never"),
        ("ask", "offer"),
        ("allow", "never"),
    ];
    const CLASS_POLICIES: [(&str, &str); 4] = [
        ("deny", "never"),
        ("ask", "never"),
        ("ask", "offer"),
        ("allow", "never"),
    ];

    fn bash_rule(main: (&str, &str), class: Option<(&str, &str)>) -> String {
        let mut body = format!(
            "[overrides.tools.bash]\nmode = {:?}\nsession_grant = {:?}\n",
            main.0, main.1
        );
        if let Some((mode, grant)) = class {
            body.push_str(&format!(
                "[overrides.tools.bash.known_read_only]\nmode = {mode:?}\nsession_grant = {grant:?}\n"
            ));
        }
        body
    }

    fn class_policy(mode: &str, grant: &str) -> ClassPolicy {
        toml::from_str(&format!("mode = {mode:?}\nsession_grant = {grant:?}")).unwrap()
    }

    #[test]
    fn parses_known_read_only_only_when_strictly_more_permissive_than_bash() {
        for (main_index, main) in MAIN_POLICIES.iter().enumerate() {
            for (class_index, class) in CLASS_POLICIES.iter().enumerate() {
                // Ranks: class index + 1 aligns with main index (disabled = 0).
                let exceeds = main_index != 0 && class_index + 1 > main_index;
                for (kind, selector) in [
                    (RecordKind::User, "uid = 7"),
                    (RecordKind::Group, "group = \"admin\""),
                ] {
                    let source = format!(
                        "version = 12\n{selector}\n{}",
                        bash_rule(*main, Some(*class))
                    );
                    let parsed = parse_record(source.as_bytes(), kind);
                    if exceeds {
                        assert_eq!(
                            parsed
                                .unwrap()
                                .overrides
                                .tools
                                .get("bash")
                                .unwrap()
                                .known_read_only,
                            Some(class_policy(class.0, class.1)),
                            "main {main:?} class {class:?}"
                        );
                    } else {
                        assert_eq!(
                            parsed,
                            Err(LookupError::InvalidFile),
                            "main {main:?} class {class:?}"
                        );
                    }
                }
            }
        }
        let inline = parse_user_for_test(
            b"version = 12\nuid = 7\n[overrides.tools.bash]\nmode = \"deny\"\nsession_grant = \"never\"\nknown_read_only = { mode = \"allow\", session_grant = \"never\" }\n",
            7,
        )
        .unwrap();
        assert_eq!(
            inline.overrides.tools.get("bash").unwrap().known_read_only,
            Some(class_policy("allow", "never"))
        );
        let without = parse_user_for_test(
            format!(
                "version = 12\nuid = 7\n{}",
                bash_rule(("deny", "never"), None)
            )
            .as_bytes(),
            7,
        )
        .unwrap();
        assert_eq!(
            without.overrides.tools.get("bash").unwrap().known_read_only,
            None
        );
    }

    #[test]
    fn rejects_known_read_only_outside_bash_and_invalid_class_values() {
        let class =
            "[overrides.tools.{tool}.known_read_only]\nmode = \"allow\"\nsession_grant = \"never\"";
        for tool in ["read", "write", "git_clone", "bash_extra"] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.tools.{tool}]\nmode = \"deny\"\nsession_grant = \"never\"\n{}\n",
                class.replace("{tool}", tool)
            );
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile),
                "{tool}"
            );
        }
        for table in [
            "known_read_only",
            "overrides.known_read_only",
            "overrides.tools.bash.known_read_only.nested",
        ] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.tools.bash]\nmode = \"deny\"\nsession_grant = \"never\"\n[{table}]\nmode = \"allow\"\nsession_grant = \"never\"\n"
            );
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile),
                "{table}"
            );
        }
        for fields in [
            "mode = \"disabled\"\nsession_grant = \"never\"",
            "mode = \"Allow\"\nsession_grant = \"never\"",
            "mode = \"allow\"\nsession_grant = \"always\"",
            "mode = \"allow\"\nsession_grant = \"offer\"",
            "mode = \"deny\"\nsession_grant = \"offer\"",
            "mode = \"allow\"",
            "session_grant = \"never\"",
            "",
            "mode = \"allow\"\nsession_grant = \"never\"\naudit = true",
            "mode = \"allow\"\nsession_grant = \"never\"\nversion = 1",
        ] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.tools.bash]\nmode = \"deny\"\nsession_grant = \"never\"\n[overrides.tools.bash.known_read_only]\n{fields}\n"
            );
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile),
                "{fields}"
            );
        }
        for value in ["\"allow\"", "true", "[]"] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.tools.bash]\nmode = \"deny\"\nsession_grant = \"never\"\nknown_read_only = {value}\n"
            );
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile),
                "{value}"
            );
        }
    }

    fn rank(policy: (&str, &str)) -> usize {
        MAIN_POLICIES.iter().position(|p| *p == policy).unwrap()
    }

    #[test]
    fn combines_class_policies_by_join_and_normalizes_against_combined_main() {
        // Every valid per-file bash policy, with and without a class policy.
        let mut rules = Vec::new();
        for main in MAIN_POLICIES {
            rules.push((main, None));
            for class in CLASS_POLICIES {
                if main.0 != "disabled" && rank(class) > rank(main) {
                    rules.push((main, Some(class)));
                }
            }
        }
        for left in &rules {
            for right in &rules {
                let main_rank = rank(left.0).max(rank(right.0));
                let class_rank = [left.1, right.1].into_iter().flatten().map(rank).max();
                let expected_class = class_rank
                    .filter(|class| main_rank != 0 && *class > main_rank)
                    .map(|class| class_policy(MAIN_POLICIES[class].0, MAIN_POLICIES[class].1));
                for (first, second) in [(left, right), (right, left)] {
                    let result = resolve(vec![
                        record("uid = 1000", &bash_rule(first.0, first.1)),
                        record("group = \"admin\"", &bash_rule(second.0, second.1)),
                    ])
                    .unwrap();
                    let bash = result.overrides.tools.get("bash").unwrap();
                    assert_eq!(
                        policy_rank(bash) as usize,
                        main_rank,
                        "{first:?} {second:?}"
                    );
                    assert_eq!(bash.known_read_only, expected_class, "{first:?} {second:?}");
                }
            }
        }
    }

    #[test]
    fn class_join_and_normalization_examples() {
        let bash = |rules: Vec<IdentityRecord>| {
            resolve(rules)
                .unwrap()
                .overrides
                .tools
                .get("bash")
                .cloned()
                .unwrap()
        };
        // Another rule raises the main policy to the class level: the class is dropped.
        let dropped = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("deny", "never"), Some(("ask", "never"))),
            ),
            record("gid = 20", &bash_rule(("ask", "never"), None)),
        ]);
        assert_eq!(
            (dropped.mode, dropped.known_read_only),
            (PolicyMode::Ask, None)
        );
        let dropped = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("deny", "never"), Some(("allow", "never"))),
            ),
            record("gid = 20", &bash_rule(("allow", "never"), None)),
        ]);
        assert_eq!(
            (dropped.mode, dropped.known_read_only),
            (PolicyMode::Allow, None)
        );
        let dropped = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("ask", "never"), Some(("ask", "offer"))),
            ),
            record("gid = 20", &bash_rule(("ask", "offer"), None)),
        ]);
        assert_eq!(
            (dropped.session_grant, dropped.known_read_only),
            (SessionGrantPolicy::Offer, None)
        );
        // Join takes the greater mode and grant, then normalizes the grant.
        let joined = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("deny", "never"), Some(("ask", "offer"))),
            ),
            record(
                "gid = 20",
                &bash_rule(("deny", "never"), Some(("allow", "never"))),
            ),
        ]);
        assert_eq!(joined.known_read_only, Some(class_policy("allow", "never")));
        let joined = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("deny", "never"), Some(("ask", "offer"))),
            ),
            record(
                "gid = 20",
                &bash_rule(("deny", "never"), Some(("ask", "never"))),
            ),
        ]);
        assert_eq!(joined.known_read_only, Some(class_policy("ask", "offer")));
        // The main policy and the class policy may come from different rules.
        let split = bash(vec![
            record(
                "uid = 1000",
                &bash_rule(("deny", "never"), Some(("allow", "never"))),
            ),
            record("gid = 20", &bash_rule(("ask", "offer"), None)),
            record(
                "gid = 10",
                "[overrides.tools.read]\nmode = \"allow\"\nsession_grant = \"never\"",
            ),
        ]);
        assert_eq!(
            (split.mode, split.session_grant, split.known_read_only),
            (
                PolicyMode::Ask,
                SessionGrantPolicy::Offer,
                Some(class_policy("allow", "never"))
            )
        );
        // Unmatched rules do not contribute class policies.
        let unmatched = bash(vec![
            record("uid = 1000", &bash_rule(("deny", "never"), None)),
            record(
                "uid = 999",
                &bash_rule(("deny", "never"), Some(("allow", "never"))),
            ),
        ]);
        assert_eq!(unmatched.known_read_only, None);
        // Normalization also drops a class under a disabled main policy.
        let mut tools = ToolOverrides::default();
        tools.0.insert(
            "bash".into(),
            SubjectPolicy {
                mode: PolicyMode::Disabled,
                session_grant: SessionGrantPolicy::Never,
                known_read_only: Some(class_policy("allow", "never")),
            },
        );
        normalize_class_policies(&mut tools);
        assert_eq!(tools.get("bash").unwrap().known_read_only, None);
    }

    #[test]
    fn serializes_class_policy_only_when_present() {
        let result = resolve(vec![
            record(
                "uid = 1000",
                &bash_rule(("ask", "never"), Some(("allow", "never"))),
            ),
            record(
                "gid = 20",
                "[overrides.tools.read]\nmode = \"allow\"\nsession_grant = \"never\"",
            ),
        ])
        .unwrap();
        assert_eq!(
            serde_json::to_string(&result.overrides).unwrap(),
            "{\"tools\":{\"bash\":{\"mode\":\"ask\",\"session_grant\":\"never\",\"known_read_only\":{\"mode\":\"allow\",\"session_grant\":\"never\"}},\"read\":{\"mode\":\"allow\",\"session_grant\":\"never\"}}}"
        );
        let dropped = resolve(vec![
            record(
                "uid = 1000",
                &bash_rule(("ask", "never"), Some(("allow", "never"))),
            ),
            record("gid = 20", &bash_rule(("allow", "never"), None)),
        ])
        .unwrap();
        assert_eq!(
            serde_json::to_string(&dropped.overrides).unwrap(),
            "{\"tools\":{\"bash\":{\"mode\":\"allow\",\"session_grant\":\"never\"}}}"
        );
    }

    #[test]
    fn rejects_removed_vm_backend_and_fields() {
        for fields in [
            "[overrides.execution]\nbackend = \"smolvm\"",
            "[overrides.smolvm]\nimage = \"/tmp/tools.smolmachine\"",
        ] {
            let value = format!("version = 12\nuid = 7\n{fields}\n");
            assert!(parse_user_for_test(value.as_bytes(), 7).is_err());
        }
    }

    #[test]
    fn parses_complete_filesystem_overrides_and_rejects_invalid_shapes() {
        assert_eq!(
            parse_user_for_test(b"version = 12\nuid = 7\n", 7)
                .unwrap()
                .overrides
                .filesystem,
            None
        );
        for cwd_writable in [true, false] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.filesystem]\ncwd_writable = {cwd_writable}\n"
            );
            let user = parse_user_for_test(source.as_bytes(), 7).unwrap();
            assert_eq!(
                user.overrides.filesystem,
                Some(FilesystemConfig { cwd_writable })
            );
            let wire = serde_json::to_value(&user.overrides).unwrap();
            assert_eq!(wire["filesystem"]["cwd_writable"], cwd_writable);
        }
        for fields in [
            "",
            "cwd_writable = 0",
            "cwd_writable = \"false\"",
            "cwd_writable = true\nextra = true",
            "cwdWritable = true",
        ] {
            let source = format!("version = 12\nuid = 7\n[overrides.filesystem]\n{fields}\n");
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
        assert_eq!(
            parse_user_for_test(b"version = 5\nuid = 7\n", 7),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn joins_network_permissions_and_rejects_removed_execution_fields() {
        for (left_index, left) in ["none", "local", "host"].iter().enumerate() {
            for (right_index, right) in ["none", "local", "host"].iter().enumerate() {
                let result = resolve(vec![
                    record(
                        "uid = 1000",
                        &format!("[overrides.network]\nmode = {left:?}"),
                    ),
                    record(
                        "gid = 20",
                        &format!("[overrides.network]\nmode = {right:?}"),
                    ),
                ])
                .unwrap();
                assert_eq!(
                    serde_json::to_value(result.overrides.network.unwrap()).unwrap()["mode"],
                    ["none", "local", "host"][left_index.max(right_index)]
                );
            }
        }
        for fields in [
            "",
            "process_lifetime = \"command\"",
            "process_lifetime = \"sandbox\"",
            "process_lifetime = \"session\"",
            "process_lifetime = false",
            "max_command_timeout_seconds = 60",
            "backend = \"bubblewrap\"\nmax_command_timeout_seconds = 60",
            "process_lifetime = \"sandbox\"\nextra = true",
        ] {
            assert!(
                parse_user_for_test(
                    format!("version = 12\nuid = 7\n[overrides.execution]\n{fields}\n").as_bytes(),
                    7
                )
                .is_err()
            );
        }
    }

    #[test]
    fn rejects_command_path_overrides_in_user_and_group_rules() {
        for (selector, kind) in [
            ("uid = 7", RecordKind::User),
            ("gid = 7", RecordKind::Group),
        ] {
            for field in ["command_path_prepend", "commandPathPrepend"] {
                let source = format!(
                    "version = 12\n{selector}\n[overrides.execution]\nbackend = \"bubblewrap\"\n{field} = [\"/usr/libexec/pi-sandbox\"]\n"
                );
                assert_eq!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile)
                );
            }
        }
    }

    #[test]
    fn rejects_wrong_uid_version_unknown_fields_and_invalid_policies() {
        let cases: &[&[u8]] = &[
            b"version = 4\nuid = 7\n",
            b"version = 7\nuid = 7\n",
            b"version = 8\nuid = 7\n",
            b"version = 12\nuid = 8\n",
            b"version = 12\nuid = 7\nextra = true\n",
            b"version = 12\nuid = 7\n[overrides.tools.write]\nmode = \"allow\"\nsession_grant = \"offer\"\n",
            b"version = 12\nuid = 7\n[overrides.execution]\nbackend = \"container\"\n",
            b"version = 12\nuid = 7\n[overrides.network]\nmode = \"filtered\"\n",
        ];
        for source in cases {
            assert_eq!(
                parse_user_for_test(source, 7),
                Err(LookupError::InvalidFile)
            );
        }
        for fields in [
            "[overrides.tools.write]\nmode = \"ask\"\nsession_grant = \"never\"\naudit = false",
            "[overrides.audit]\nenabled = false\nfacility = \"local0\"",
            "[audit]\nenabled = false\nfacility = \"local0\"",
        ] {
            let source = format!("version = 12\nuid = 7\n{fields}\n");
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn rejects_skills_in_user_and_group_records() {
        for (kind, selector) in [
            (RecordKind::User, "uid = 7"),
            (RecordKind::Group, "gid = 7"),
        ] {
            for table in ["skills", "overrides.skills"] {
                let source =
                    format!("version = 12\n{selector}\n[{table}]\ndirectories = ['/srv/skills']\n");
                assert!(matches!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile)
                ));
            }
        }
    }

    #[test]
    fn rejects_subagent_admission_overrides_in_user_and_group_records() {
        for selector in ["uid = 1000", "gid = 1000"] {
            for table in ["subagents", "overrides.subagents"] {
                let text = format!(
                    "version = 12\n{selector}\n[{table}]\nenabled = true\nmax_concurrent = 8\nmax_total = 64\n"
                );
                assert!(toml::from_str::<IdentityRecord>(&text).is_err());
            }
        }
    }

    #[test]
    fn carries_one_named_subagent_policy_for_user_and_group_rules() {
        for (kind, selector) in [
            (RecordKind::User, "uid = 7"),
            (RecordKind::Group, "gid = 7"),
        ] {
            let text = format!(
                "version = 12\n{selector}\n[overrides.tools.subagents]\nmode = 'ask'\nsession_grant = 'offer'\n"
            );
            let record = parse_record(text.as_bytes(), kind).unwrap();
            let wire = serde_json::to_value(record.overrides).unwrap();
            assert_eq!(wire["tools"]["subagents"]["mode"], "ask");
            assert_eq!(wire["tools"]["subagents"]["session_grant"], "offer");
            assert_eq!(wire["tools"].as_object().unwrap().len(), 1);
        }
    }

    #[test]
    fn rejects_session_retention_in_user_and_group_records() {
        for (kind, selector) in [
            (RecordKind::User, "uid = 7"),
            (RecordKind::Group, "gid = 7"),
        ] {
            for table in ["sessions", "overrides.sessions"] {
                let source = format!("version = 12\n{selector}\n[{table}]\nretention_days = 0\n");
                assert!(matches!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile)
                ));
            }
        }
    }

    #[test]
    fn validates_account_templates_without_resolving_the_broker_account() {
        for value in [
            "~/{{username}}/{{uid}}",
            "~/{{machine_id}}/{{username}}",
            "{{{{machine_id}}}}",
            "{{{{username}}}}",
            "é/{{uid}}",
            "{literal}",
            "{{uid}}}",
        ] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 7"),
                (RecordKind::Group, "gid = 7"),
            ] {
                for scope in ["pi", "sandbox", "extensions.service"] {
                    let source = format!(
                        "version = 12\n{selector}\n[environment.{scope}]\nACCOUNT = {value:?}\n"
                    );
                    assert!(parse_record(source.as_bytes(), kind).is_ok());
                }
            }
        }
        for value in [
            "{{unknown}}",
            "{{machine_id",
            "{{ machine_id }}",
            "{{machineId}}",
            "{{username",
            "{{ username }}",
            "value}}",
            "{{{username}}}",
        ] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 7"),
                (RecordKind::Group, "gid = 7"),
            ] {
                for scope in ["pi", "sandbox", "extensions.service"] {
                    let source = format!(
                        "version = 12\n{selector}\n[environment.{scope}]\nACCOUNT = {value:?}\n"
                    );
                    assert!(matches!(
                        parse_record(source.as_bytes(), kind),
                        Err(LookupError::InvalidFile)
                    ));
                }
            }
        }
    }

    #[test]
    fn parses_mcp_enablement_without_inventing_omitted_overrides() {
        for enabled in [false, true] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 7"),
                (RecordKind::Group, "group = \"admin\""),
            ] {
                let source = format!(
                    "version = 12\n{selector}\n[overrides.mcp.servers.docs]\nenabled = {enabled}\n"
                );
                let record = parse_record(source.as_bytes(), kind).unwrap();
                assert_eq!(
                    serde_json::to_value(record.overrides).unwrap(),
                    serde_json::json!({ "tools": {}, "mcp": { "servers": { "docs": { "enabled": enabled } } } })
                );
            }
        }
        let absent = record("uid = 1000", "");
        assert!(absent.overrides.mcp.is_none());
        assert_eq!(
            serde_json::to_value(&absent.overrides).unwrap(),
            serde_json::json!({"tools":{}})
        );
    }

    #[test]
    fn rejects_malformed_mcp_overrides_and_fields_outside_approval() {
        for body in [
            "[overrides]\nmcp = false",
            "[overrides.mcp]",
            "[overrides.mcp]\nservers = []",
            "[overrides.mcp]\nservers = {}",
            "[overrides.mcp]\nextra = true\nservers = { docs = { enabled = true } }",
            "[overrides.mcp.servers]",
            "[overrides.mcp.servers]\ndocs = true",
            "[overrides.mcp.servers.docs]",
            "[overrides.mcp.servers.docs]\nenabled = \"true\"",
            "[overrides.mcp.servers.docs]\nenabled = 1",
            "[overrides.mcp.servers.docs]\nenabled = []",
            "[overrides.mcp.servers.docs]\nenabled = {}",
            "[overrides.mcp.servers.docs]\nenabled = true\nurl = \"https://example.com/mcp\"",
            "[overrides.mcp.servers.docs]\nenabled = true\ntransport = \"http\"",
            "[overrides.mcp.servers.docs]\nenabled = true\ncommand = \"/usr/bin/server\"",
            "[overrides.mcp.servers.docs]\nenabled = true\nexposure = \"direct\"",
            "[overrides.mcp.servers.docs]\nenabled = true\nheaders = {}",
            "[overrides.mcp.servers.docs]\nenabled = true\ndefault_policy = { mode = \"allow\", session_grant = \"never\", audit = false }",
            "[overrides.mcp.servers.docs]\nenabled = true\ntool_rules = []",
            "[overrides.mcp.servers.docs]\nenabled = true\nenabled = false",
            "[overrides.mcp.servers]\ndocs = { enabled = true }\ndocs = { enabled = false }",
            "[overrides.codemode]\nenabled = true",
            "[overrides.tools.codemode]\nmode = \"allow\"\nsession_grant = \"never\"",
            "[overrides.tools.mcp__docs__search]\nmode = \"allow\"\nsession_grant = \"never\"",
        ] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 7"),
                (RecordKind::Group, "gid = 7"),
            ] {
                let source = format!("version = 12\n{selector}\n{body}\n");
                assert_eq!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile),
                    "{body}"
                );
            }
        }
        assert!(
            serde_json::from_str::<McpServerOverrides>(
                r#"{"docs":{"enabled":true},"docs":{"enabled":false}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn bounds_mcp_identifiers_and_server_counts_per_file_and_after_merge() {
        for name in [
            "".to_owned(),
            "Docs".into(),
            "docs-server".into(),
            "1docs".into(),
            "é".into(),
            "a".repeat(33),
        ] {
            let source = format!(
                "version = 12\nuid = 7\n[overrides.mcp.servers.{name:?}]\nenabled = true\n"
            );
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile),
                "{name}"
            );
        }
        for name in ["a".to_owned(), "docs_2".into(), "a".repeat(32)] {
            let source =
                format!("version = 12\nuid = 7\n[overrides.mcp.servers.{name}]\nenabled = true\n");
            assert!(parse_user_for_test(source.as_bytes(), 7).is_ok());
        }
        let body = (0..MAX_MCP_SERVER_OVERRIDES)
            .map(|i| format!("[overrides.mcp.servers.server_{i}]\nenabled = false\n"))
            .collect::<String>();
        let source = format!("version = 12\nuid = 7\n{body}");
        assert!(parse_user_for_test(source.as_bytes(), 7).is_ok());
        let extra = "[overrides.mcp.servers.extra]\nenabled = true\n";
        assert_eq!(
            parse_user_for_test(format!("{source}{extra}").as_bytes(), 7),
            Err(LookupError::InvalidFile)
        );
        assert_eq!(
            resolve(vec![record("uid = 1000", &body), record("gid = 20", extra)]),
            Err(LookupError::InvalidFile)
        );
        let duplicate =
            resolve(vec![record("uid = 1000", &body), record("gid = 20", &body)]).unwrap();
        assert_eq!(duplicate.overrides.mcp.unwrap().servers.0.len(), 32);
    }

    #[test]
    fn mcp_enablement_joins_matching_user_and_group_rules_independently_of_order() {
        for user_enabled in [false, true] {
            for group_enabled in [false, true] {
                for reverse in [false, true] {
                    let mut records = vec![
                        record(
                            "user = \"alice\"",
                            &format!("[overrides.mcp.servers.docs]\nenabled = {user_enabled}\n"),
                        ),
                        record(
                            "group = \"admin\"",
                            &format!("[overrides.mcp.servers.docs]\nenabled = {group_enabled}\n"),
                        ),
                        record(
                            "gid = 10",
                            "[overrides.mcp.servers.local]\nenabled = false\n",
                        ),
                        record(
                            "uid = 999",
                            "[overrides.mcp.servers.docs]\nenabled = true\n[overrides.mcp.servers.unmatched]\nenabled = true\n",
                        ),
                        record("uid = 1000", ""),
                    ];
                    if reverse {
                        records.reverse();
                    }
                    let result = resolve(records).unwrap();
                    assert_eq!(
                        serde_json::to_value(result.overrides).unwrap(),
                        serde_json::json!({ "tools": {}, "mcp": { "servers": {
                            "docs": { "enabled": user_enabled || group_enabled },
                            "local": { "enabled": false }
                        } } })
                    );
                }
            }
        }
        let no_match = resolve(vec![record(
            "uid = 999",
            "[overrides.mcp.servers.docs]\nenabled = true\n",
        )])
        .unwrap();
        assert!(no_match.overrides.mcp.is_none());
    }

    fn mcp_rule_body(server: &str, count: usize, prefix: &str) -> String {
        let mut body = format!("[overrides.mcp.servers.{server}]\n");
        for index in 0..count {
            body.push_str(&format!(
                "[[overrides.mcp.servers.{server}.tool_rules]]\nmatch = \"{prefix}{index:04}*\"\nmode = \"ask\"\nsession_grant = \"offer\"\n"
            ));
        }
        body
    }

    #[test]
    fn accepts_complete_mcp_approval_pairs_without_implicit_enablement() {
        for (mode, grant) in [
            ("disabled", "never"),
            ("deny", "never"),
            ("ask", "never"),
            ("ask", "offer"),
            ("allow", "never"),
        ] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 1000"),
                (RecordKind::Group, "gid = 20"),
            ] {
                for fields in [
                    format!("default_policy = {{ mode = {mode:?}, session_grant = {grant:?} }}"),
                    format!(
                        "tool_rules = [{{ match = \"search_*\", mode = {mode:?}, session_grant = {grant:?} }}]"
                    ),
                ] {
                    let source = format!(
                        "version = 12\n{selector}\n[overrides.mcp.servers.docs]\n{fields}\n"
                    );
                    let authored = parse_record(source.as_bytes(), kind).unwrap();
                    let resolved = resolve(vec![authored]).unwrap();
                    let server = &resolved.overrides.mcp.as_ref().unwrap().servers.0["docs"];
                    assert_eq!(server.enabled, None);
                    assert_eq!(server.policy_layers.len(), 1);
                    let wire = serde_json::to_value(&resolved.overrides).unwrap();
                    assert!(wire["mcp"]["servers"]["docs"].get("enabled").is_none());
                    assert!(
                        wire["mcp"]["servers"]["docs"]["policy_layers"][0]["tool_rules"].is_array()
                    );
                }
            }
        }
    }

    #[test]
    fn rejects_partial_mcp_pairs_private_fields_and_authored_wire_shapes() {
        for fields in [
            "default_policy = {}",
            "default_policy = { mode = \"ask\" }",
            "default_policy = { session_grant = \"never\" }",
            "default_policy = { mode = \"allow\", session_grant = \"offer\" }",
            "default_policy = { mode = \"deny\", session_grant = \"offer\" }",
            "default_policy = { mode = \"disabled\", session_grant = \"offer\" }",
            "default_policy = { mode = \"ask\", session_grant = \"always\" }",
            "default_policy = { mode = \"ask\", session_grant = \"never\", audit = true }",
            "default_policy = { mode = \"ask\", session_grant = \"never\", known_read_only = { mode = \"allow\", session_grant = \"never\" } }",
            "policy_layers = [{ tool_rules = [], default_policy = { mode = \"ask\", session_grant = \"never\" } }]",
            "tool_rules = []",
            "tool_rules = {}",
            "tool_rules = [{ match = \"search_*\", mode = \"ask\" }]",
            "tool_rules = [{ match = \"search_*\", session_grant = \"never\" }]",
            "tool_rules = [{ mode = \"ask\", session_grant = \"never\" }]",
            "tool_rules = [{ match = \"search_*\", mode = \"deny\", session_grant = \"offer\" }]",
            "tool_rules = [{ match = \"search_*\", mode = \"ask\", session_grant = \"never\", audit = false }]",
            "tool_rules = [{ match = \"search_*\", mode = \"ask\", session_grant = \"never\", known_read_only = {} }]",
            "tool_rules = [{ match = \"search_*\", mode = \"ask\", session_grant = \"never\", filename = \"private.toml\" }]",
            "tool_rules = [{ match = \"same\", mode = \"ask\", session_grant = \"never\" }, { match = \"same\", mode = \"allow\", session_grant = \"never\" }]",
            "enabled = false\ntool_rules = []",
            "enabled = true\nbearer_token_from_env = \"SECRET\"",
            "enabled = true\ntimeout_ms = 1000",
        ] {
            for (kind, selector) in [
                (RecordKind::User, "uid = 1000"),
                (RecordKind::Group, "gid = 20"),
            ] {
                let source =
                    format!("version = 12\n{selector}\n[overrides.mcp.servers.docs]\n{fields}\n");
                assert_eq!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile),
                    "{fields}"
                );
            }
        }
        assert_eq!(
            parse_record(b"version = 9\nuid = 1000\n", RecordKind::User),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn mcp_patterns_match_the_main_policy_unicode_and_literal_grammar() {
        for pattern in [
            "search_*",
            "*",
            "a**b",
            "é*",
            "literal.+()^$|",
            "a\"b",
            "\u{200b}",
        ] {
            assert!(valid_mcp_pattern(pattern), "{pattern:?}");
        }
        for pattern in [
            "", "?", "a[b", "a]b", "{a", "a}", "a\\b", "a b", "a\tb", "a\nb", "\0", "\u{7f}",
            "\u{85}", "\u{a0}", "\u{1680}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}",
            "\u{3000}", "\u{feff}",
        ] {
            assert!(!valid_mcp_pattern(pattern), "{pattern:?}");
        }
        assert!(valid_mcp_pattern(&"a".repeat(128)));
        assert!(!valid_mcp_pattern(&"a".repeat(129)));
        assert!(valid_mcp_pattern(&"é".repeat(64)));
        assert!(!valid_mcp_pattern(&"é".repeat(65)));
        for character in ['\u{feff}', '?', '[', ']', '{', '}', '\\'] {
            let source = format!(
                "version = 12\nuid = 1000\n[overrides.mcp.servers.docs]\ntool_rules = [{{ match = '{}', mode = 'allow', session_grant = 'never' }}]",
                character
            );
            assert_eq!(
                parse_record(source.as_bytes(), RecordKind::User),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn mcp_layers_are_order_independent_but_keep_each_files_order_and_default() {
        let broad = "[overrides.mcp.servers.docs]\ndefault_policy = { mode = 'allow', session_grant = 'never' }\ntool_rules = [{ match = 'secret_*', mode = 'deny', session_grant = 'never' }, { match = '*', mode = 'ask', session_grant = 'offer' }]";
        let fallback = "[overrides.mcp.servers.docs]\ndefault_policy = { mode = 'ask', session_grant = 'never' }";
        let only_rules = "[overrides.mcp.servers.docs]\ntool_rules = [{ match = 'search_*', mode = 'allow', session_grant = 'never' }]";
        let layers = [broad, fallback, only_rules];
        let mut expected = None;
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let mut records = order
                .into_iter()
                .map(|index| record("gid = 20", layers[index]))
                .collect::<Vec<_>>();
            records.push(record("uid = 1000", broad)); // exact duplicate from another selector
            records.push(record(
                "uid = 1000",
                "[overrides.mcp.servers.docs]\nenabled = false",
            ));
            records.push(record(
                "uid = 999",
                "[overrides.mcp.servers.docs]\nenabled = true",
            ));
            let resolved = resolve(records).unwrap();
            let server = &resolved.overrides.mcp.as_ref().unwrap().servers.0["docs"];
            assert_eq!(server.enabled, Some(false));
            assert_eq!(server.policy_layers.len(), 3);
            let original = server
                .policy_layers
                .iter()
                .find(|layer| layer.tool_rules.len() == 2)
                .unwrap();
            assert_eq!(original.tool_rules[0].pattern, "secret_*");
            assert_eq!(original.tool_rules[1].pattern, "*");
            assert_eq!(
                original.default_policy.as_ref().unwrap().mode,
                PolicyMode::Allow
            );
            let encoded = serde_json::to_string(&resolved.overrides).unwrap();
            for private in ["uid", "gid", "user", "group", "comment", "filename", "path"] {
                assert!(!encoded.contains(&format!("\"{private}\"")));
            }
            if let Some(expected) = &expected {
                assert_eq!(&encoded, expected);
            } else {
                expected = Some(encoded);
            }
        }
        // Reordering one file is semantically significant, so it must not deduplicate.
        let reordered = broad.replace("{ match = 'secret_*', mode = 'deny', session_grant = 'never' }, { match = '*', mode = 'ask', session_grant = 'offer' }", "{ match = '*', mode = 'ask', session_grant = 'offer' }, { match = 'secret_*', mode = 'deny', session_grant = 'never' }");
        let resolved = resolve(vec![
            record("uid = 1000", broad),
            record("gid = 20", &reordered),
        ])
        .unwrap();
        assert_eq!(
            resolved.overrides.mcp.unwrap().servers.0["docs"]
                .policy_layers
                .len(),
            2
        );
    }

    #[test]
    fn mcp_limits_apply_per_file_and_after_whole_layer_deduplication() {
        let full = mcp_rule_body("docs", MAX_MCP_RULES_PER_SERVER, "rule");
        let source = format!(
            "version = 12\nuid = 1000\n{}",
            mcp_rule_body("docs", MAX_MCP_RULES_PER_SERVER + 1, "rule")
        );
        assert_eq!(
            parse_record(source.as_bytes(), RecordKind::User),
            Err(LookupError::InvalidFile)
        );
        let deduplicated =
            resolve(vec![record("uid = 1000", &full), record("gid = 20", &full)]).unwrap();
        assert_eq!(
            deduplicated.overrides.mcp.unwrap().servers.0["docs"]
                .policy_layers
                .len(),
            1
        );
        assert_eq!(
            resolve(vec![
                record("uid = 1000", &full),
                record("gid = 20", &mcp_rule_body("docs", 1, "extra"))
            ]),
            Err(LookupError::InvalidFile)
        );
        let records = (0..MAX_MCP_RULES_PER_SERVER)
            .map(|index| {
                record(
                    "uid = 1000",
                    &mcp_rule_body("docs", 1, &format!("r{index}_")),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            resolve(records).unwrap().overrides.mcp.unwrap().servers.0["docs"]
                .policy_layers
                .len(),
            MAX_MCP_POLICY_LAYERS
        );
        let all = (0..4)
            .map(|index| mcp_rule_body(&format!("server{index}"), MAX_MCP_RULES_PER_SERVER, "rule"))
            .collect::<String>();
        assert!(resolve(vec![record("uid = 1000", &all)]).is_ok());
        let extra = mcp_rule_body("extra", 1, "rule");
        assert_eq!(
            resolve(vec![record("uid = 1000", &all), record("gid = 20", &extra)]),
            Err(LookupError::InvalidFile)
        );
        let source = format!("version = 12\nuid = 1000\n{all}{extra}");
        assert_eq!(
            parse_record(source.as_bytes(), RecordKind::User),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn mcp_json_budget_counts_escaping_instead_of_source_character_count() {
        let mut servers = BTreeMap::new();
        for server in 0..4 {
            let rules = (0..256)
                .map(|index| McpToolRule {
                    pattern: format!("{index:04}{}", "\"".repeat(124)),
                    mode: PolicyMode::Ask,
                    session_grant: SessionGrantPolicy::Never,
                })
                .collect::<Vec<_>>();
            assert!(valid_mcp_rules(&rules));
            servers.insert(
                format!("server{server}"),
                McpServerOverride {
                    enabled: None,
                    default_policy: None,
                    tool_rules: Some(rules),
                },
            );
        }
        let authored = McpOverrides {
            servers: McpServerOverrides(servers),
        };
        assert!(serde_json::to_vec(&authored).unwrap().len() > MAX_MCP_BYTES);
        assert!(!authored.valid());
        let two_servers = authored.servers.0.into_iter().take(2).collect();
        let authored = McpOverrides {
            servers: McpServerOverrides(two_servers),
        };
        assert!(authored.valid());
        let bytes = serde_json::to_vec(&authored).unwrap();
        assert!(bounded_json(&authored, bytes.len()));
        assert!(!bounded_json(&authored, bytes.len() - 1));
    }

    #[test]
    fn final_mcp_byte_budget_does_not_make_boolean_join_order_dependent() {
        let records = |mut quotes: usize| {
            (0..4).map(|server| {
                let mut source = format!("version = 12\nuid = 1000\n[overrides.mcp.servers.server{server}]\n");
                if server == 0 {
                    source.push_str("enabled = false\n");
                }
                for index in 0..256 {
                    let count = quotes.min(123);
                    quotes -= count;
                    let pattern = serde_json::to_string(&format!("r{index:04}{}{}", "\"".repeat(count), "a".repeat(123-count))).unwrap();
                    source.push_str(&format!("[[overrides.mcp.servers.server{server}.tool_rules]]\nmatch = {pattern}\nmode = 'ask'\nsession_grant = 'never'\n"));
                }
                parse_record(source.as_bytes(), RecordKind::User).unwrap()
            }).collect::<Vec<_>>()
        };
        let baseline = resolve(records(0)).unwrap();
        let size = serde_json::to_vec(baseline.overrides.mcp.as_ref().unwrap())
            .unwrap()
            .len();
        let quote_count = MAX_MCP_BYTES + 1 - size;
        assert_eq!(resolve(records(quote_count)), Err(LookupError::InvalidFile));
        let mut expected = None;
        for first in [false, true] {
            let mut inputs = records(quote_count);
            let enabled = record(
                "gid = 20",
                "[overrides.mcp.servers.server0]\nenabled = true",
            );
            inputs.insert(if first { 0 } else { inputs.len() }, enabled);
            let result = resolve(inputs).unwrap();
            let encoded = serde_json::to_vec(result.overrides.mcp.as_ref().unwrap()).unwrap();
            assert_eq!(encoded.len(), MAX_MCP_BYTES);
            if let Some(expected) = &expected {
                assert_eq!(&encoded, expected);
            } else {
                expected = Some(encoded);
            }
        }
    }

    #[test]
    fn rejects_invalid_and_oversized_environment_values() {
        let cases: &[&[u8]] = &[
            b"version = 12\nuid = 7\n[environment.pi]\nBad-Name = \"x\"\n",
            b"version = 12\nuid = 7\n[environment.pi]\nPI_SANDBOX_SECRET = \"x\"\n",
            b"version = 12\nuid = 7\n[environment.pi]\nLD_PRELOAD = \"x\"\n",
            b"version = 12\nuid = 7\n[environment.sandbox]\nHOME = \"/tmp\"\n",
            b"version = 12\nuid = 7\n[environment.extensions.Bad_ID]\nTOKEN = \"x\"\n",
        ];
        for source in cases {
            assert_eq!(
                parse_user_for_test(source, 7),
                Err(LookupError::InvalidFile)
            );
        }

        let mut too_many = String::from("version = 12\nuid = 7\n[environment.pi]\n");
        for index in 0..=MAX_ENVIRONMENT_VARIABLES_PER_SCOPE {
            too_many.push_str(&format!("VARIABLE_{index} = \"x\"\n"));
        }
        assert_eq!(
            parse_user_for_test(too_many.as_bytes(), 7),
            Err(LookupError::InvalidFile)
        );

        let oversized_name = format!(
            "version = 12\nuid = 7\n[environment.pi]\n{} = \"x\"\n",
            format_args!("A{}", "A".repeat(MAX_ENVIRONMENT_VARIABLE_NAME_BYTES))
        );
        let oversized_value = format!(
            "version = 12\nuid = 7\n[environment.pi]\nTOKEN = \"{}\"\n",
            "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1)
        );
        let mut too_many_extensions = String::from("version = 12\nuid = 7\n");
        for index in 0..=MAX_EXTENSION_ENVIRONMENTS {
            too_many_extensions.push_str(&format!(
                "[environment.extensions.extension-{index}]\nTOKEN = \"x\"\n"
            ));
        }
        for source in [oversized_name, oversized_value, too_many_extensions] {
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn rejects_invalid_model_override_paths() {
        for path in [
            "relative.json",
            "/etc/pi-sandbox/../models.json",
            "/etc/pi-sandbox//models.json",
            "/etc/pi-sandbox/models.json/",
        ] {
            let source = format!("version = 12\nuid = 7\n[overrides]\nmodels_file = {path:?}\n");
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[derive(Default)]
    struct FakeResolver {
        calls: usize,
        missing: bool,
    }
    impl IdentityResolver for FakeResolver {
        fn account(&mut self, uid: u32) -> io::Result<Option<Account>> {
            self.calls += 1;
            Ok(if self.missing {
                None
            } else {
                Some(Account {
                    uid,
                    user: "alice".into(),
                    gid: 10,
                })
            })
        }
        fn groups(&mut self, _: &Account) -> io::Result<BTreeSet<u32>> {
            self.calls += 1;
            Ok(BTreeSet::from([10, 20]))
        }
        fn group(&mut self, name: &str) -> io::Result<Option<u32>> {
            self.calls += 1;
            Ok(match name {
                "staff" => Some(10),
                "admin" => Some(20),
                _ => None,
            })
        }
    }
    fn record(selector: &str, body: &str) -> IdentityRecord {
        let kind = if selector.starts_with("user") || selector.starts_with("uid") {
            RecordKind::User
        } else {
            RecordKind::Group
        };
        parse_record(format!("version = 12\n{selector}\n{body}").as_bytes(), kind).unwrap()
    }

    #[test]
    fn workspace_records_reject_duplicate_grants_and_non_selection_fields() {
        for (selector, kind) in [
            ("uid = 999", RecordKind::User),
            ("gid = 999", RecordKind::Group),
        ] {
            for body in [
                "[overrides.workspace]",
                "[overrides.workspace]\nallowed = ['host', 'host']",
                "[overrides.workspace]\nallowed = 'host'",
                "[overrides.workspace]\nallowed = [1]",
                "[overrides.workspace]\ndefault = ''",
                "[overrides.workspace]\ndefault = 'Host'",
                "[overrides.workspace]\nallowed = ['a b']",
                "[overrides.workspace]\nallowed = ['_host']",
                "[overrides.workspace]\nallowed = ['hóst']",
                "[overrides.workspace]\nallowed = []\ndescription = 'not allowed'",
                "[overrides.workspace.modes.host]",
            ] {
                let source = format!("version = 12\n{selector}\n{body}");
                assert_eq!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile)
                );
            }
            for body in [
                "[overrides.workspace]\nallowed = []",
                "[overrides.workspace]\ndefault = 'sandbox'",
                "[overrides.workspace]\nallowed = ['sandbox', 'host', 'constructor', 'custom-name_1']\ndefault = 'host'",
            ] {
                let source = format!("version = 12\n{selector}\n{body}");
                assert!(parse_record(source.as_bytes(), kind).is_ok());
            }
            let body = format!("[overrides.workspace]\ndefault = '{}'", "a".repeat(33));
            let source = format!("version = 12\n{selector}\n{body}");
            assert_eq!(
                parse_record(source.as_bytes(), kind),
                Err(LookupError::InvalidFile)
            );
        }
        assert_eq!(
            parse_record(b"version = 10\nuid = 1000", RecordKind::User),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn workspace_union_keeps_explicit_empty_and_omitted_distinct() {
        for reverse in [false, true] {
            let mut records = vec![
                record(
                    "uid = 1000",
                    "[overrides.workspace]\nallowed = ['sandbox', 'host']\ndefault = 'sandbox'",
                ),
                record(
                    "group = 'admin'",
                    "[overrides.workspace]\nallowed = ['host', 'custom']\ndefault = 'sandbox'",
                ),
                record("gid = 10", "[overrides.workspace]\nallowed = []"),
                record(
                    "uid = 999",
                    "[overrides.workspace]\nallowed = ['unmatched']\ndefault = 'unmatched'",
                ),
            ];
            if reverse {
                records.reverse();
            }
            let result = resolve(records).unwrap();
            assert_eq!(
                serde_json::to_value(result.overrides).unwrap(),
                serde_json::json!({
                        "tools": {},
                    "workspace": { "allowed": ["custom", "host", "sandbox"], "default": "sandbox" }
                })
            );
        }
        assert!(
            resolve(vec![record(
                "uid = 999",
                "[overrides.workspace]\nallowed = ['host']"
            )])
            .unwrap()
            .overrides
            .workspace
            .is_none()
        );
        for (body, expected) in [
            ("allowed = []", serde_json::json!({"allowed":[]})),
            ("default = 'host'", serde_json::json!({"default":"host"})),
        ] {
            let result = resolve(vec![record(
                "uid = 1000",
                &format!("[overrides.workspace]\n{body}"),
            )])
            .unwrap();
            assert_eq!(
                serde_json::to_value(result.overrides.workspace).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn workspace_defaults_must_agree_and_union_has_a_combined_bound() {
        assert_eq!(
            resolve(vec![
                record("gid = 10", "[overrides.workspace]\ndefault = 'host'"),
                record(
                    "group = 'admin'",
                    "[overrides.workspace]\ndefault = 'sandbox'"
                ),
            ]),
            Err(LookupError::InvalidFile)
        );
        let names = |count: usize| {
            (0..count)
                .map(|index| format!("'mode{index:02}'"))
                .collect::<Vec<_>>()
                .join(",")
        };
        let at_limit = format!(
            "[overrides.workspace]\nallowed = [{}]",
            names(MAX_WORKSPACE_MODES)
        );
        assert!(
            resolve(vec![
                record("uid = 1000", &at_limit),
                record("gid = 20", &at_limit)
            ])
            .is_ok()
        );
        assert_eq!(
            resolve(vec![
                record("uid = 1000", &at_limit),
                record("gid = 20", "[overrides.workspace]\nallowed = ['extra']")
            ]),
            Err(LookupError::InvalidFile)
        );
        let over_limit = format!(
            "version = 12\nuid = 999\n[overrides.workspace]\nallowed = [{}]",
            names(MAX_WORKSPACE_MODES + 1)
        );
        assert_eq!(
            parse_record(over_limit.as_bytes(), RecordKind::User),
            Err(LookupError::InvalidFile)
        );
    }

    fn resolve(
        records: Vec<IdentityRecord>,
    ) -> Result<IdentityRecord<ResolvedMcpOverrides>, LookupError> {
        resolve_records(
            records,
            1000,
            &mut FakeResolver::default(),
            Instant::now() + Duration::from_secs(1),
        )
    }
    #[test]
    fn selectors_are_explicit_strict_and_independent_of_file_names() {
        for selector in [
            "",
            "uid = 1\nuser = \"alice\"",
            "username = \"alice\"",
            "user = \"123\"",
            "user = \" alice\"",
            "gid = 1",
            "uid = -1",
        ] {
            assert_eq!(
                parse_record(
                    format!("version = 12\n{selector}").as_bytes(),
                    RecordKind::User
                ),
                Err(LookupError::InvalidFile)
            );
        }
        assert!(parse_record(b"version = 12\ngroup = \"admin\"", RecordKind::Group).is_ok());
        assert!(parse_record(b"version = 12\ngid = 20", RecordKind::Group).is_ok());
    }
    #[test]
    fn matches_user_and_primary_and_supplementary_groups_additively() {
        let records = vec![
            record(
                "group = \"staff\"",
                "[overrides.tools.bash]\nmode = \"disabled\"\nsession_grant = \"never\"",
            ),
            record(
                "group = \"admin\"",
                "[overrides.tools.bash]\nmode = \"ask\"\nsession_grant = \"offer\"",
            ),
            record(
                "user = \"alice\"",
                "[overrides.tools.read]\nmode = \"allow\"\nsession_grant = \"never\"",
            ),
            record(
                "uid = 999",
                "[overrides.tools.bash]\nmode = \"allow\"\nsession_grant = \"never\"",
            ),
            record("gid = 10", "[overrides.filesystem]\ncwd_writable = false"),
            record("gid = 20", "[overrides.filesystem]\ncwd_writable = true"),
        ];
        let result = resolve(records).unwrap();
        assert_eq!(policy_rank(result.overrides.tools.get("bash").unwrap()), 3);
        assert_eq!(policy_rank(result.overrides.tools.get("read").unwrap()), 4);
        assert!(result.overrides.filesystem.unwrap().cwd_writable);
        assert!(result.overrides.network.is_none());
    }
    #[test]
    fn policy_join_is_commutative_for_all_valid_atomic_combinations() {
        let policies = [
            ("disabled", "never"),
            ("deny", "never"),
            ("ask", "never"),
            ("ask", "offer"),
            ("allow", "never"),
        ];
        for (i, (mode, grant)) in policies.iter().enumerate() {
            for (j, (other_mode, other_grant)) in policies.iter().enumerate() {
                let a = record(
                    "uid = 1000",
                    &format!("[overrides.tools.bash]\nmode = {mode:?}\nsession_grant = {grant:?}"),
                );
                let b = record(
                    "user = \"alice\"",
                    &format!(
                        "[overrides.tools.bash]\nmode = {other_mode:?}\nsession_grant = {other_grant:?}"
                    ),
                );
                assert_eq!(
                    policy_rank(
                        resolve(vec![a, b])
                            .unwrap()
                            .overrides
                            .tools
                            .get("bash")
                            .unwrap()
                    ),
                    i.max(j) as u8
                );
            }
        }
    }
    #[test]
    fn conflicting_values_fail_while_equal_and_separate_scopes_combine() {
        for (a, b) in [
            (
                "[overrides.execution]\nbackend = \"direct\"",
                "[overrides.execution]\nbackend = \"bubblewrap\"",
            ),
            (
                "[overrides]\nmodels_file = \"/a.json\"",
                "[overrides]\nmodels_file = \"/b.json\"",
            ),
            (
                "[environment.pi]\nTOKEN = \"a\"",
                "[environment.pi]\nTOKEN = \"b\"",
            ),
        ] {
            assert_eq!(
                resolve(vec![
                    record("uid = 1000", a),
                    record("group = \"admin\"", b)
                ]),
                Err(LookupError::InvalidFile)
            );
        }
        let result = resolve(vec![
            record("uid = 1000", "[environment.pi]\nTOKEN = \"a\""),
            record(
                "gid = 20",
                "[environment.pi]\nTOKEN = \"a\"\n[environment.sandbox]\nTOKEN = \"b\"",
            ),
        ])
        .unwrap();
        assert_eq!(result.environment.pi.get("TOKEN").unwrap().as_str(), "a");
        assert_eq!(result.environment.sandbox.get("TOKEN").unwrap(), "b");
        for (a, b) in [("none", "host"), ("host", "none")] {
            let result = resolve(vec![
                record("uid = 1000", &format!("[overrides.network]\nmode = {a:?}")),
                record("gid = 20", &format!("[overrides.network]\nmode = {b:?}")),
            ])
            .unwrap();
            assert_eq!(result.overrides.network.unwrap().mode, NetworkMode::Host);
        }
    }
    #[test]
    fn resolution_fails_closed_and_numeric_only_does_not_need_accounts() {
        let mut fake = FakeResolver {
            missing: true,
            calls: 0,
        };
        assert!(
            resolve_records(
                vec![record("uid = 1000", "")],
                1000,
                &mut fake,
                Instant::now() + Duration::from_secs(1)
            )
            .is_ok()
        );
        assert_eq!(fake.calls, 0);
        assert_eq!(
            resolve_records(
                vec![record("gid = 10", "")],
                1000,
                &mut fake,
                Instant::now() + Duration::from_secs(1)
            ),
            Err(LookupError::Io)
        );
        assert_eq!(
            resolve(vec![record("group = \"missing\"", "")]),
            Err(LookupError::Io)
        );
        assert_eq!(
            resolve_records(vec![], 1000, &mut fake, Instant::now()),
            Err(LookupError::TimedOut)
        );
    }
    #[test]
    fn combined_environment_limits_apply_across_files() {
        let mut a = String::from("[environment.pi]\n");
        let mut b = a.clone();
        for i in 0..80 {
            a.push_str(&format!("A{i} = \"x\"\n"));
            b.push_str(&format!("B{i} = \"x\"\n"));
        }
        assert_eq!(
            resolve(vec![record("uid = 1000", &a), record("gid = 20", &b)]),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn secret_references_are_strict_pi_only_authored_inputs() {
        let parsed = record(
            "uid = 1000",
            "[environment.pi]\nTOKEN = { file = '/secrets/token' }",
        );
        assert!(matches!(
            parsed.environment.pi.get("TOKEN"),
            Some(PiEnvironmentValue::File(_))
        ));
        assert!(serde_json::to_vec(&parsed.environment).is_err());
        for value in [
            "{ literal = 'secret' }",
            "{ file = '/secrets/token', extra = true }",
            "{ file = '/secrets/token', literal = 'secret' }",
            "{ file = 42 }",
            "{}",
            "{ file = 'relative/token' }",
            "{ file = '/' }",
            "{ file = '/secrets//token' }",
            "{ file = '/secrets/./token' }",
            "{ file = '/secrets/../token' }",
            "{ file = '/secrets/token/' }",
            "{ file = \"/secrets/\\n\" }",
        ] {
            let source = format!("version = 12\nuid = 999\n[environment.pi]\nTOKEN = {value}");
            assert_eq!(
                parse_record(source.as_bytes(), RecordKind::User),
                Err(LookupError::InvalidFile)
            );
        }
        for scope in ["sandbox", "extensions.service-api"] {
            let source = format!(
                "version = 12\nuid = 1000\n[environment.{scope}]\nTOKEN = {{ file = '/secrets/token' }}"
            );
            assert_eq!(
                parse_record(source.as_bytes(), RecordKind::User),
                Err(LookupError::InvalidFile)
            );
        }
        let oversized = format!(
            "version = 12\nuid = 1000\n[environment.pi]\nTOKEN = {{ file = '/{}' }}",
            "x".repeat(MAX_SECRET_PATH_BYTES)
        );
        assert_eq!(
            parse_record(oversized.as_bytes(), RecordKind::User),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn secret_reads_follow_selection_and_complete_authored_conflict_checks() {
        let mut calls = 0;
        let mut reader = |_: &str, _: Instant| {
            calls += 1;
            Ok("secret".to_owned())
        };
        let mut run = |records| {
            resolve_records_with_reader(
                records,
                1000,
                &mut FakeResolver::default(),
                Instant::now() + Duration::from_secs(1),
                &mut reader,
            )
        };
        let unmatched = record(
            "uid = 999",
            "[environment.pi]\nTOKEN = { file = '/missing' }",
        );
        assert!(run(vec![unmatched]).unwrap().environment.pi.0.is_empty());
        for other in ["{ file = '/other' }", "'secret'"] {
            assert_eq!(
                run(vec![
                    record(
                        "uid = 1000",
                        "[environment.pi]\nTOKEN = { file = '/missing' }"
                    ),
                    record("gid = 20", &format!("[environment.pi]\nTOKEN = {other}")),
                ]),
                Err(LookupError::InvalidFile)
            );
        }
        assert_eq!(
            run(vec![
                record(
                    "uid = 1000",
                    "[environment.pi]\nTOKEN = { file = '/missing' }\n[overrides.execution]\nbackend = 'direct'"
                ),
                record("gid = 20", "[overrides.execution]\nbackend = 'bubblewrap'"),
            ]),
            Err(LookupError::InvalidFile)
        );
        assert_eq!(calls, 0);
    }

    #[test]
    fn matching_user_and_group_secrets_share_one_snapshot_per_request() {
        let mut calls = 0;
        let mut reader = |path: &str, _: Instant| {
            assert_eq!(path, "/secrets/token");
            calls += 1;
            Ok(format!("value-{calls}"))
        };
        for expected in ["value-1", "value-2"] {
            let result = resolve_records_with_reader(
                vec![
                    record(
                        "uid = 1000",
                        "[environment.pi]\nFIRST = { file = '/secrets/token' }",
                    ),
                    record(
                        "gid = 20",
                        "[environment.pi]\nSECOND = { file = '/secrets/token' }",
                    ),
                    record(
                        "user = 'alice'",
                        "[environment.pi]\nFIRST = { file = '/secrets/token' }",
                    ),
                    record(
                        "uid = 999",
                        "[environment.pi]\nOTHER = { file = '/missing' }",
                    ),
                ],
                1000,
                &mut FakeResolver::default(),
                Instant::now() + Duration::from_secs(1),
                &mut reader,
            )
            .unwrap();
            assert_eq!(result.environment.pi.len(), 2);
            for name in ["FIRST", "SECOND"] {
                assert_eq!(result.environment.pi.get(name).unwrap().as_str(), expected);
            }
        }
        assert_eq!(calls, 2);
    }

    #[test]
    fn secret_reader_preserves_bytes_except_one_line_ending_and_enforces_bounds() {
        use std::fs;
        let root = temporary_path();
        fs::create_dir(&root).unwrap();
        let path = root.join("token");
        let read = || {
            read_secret_file(
                path.to_str().unwrap(),
                Instant::now() + Duration::from_secs(1),
            )
        };
        for (bytes, expected) in [
            ("token", "token"),
            ("token\n", "token"),
            ("token\r\n", "token"),
            ("token\n\n", "token\n"),
            ("token\r", "token\r"),
            (" \t \n", " \t "),
            ("\u{feff}{{username}}\n", "\u{feff}{{username}}"),
        ] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(read().unwrap(), expected);
        }
        for bytes in [
            vec![],
            b"\n".to_vec(),
            b"\r\n".to_vec(),
            b"x\0y".to_vec(),
            vec![0xff],
            vec![b'x'; MAX_SECRET_FILE_BYTES + 1],
            vec![b'x'; MAX_ENVIRONMENT_VALUE_BYTES + 1],
        ] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(read(), Err(LookupError::InvalidFile));
        }
        let exact = "\u{e9}".repeat(MAX_ENVIRONMENT_VALUE_BYTES / 2);
        fs::write(&path, format!("{exact}\r\n")).unwrap();
        assert_eq!(read().unwrap(), exact);
        fs::write(&path, format!("{exact}x\n")).unwrap();
        assert_eq!(read(), Err(LookupError::InvalidFile));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn secret_reader_uses_ordinary_permissions_symlinks_and_literal_paths() {
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = temporary_path();
        fs::create_dir(&root).unwrap();
        let path = root.join("{{uid}}~");
        fs::write(&path, "initial\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let link = root.join("link");
        symlink(&path, &link).unwrap();
        let direct = record(
            "uid = 1000",
            &format!(
                "[environment.pi]\nTOKEN = {{ file = {:?} }}",
                path.to_str().unwrap()
            ),
        );
        assert_eq!(
            resolve(vec![direct])
                .unwrap()
                .environment
                .pi
                .get("TOKEN")
                .unwrap()
                .as_str(),
            "initial"
        );
        let records = || {
            vec![record(
                "uid = 1000",
                &format!(
                    "[environment.pi]\nTOKEN = {{ file = {:?} }}",
                    link.to_str().unwrap()
                ),
            )]
        };
        assert_eq!(
            resolve(records())
                .unwrap()
                .environment
                .pi
                .get("TOKEN")
                .unwrap()
                .as_str(),
            "initial"
        );
        fs::write(&path, "rotated\n").unwrap();
        assert_eq!(
            resolve(records())
                .unwrap()
                .environment
                .pi
                .get("TOKEN")
                .unwrap()
                .as_str(),
            "rotated"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(resolve(records()), Err(LookupError::Io));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn secret_reader_rejects_nonregular_files_without_waiting_for_a_fifo_writer() {
        use std::fs;
        use std::os::unix::ffi::OsStrExt;
        let root = temporary_path();
        fs::create_dir(&root).unwrap();
        let fifo = root.join("fifo");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let before = Instant::now();
        for path in [fifo.as_path(), root.as_path(), Path::new("/dev/null")] {
            assert_eq!(
                read_secret_file(path.to_str().unwrap(), before + Duration::from_secs(1)),
                Err(LookupError::InvalidFile)
            );
        }
        assert!(before.elapsed() < Duration::from_secs(1));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolved_secret_aggregate_limits_and_deadlines_fail_closed() {
        let body = (0..8)
            .map(|index| format!("TOKEN{index} = {{ file = '/secrets/token' }}\n"))
            .collect::<String>();
        let mut calls = 0;
        let result = resolve_records_with_reader(
            vec![record("uid = 1000", &format!("[environment.pi]\n{body}"))],
            1000,
            &mut FakeResolver::default(),
            Instant::now() + Duration::from_secs(1),
            &mut |_, _| {
                calls += 1;
                Ok("x".repeat(MAX_ENVIRONMENT_VALUE_BYTES))
            },
        );
        assert_eq!(calls, 1);
        assert_eq!(result, Err(LookupError::InvalidFile));
        assert_eq!(
            resolve_records_with_reader(
                vec![record(
                    "uid = 1000",
                    "[environment.pi]\nTOKEN = { file = '/secrets/token' }"
                )],
                1000,
                &mut FakeResolver::default(),
                Instant::now(),
                &mut |_, _| panic!("expired lookup read a file")
            ),
            Err(LookupError::TimedOut)
        );
        assert_eq!(
            read_secret_file("/never-open", Instant::now()),
            Err(LookupError::TimedOut)
        );
    }

    #[test]
    fn directory_scan_validates_all_files_and_rejects_symlinks_and_exposure() {
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = temporary_path();
        let users = root.join("users.d");
        fs::create_dir_all(&users).unwrap();
        let file = users.join("arbitrary-label.toml");
        fs::write(
            &file,
            "version = 12\nuid = 1000\n[overrides.network]\nmode = \"host\"",
        )
        .unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let lookup = || {
            lookup_identity(
                &root,
                1000,
                unsafe { libc::geteuid() },
                &mut FakeResolver::default(),
                Instant::now() + Duration::from_secs(1),
            )
        };
        assert_eq!(
            lookup().unwrap().overrides.network.unwrap().mode,
            NetworkMode::Host
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let link = users.join("link.toml");
        symlink(&file, &link).unwrap();
        assert_eq!(lookup(), Err(LookupError::Io));
        fs::remove_file(&link).unwrap();
        fs::write(&file, "version = 12\nuid = 999\nunknown = true").unwrap();
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::write(
            &file,
            "version = 12\nuid = 999\n[overrides.mcp.servers.docs]\nenabled = \"false\"",
        )
        .unwrap();
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::write(
            &file,
            "version = 12\nuid = 999\n[overrides.mcp.servers.docs]\ndefault_policy = { mode = 'allow', session_grant = 'offer' }",
        )
        .unwrap();
        assert!(lookup().is_err());
        fs::write(
            &file,
            "version = 12\nuid = 999\n[overrides.mcp.servers.unknown_to_base]\nenabled = false",
        )
        .unwrap();
        assert!(lookup().unwrap().overrides.mcp.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn store_limits_file_types_and_directory_ownership_are_enforced() {
        use std::fs;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = temporary_path();
        let groups = root.join("groups.d");
        fs::create_dir_all(&groups).unwrap();
        let lookup = || {
            lookup_identity(
                &root,
                1000,
                unsafe { libc::geteuid() },
                &mut FakeResolver::default(),
                Instant::now() + Duration::from_secs(2),
            )
        };
        let path = groups.join("test.toml");
        let fifo = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::remove_file(&path).unwrap();
        fs::set_permissions(&groups, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::set_permissions(&groups, fs::Permissions::from_mode(0o755)).unwrap();
        for i in 0..=MAX_OVERRIDE_FILES {
            let file = groups.join(format!("{i}.toml"));
            fs::write(&file, "version = 12\ngid = 20").unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::remove_dir_all(&groups).unwrap();
        fs::create_dir(&groups).unwrap();
        for i in 0..5 {
            let file = groups.join(format!("{i}.toml"));
            fs::write(
                &file,
                format!(
                    "version = 12\ngid = 20\n#{}",
                    "x".repeat(MAX_OVERRIDE_FILE_BYTES as usize - 30)
                ),
            )
            .unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
        fs::remove_dir_all(&groups).unwrap();
        let target = root.join("elsewhere");
        fs::create_dir(&target).unwrap();
        symlink(&target, &groups).unwrap();
        assert_eq!(lookup(), Err(LookupError::Io));
        fs::remove_dir_all(root).unwrap();
    }

    fn temporary_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!("pi-sandbox-users-{}-{nonce}", std::process::id()))
    }
}
