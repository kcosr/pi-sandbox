use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::RawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

#[path = "../../native/host_identity.rs"]
mod host_identity;
use host_identity::{Account, HostIdentityResolver};

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

const PROTOCOL_VERSION: u32 = 6;
const OVERRIDE_VERSION: u32 = 7;
const MAX_OVERRIDE_FILES: usize = 256;
const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 1024;
const MAX_OVERRIDE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOOL_OVERRIDES: usize = 256;
const MAX_ENVIRONMENT_VARIABLE_NAME_BYTES: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8192;
const MAX_ENVIRONMENT_VARIABLES_PER_SCOPE: usize = 128;
const MAX_EXTENSION_ENVIRONMENTS: usize = 64;
const MAX_ENVIRONMENT_VARIABLES_TOTAL: usize = 256;
const MAX_ENVIRONMENT_BYTES_TOTAL: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrokerRequest {
    version: u32,
    operation: BrokerOperation,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BrokerOperation {
    ResolveIdentity,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<'a> {
    version: u32,
    status: &'static str,
    environment: &'a IdentityEnvironment,
    overrides: &'a IdentityOverrides,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    version: u32,
    status: &'static str,
    code: &'static str,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IdentityRecord {
    version: u32,
    uid: Option<u32>,
    user: Option<String>,
    gid: Option<u32>,
    group: Option<String>,
    #[serde(default)]
    environment: IdentityEnvironment,
    comment: Option<String>,
    #[serde(default)]
    overrides: IdentityOverrides,
}

#[derive(Clone, Copy)]
enum RecordKind {
    User,
    Group,
}

impl IdentityRecord {
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
    pi: EnvironmentVariables,
    #[serde(default)]
    sandbox: EnvironmentVariables,
    #[serde(default)]
    extensions: ExtensionEnvironments,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct EnvironmentVariables(BTreeMap<String, String>);

impl EnvironmentVariables {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.0.iter()
    }

    #[cfg(test)]
    fn get(&self, name: &str) -> Option<&String> {
        self.0.get(name)
    }
}

impl<'de> Deserialize<'de> for EnvironmentVariables {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct EnvironmentVariablesVisitor;

        impl<'de> Visitor<'de> for EnvironmentVariablesVisitor {
            type Value = EnvironmentVariables;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of unique environment variables")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((name, value)) = map.next_entry::<String, String>()? {
                    if values.insert(name.clone(), value).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate environment variable: {name}"
                        )));
                    }
                }
                Ok(EnvironmentVariables(values))
            }
        }

        deserializer.deserialize_map(EnvironmentVariablesVisitor)
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
struct IdentityOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution: Option<ExecutionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    network: Option<NetworkConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    filesystem: Option<FilesystemConfig>,
    #[serde(default, skip_serializing_if = "ToolOverrides::is_empty")]
    tools: ToolOverrides,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ExecutionConfig {
    backend: ExecutionBackend,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ExecutionBackend {
    Bubblewrap,
    Direct,
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

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NetworkMode {
    None,
    Host,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct ToolOverrides(BTreeMap<String, SubjectPolicy>);

impl ToolOverrides {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

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
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PolicyMode {
    Allow,
    Ask,
    Deny,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionGrantPolicy {
    Never,
    Offer,
}

#[derive(Debug, PartialEq, Eq)]
enum LookupError {
    InvalidFile,
    Io,
}

fn main() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("pi-sandbox-identity-broker: must run as root");
        std::process::exit(1);
    }
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let Some(override_directory) = arguments.next() else {
        eprintln!("pi-sandbox-identity-broker: configuration directory is required");
        std::process::exit(2);
    };
    if arguments.next().is_some() {
        eprintln!("pi-sandbox-identity-broker: too many arguments");
        std::process::exit(2);
    }

    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    if let Err(error) = serve_one(
        Path::new(&override_directory),
        &mut input,
        &mut output,
        0,
        0,
    ) {
        eprintln!("pi-sandbox-identity-broker: {error}");
        std::process::exit(1);
    }
}

fn serve_one(
    override_directory: &Path,
    input: &mut impl Read,
    output: &mut impl Write,
    socket_fd: RawFd,
    required_owner: u32,
) -> io::Result<()> {
    configure_timeout(socket_fd, libc::SO_RCVTIMEO, IO_TIMEOUT)?;
    configure_timeout(socket_fd, libc::SO_SNDTIMEO, IO_TIMEOUT)?;
    let peer_uid = peer_uid(socket_fd)?;

    let request = match read_request(input) {
        Ok(request) => request,
        Err(()) => return write_error(output, "protocol_error"),
    };
    if request.version != PROTOCOL_VERSION {
        return write_error(output, "protocol_error");
    }
    match request.operation {
        BrokerOperation::ResolveIdentity => {}
    }

    let deadline = Instant::now() + Duration::from_secs(4);
    let mut resolver = HostIdentityResolver::new(deadline);
    match lookup_identity(
        override_directory,
        peer_uid,
        required_owner,
        &mut resolver,
        deadline,
    ) {
        Ok(user) => write_json_line(
            output,
            &SuccessResponse {
                version: PROTOCOL_VERSION,
                status: "ok",
                environment: &user.environment,
                overrides: &user.overrides,
            },
        ),
        Err(LookupError::InvalidFile | LookupError::Io) => {
            write_error(output, "identity_store_unavailable")
        }
    }
}

fn read_request(reader: &mut impl Read) -> Result<BrokerRequest, ()> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        if reader.read(&mut byte).map_err(|_| ())? == 0 {
            return Err(());
        }
        if byte[0] == b'\n' {
            break;
        }
        if bytes.len() == MAX_REQUEST_BYTES {
            return Err(());
        }
        bytes.push(byte[0]);
    }
    if bytes.is_empty() {
        return Err(());
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn write_error(writer: &mut impl Write, code: &'static str) -> io::Result<()> {
    write_json_line(
        writer,
        &ErrorResponse {
            version: PROTOCOL_VERSION,
            status: "error",
            code,
        },
    )
}

fn write_json_line(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn peer_uid(fd: RawFd) -> io::Result<u32> {
    let mut credentials: libc::ucred = unsafe { zeroed() };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != size_of::<libc::ucred>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "kernel returned invalid peer credentials",
        ));
    }
    Ok(credentials.uid)
}

fn configure_timeout(fd: RawFd, option: libc::c_int, timeout: Duration) -> io::Result<()> {
    let value = libc::timeval {
        tv_sec: timeout.as_secs() as libc::time_t,
        tv_usec: timeout.subsec_micros() as libc::suseconds_t,
    };
    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            (&value as *const libc::timeval).cast(),
            size_of::<libc::timeval>() as libc::socklen_t,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
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

fn lookup_identity(
    directory: &Path,
    uid: u32,
    owner: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
) -> Result<IdentityRecord, LookupError> {
    use std::os::fd::AsRawFd;
    let config_dir = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(directory)
    {
        Ok(dir) => dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(IdentityRecord::empty()),
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
        for entry in std::fs::read_dir(&stable_path).map_err(|_| LookupError::Io)? {
            if Instant::now() >= deadline {
                return Err(LookupError::Io);
            }
            let entry = entry.map_err(|_| LookupError::Io)?;
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
                .map_err(|_| LookupError::Io)?;
            validate_override_file_metadata(&file, owner)?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_OVERRIDE_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| LookupError::Io)?;
            bytes_total += bytes.len();
            if bytes.len() as u64 > MAX_OVERRIDE_FILE_BYTES || bytes_total > MAX_STORE_BYTES {
                return Err(LookupError::InvalidFile);
            }
            records.push(parse_record(&bytes, kind)?);
        }
    }
    resolve_records(records, uid, resolver, deadline)
}

fn resolve_records(
    records: Vec<IdentityRecord>,
    uid: u32,
    resolver: &mut impl IdentityResolver,
    deadline: Instant,
) -> Result<IdentityRecord, LookupError> {
    let needs_account = records
        .iter()
        .any(|r| r.user.is_some() || r.group.is_some() || r.gid.is_some());
    let account = if needs_account {
        Some(
            resolver
                .account(uid)
                .map_err(|_| LookupError::Io)?
                .ok_or(LookupError::Io)?,
        )
    } else {
        None
    };
    let needs_groups = records.iter().any(|r| r.group.is_some() || r.gid.is_some());
    let groups = if needs_groups {
        resolver
            .groups(account.as_ref().ok_or(LookupError::Io)?)
            .map_err(|_| LookupError::Io)?
    } else {
        BTreeSet::new()
    };
    let mut result = IdentityRecord::empty();
    let mut group_ids = BTreeMap::new();
    for record in records {
        if Instant::now() >= deadline {
            return Err(LookupError::Io);
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
                        .map_err(|_| LookupError::Io)?
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
        return Err(LookupError::Io);
    }
    Ok(result)
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
fn merge_environment(
    target: &mut EnvironmentVariables,
    incoming: EnvironmentVariables,
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
fn merge_record(target: &mut IdentityRecord, incoming: IdentityRecord) -> Result<(), LookupError> {
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
    merge_equal(&mut old.models_file, new.models_file)?;
    merge_equal(&mut old.execution, new.execution)?;
    if let Some(network) = new
        .network
        .filter(|network| old.network.is_none() || matches!(network.mode, NetworkMode::Host))
    {
        old.network = Some(network);
    }
    if let Some(filesystem) = new
        .filesystem
        .filter(|filesystem| old.filesystem.is_none() || filesystem.cwd_writable)
    {
        old.filesystem = Some(filesystem);
    }
    for (name, policy) in new.tools.0 {
        if old
            .tools
            .0
            .get(&name)
            .is_none_or(|existing| policy_rank(&policy) > policy_rank(existing))
        {
            old.tools.0.insert(name, policy);
        }
    }
    if !valid_environment(&target.environment) || !valid_overrides(old) {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

fn validate_directory_metadata(directory: &File, required_owner: u32) -> Result<(), LookupError> {
    let metadata = directory.metadata().map_err(|_| LookupError::Io)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != required_owner
        || metadata.mode() & 0o022 != 0
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(())
}

fn validate_override_file_metadata(file: &File, required_owner: u32) -> Result<(), LookupError> {
    let metadata = file.metadata().map_err(|_| LookupError::Io)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != required_owner
        || metadata.mode() & 0o077 != 0
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
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(record)
}

fn valid_overrides(overrides: &IdentityOverrides) -> bool {
    overrides
        .models_file
        .as_deref()
        .is_none_or(valid_models_file)
        && overrides.tools.len() <= MAX_TOOL_OVERRIDES
        && overrides.tools.iter().all(|(name, policy)| {
            valid_tool_name(name)
                && (!matches!(policy.session_grant, SessionGrantPolicy::Offer)
                    || matches!(policy.mode, PolicyMode::Ask))
        })
}

fn valid_tool_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
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
        || !valid_environment_scope(&environment.pi, EnvironmentScope::Pi)
        || !valid_environment_scope(&environment.sandbox, EnvironmentScope::Sandbox)
    {
        return false;
    }

    let mut variable_count = environment.pi.len() + environment.sandbox.len();
    let mut byte_count =
        environment_bytes(&environment.pi) + environment_bytes(&environment.sandbox);
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
    Pi,
    Sandbox,
    Extension,
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
        })
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
mod tests {
    use super::*;
    use std::net::Shutdown;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
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
version = 7
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
            user.environment.pi.get("MODEL_TOKEN").map(String::as_str),
            Some("token-a")
        );
        assert_eq!(
            user.overrides.execution,
            Some(ExecutionConfig {
                backend: ExecutionBackend::Direct,
            })
        );
        assert_eq!(
            user.overrides.tools.get("write").cloned(),
            Some(SubjectPolicy {
                mode: PolicyMode::Ask,
                session_grant: SessionGrantPolicy::Offer,
            })
        );
    }

    #[test]
    fn parses_complete_filesystem_overrides_and_rejects_invalid_shapes() {
        assert_eq!(
            parse_user_for_test(b"version = 7\nuid = 7\n", 7)
                .unwrap()
                .overrides
                .filesystem,
            None
        );
        for cwd_writable in [true, false] {
            let source = format!(
                "version = 7\nuid = 7\n[overrides.filesystem]\ncwd_writable = {cwd_writable}\n"
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
            let source = format!("version = 7\nuid = 7\n[overrides.filesystem]\n{fields}\n");
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
    fn rejects_wrong_uid_version_unknown_fields_and_invalid_policies() {
        let cases: &[&[u8]] = &[
            b"version = 4\nuid = 7\n",
            b"version = 7\nuid = 8\n",
            b"version = 7\nuid = 7\nextra = true\n",
            b"version = 7\nuid = 7\n[overrides.tools.write]\nmode = \"allow\"\nsession_grant = \"offer\"\n",
            b"version = 7\nuid = 7\n[overrides.execution]\nbackend = \"container\"\n",
            b"version = 7\nuid = 7\n[overrides.network]\nmode = \"filtered\"\n",
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
            let source = format!("version = 7\nuid = 7\n{fields}\n");
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn rejects_session_retention_in_user_and_group_records() {
        for (kind, selector) in [
            (RecordKind::User, "uid = 7"),
            (RecordKind::Group, "gid = 7"),
        ] {
            for table in ["sessions", "overrides.sessions"] {
                let source = format!("version = 7\n{selector}\n[{table}]\nretention_days = 0\n");
                assert!(matches!(
                    parse_record(source.as_bytes(), kind),
                    Err(LookupError::InvalidFile)
                ));
            }
        }
    }

    #[test]
    fn rejects_invalid_and_oversized_environment_values() {
        let cases: &[&[u8]] = &[
            b"version = 7\nuid = 7\n[environment.pi]\nBad-Name = \"x\"\n",
            b"version = 7\nuid = 7\n[environment.pi]\nPI_SANDBOX_SECRET = \"x\"\n",
            b"version = 7\nuid = 7\n[environment.pi]\nLD_PRELOAD = \"x\"\n",
            b"version = 7\nuid = 7\n[environment.sandbox]\nHOME = \"/tmp\"\n",
            b"version = 7\nuid = 7\n[environment.extensions.Bad_ID]\nTOKEN = \"x\"\n",
        ];
        for source in cases {
            assert_eq!(
                parse_user_for_test(source, 7),
                Err(LookupError::InvalidFile)
            );
        }

        let mut too_many = String::from("version = 7\nuid = 7\n[environment.pi]\n");
        for index in 0..=MAX_ENVIRONMENT_VARIABLES_PER_SCOPE {
            too_many.push_str(&format!("VARIABLE_{index} = \"x\"\n"));
        }
        assert_eq!(
            parse_user_for_test(too_many.as_bytes(), 7),
            Err(LookupError::InvalidFile)
        );

        let oversized_name = format!(
            "version = 7\nuid = 7\n[environment.pi]\n{} = \"x\"\n",
            format!("A{}", "A".repeat(MAX_ENVIRONMENT_VARIABLE_NAME_BYTES))
        );
        let oversized_value = format!(
            "version = 7\nuid = 7\n[environment.pi]\nTOKEN = \"{}\"\n",
            "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1)
        );
        let mut too_many_extensions = String::from("version = 7\nuid = 7\n");
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
            let source = format!("version = 7\nuid = 7\n[overrides]\nmodels_file = {path:?}\n");
            assert_eq!(
                parse_user_for_test(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn serves_empty_success_without_a_matching_override() {
        let directory = temporary_path();
        let (mut client, mut server_input) = UnixStream::pair().expect("socket pair");
        let mut server_output = server_input.try_clone().expect("clone server socket");
        client
            .write_all(b"{\"version\":6,\"operation\":\"resolve-identity\"}\n")
            .expect("write request");
        let server_fd = server_input.as_raw_fd();
        serve_one(
            &directory,
            &mut server_input,
            &mut server_output,
            server_fd,
            unsafe { libc::geteuid() },
        )
        .expect("serve request");
        server_output
            .shutdown(Shutdown::Write)
            .expect("finish response");
        let mut response = String::new();
        client.read_to_string(&mut response).expect("read response");
        assert_eq!(
            response,
            "{\"version\":6,\"status\":\"ok\",\"environment\":{\"pi\":{},\"sandbox\":{},\"extensions\":{}},\"overrides\":{}}\n"
        );
    }

    #[test]
    fn requires_a_bounded_newline_delimited_request() {
        let request = b"{\"version\":6,\"operation\":\"resolve-identity\"}";
        assert!(read_request(&mut io::Cursor::new(request)).is_err());
        let mut oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        oversized.push(b'\n');
        assert!(read_request(&mut io::Cursor::new(oversized)).is_err());
    }

    #[test]
    fn reads_peer_uid_from_kernel_socket_credentials() {
        let (left, _right) = UnixStream::pair().expect("socket pair");
        assert_eq!(peer_uid(left.as_raw_fd()).expect("peer uid"), unsafe {
            libc::geteuid()
        });
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
        parse_record(format!("version = 7\n{selector}\n{body}").as_bytes(), kind).unwrap()
    }
    fn resolve(records: Vec<IdentityRecord>) -> Result<IdentityRecord, LookupError> {
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
                    format!("version = 7\n{selector}").as_bytes(),
                    RecordKind::User
                ),
                Err(LookupError::InvalidFile)
            );
        }
        assert!(parse_record(b"version = 7\ngroup = \"admin\"", RecordKind::Group).is_ok());
        assert!(parse_record(b"version = 7\ngid = 20", RecordKind::Group).is_ok());
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
        assert_eq!(result.environment.pi.get("TOKEN").unwrap(), "a");
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
            Err(LookupError::Io)
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
    fn directory_scan_validates_all_files_and_rejects_symlinks_and_exposure() {
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = temporary_path();
        let users = root.join("users.d");
        fs::create_dir_all(&users).unwrap();
        let file = users.join("arbitrary-label.toml");
        fs::write(
            &file,
            "version = 7\nuid = 1000\n[overrides.network]\nmode = \"host\"",
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
        fs::write(&file, "version = 7\nuid = 999\nunknown = true").unwrap();
        assert_eq!(lookup(), Err(LookupError::InvalidFile));
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
            fs::write(&file, "version = 7\ngid = 20").unwrap();
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
                    "version = 7\ngid = 20\n#{}",
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
