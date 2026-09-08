use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::RawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::Duration;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

const PROTOCOL_VERSION: u32 = 5;
const USER_OVERRIDE_VERSION: u32 = 6;
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
    GetUser,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<'a> {
    version: u32,
    status: &'static str,
    environment: &'a UserEnvironment,
    overrides: &'a UserOverrides,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    version: u32,
    status: &'static str,
    code: &'static str,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct UserRecord {
    version: u32,
    uid: u32,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    environment: UserEnvironment,
    #[serde(default)]
    comment: Option<String>,
    #[serde(default)]
    overrides: UserOverrides,
}

impl UserRecord {
    fn empty(uid: u32) -> Self {
        Self {
            version: USER_OVERRIDE_VERSION,
            uid,
            username: None,
            environment: UserEnvironment::default(),
            comment: None,
            overrides: UserOverrides::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct UserEnvironment {
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
struct UserOverrides {
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
        eprintln!("pi-sandbox-identity-broker: user override directory is required");
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
        BrokerOperation::GetUser => {}
    }

    match lookup_user(override_directory, peer_uid, required_owner) {
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
            write_error(output, "user_store_unavailable")
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

fn lookup_user(directory: &Path, uid: u32, required_owner: u32) -> Result<UserRecord, LookupError> {
    let mut directory_options = OpenOptions::new();
    directory_options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY);
    let directory_file = match directory_options.open(directory) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(UserRecord::empty(uid)),
        Err(_) => return Err(LookupError::Io),
    };
    validate_directory_metadata(&directory_file, required_owner)?;

    let path = directory.join(format!("{uid}.toml"));
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(UserRecord::empty(uid)),
        Err(_) => return Err(LookupError::Io),
    };
    validate_override_file_metadata(&file, required_owner)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_OVERRIDE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LookupError::Io)?;
    if bytes.len() as u64 > MAX_OVERRIDE_FILE_BYTES {
        return Err(LookupError::InvalidFile);
    }
    lookup_user_bytes(&bytes, uid)
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

fn lookup_user_bytes(bytes: &[u8], uid: u32) -> Result<UserRecord, LookupError> {
    let source = std::str::from_utf8(bytes).map_err(|_| LookupError::InvalidFile)?;
    let user: UserRecord = toml::from_str(source).map_err(|_| LookupError::InvalidFile)?;
    if user.version != USER_OVERRIDE_VERSION
        || user.uid != uid
        || !valid_environment(&user.environment)
        || !valid_annotation(user.username.as_deref(), 256)
        || !valid_annotation(user.comment.as_deref(), 1024)
        || !valid_overrides(&user.overrides)
    {
        return Err(LookupError::InvalidFile);
    }
    Ok(user)
}

fn valid_overrides(overrides: &UserOverrides) -> bool {
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

fn valid_environment(environment: &UserEnvironment) -> bool {
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
    use std::ffi::CString;
    use std::fs;
    use std::net::Shutdown;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_a_strict_per_uid_override() {
        let source = br#"
version = 6
uid = 1000
username = "alice"
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
        let user = lookup_user_bytes(source, 1000).expect("valid user override");
        assert_eq!(user.username.as_deref(), Some("alice"));
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
            lookup_user_bytes(b"version = 6\nuid = 7\n", 7)
                .unwrap()
                .overrides
                .filesystem,
            None
        );
        for cwd_writable in [true, false] {
            let source = format!(
                "version = 6\nuid = 7\n[overrides.filesystem]\ncwd_writable = {cwd_writable}\n"
            );
            let user = lookup_user_bytes(source.as_bytes(), 7).unwrap();
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
            let source = format!("version = 6\nuid = 7\n[overrides.filesystem]\n{fields}\n");
            assert_eq!(
                lookup_user_bytes(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
        assert_eq!(
            lookup_user_bytes(b"version = 5\nuid = 7\n", 7),
            Err(LookupError::InvalidFile)
        );
    }

    #[test]
    fn rejects_wrong_uid_version_unknown_fields_and_invalid_policies() {
        let cases: &[&[u8]] = &[
            b"version = 4\nuid = 7\n",
            b"version = 6\nuid = 8\n",
            b"version = 6\nuid = 7\nextra = true\n",
            b"version = 6\nuid = 7\n[overrides.tools.write]\nmode = \"allow\"\nsession_grant = \"offer\"\n",
            b"version = 6\nuid = 7\n[overrides.execution]\nbackend = \"container\"\n",
            b"version = 6\nuid = 7\n[overrides.network]\nmode = \"filtered\"\n",
        ];
        for source in cases {
            assert_eq!(lookup_user_bytes(source, 7), Err(LookupError::InvalidFile));
        }
        for fields in [
            "[overrides.tools.write]\nmode = \"ask\"\nsession_grant = \"never\"\naudit = false",
            "[overrides.audit]\nenabled = false\nfacility = \"local0\"",
            "[audit]\nenabled = false\nfacility = \"local0\"",
        ] {
            let source = format!("version = 6\nuid = 7\n{fields}\n");
            assert_eq!(
                lookup_user_bytes(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn rejects_invalid_and_oversized_environment_values() {
        let cases: &[&[u8]] = &[
            b"version = 6\nuid = 7\n[environment.pi]\nBad-Name = \"x\"\n",
            b"version = 6\nuid = 7\n[environment.pi]\nPI_SANDBOX_SECRET = \"x\"\n",
            b"version = 6\nuid = 7\n[environment.pi]\nLD_PRELOAD = \"x\"\n",
            b"version = 6\nuid = 7\n[environment.sandbox]\nHOME = \"/tmp\"\n",
            b"version = 6\nuid = 7\n[environment.extensions.Bad_ID]\nTOKEN = \"x\"\n",
        ];
        for source in cases {
            assert_eq!(lookup_user_bytes(source, 7), Err(LookupError::InvalidFile));
        }

        let mut too_many = String::from("version = 6\nuid = 7\n[environment.pi]\n");
        for index in 0..=MAX_ENVIRONMENT_VARIABLES_PER_SCOPE {
            too_many.push_str(&format!("VARIABLE_{index} = \"x\"\n"));
        }
        assert_eq!(
            lookup_user_bytes(too_many.as_bytes(), 7),
            Err(LookupError::InvalidFile)
        );

        let oversized_name = format!(
            "version = 6\nuid = 7\n[environment.pi]\n{} = \"x\"\n",
            format!("A{}", "A".repeat(MAX_ENVIRONMENT_VARIABLE_NAME_BYTES))
        );
        let oversized_value = format!(
            "version = 6\nuid = 7\n[environment.pi]\nTOKEN = \"{}\"\n",
            "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1)
        );
        let mut too_many_extensions = String::from("version = 6\nuid = 7\n");
        for index in 0..=MAX_EXTENSION_ENVIRONMENTS {
            too_many_extensions.push_str(&format!(
                "[environment.extensions.extension-{index}]\nTOKEN = \"x\"\n"
            ));
        }
        for source in [oversized_name, oversized_value, too_many_extensions] {
            assert_eq!(
                lookup_user_bytes(source.as_bytes(), 7),
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
            let source = format!("version = 6\nuid = 7\n[overrides]\nmodels_file = {path:?}\n");
            assert_eq!(
                lookup_user_bytes(source.as_bytes(), 7),
                Err(LookupError::InvalidFile)
            );
        }
    }

    #[test]
    fn absent_directory_or_uid_file_means_no_overrides() {
        let directory = temporary_path();
        let missing = lookup_user(&directory, 7, unsafe { libc::geteuid() }).expect("missing dir");
        assert_eq!(missing, UserRecord::empty(7));

        fs::create_dir(&directory).expect("create directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).expect("chmod dir");
        let missing = lookup_user(&directory, 7, unsafe { libc::geteuid() }).expect("missing file");
        assert_eq!(missing, UserRecord::empty(7));
        fs::remove_dir(directory).expect("remove directory");
    }

    #[test]
    fn accepts_private_uid_file_and_rejects_exposed_or_mismatched_files() {
        let directory = temporary_path();
        fs::create_dir(&directory).expect("create directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).expect("chmod dir");
        let uid = unsafe { libc::geteuid() };
        let path = directory.join(format!("{uid}.toml"));
        fs::write(
            &path,
            format!("version = 6\nuid = {uid}\n[environment.pi]\nTOKEN = \"mine\"\n"),
        )
        .expect("write override");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod file");
        assert_eq!(
            lookup_user(&directory, uid, uid).map(|user| user.environment.pi.get("TOKEN").cloned()),
            Ok(Some("mine".to_owned()))
        );
        assert_eq!(
            lookup_user(&directory, uid, uid + 1),
            Err(LookupError::InvalidFile)
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod file");
        assert_eq!(
            lookup_user(&directory, uid, uid),
            Err(LookupError::InvalidFile)
        );
        fs::remove_dir_all(directory).expect("remove directory");
    }

    #[test]
    fn serves_empty_success_without_a_matching_override() {
        let directory = temporary_path();
        let (mut client, mut server_input) = UnixStream::pair().expect("socket pair");
        let mut server_output = server_input.try_clone().expect("clone server socket");
        client
            .write_all(b"{\"version\":5,\"operation\":\"get-user\"}\n")
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
            "{\"version\":5,\"status\":\"ok\",\"environment\":{\"pi\":{},\"sandbox\":{},\"extensions\":{}},\"overrides\":{}}\n"
        );
    }

    #[test]
    fn requires_a_bounded_newline_delimited_request() {
        let request = b"{\"version\":5,\"operation\":\"get-user\"}";
        assert!(read_request(&mut io::Cursor::new(request)).is_err());
        let mut oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        oversized.push(b'\n');
        assert!(read_request(&mut io::Cursor::new(oversized)).is_err());
    }

    #[test]
    fn rejects_fifo_and_symlink_uid_files() {
        let directory = temporary_path();
        fs::create_dir(&directory).expect("create directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).expect("chmod dir");
        let uid = unsafe { libc::geteuid() };
        let path = directory.join(format!("{uid}.toml"));
        let path_bytes = CString::new(path.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(path_bytes.as_ptr(), 0o600) }, 0);
        assert_eq!(
            lookup_user(&directory, uid, uid),
            Err(LookupError::InvalidFile)
        );
        fs::remove_file(&path).expect("remove fifo");

        let target = directory.join("target.toml");
        fs::write(&target, format!("version = 6\nuid = {uid}\n")).expect("write target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("chmod target");
        symlink(&target, &path).expect("create symlink");
        assert_eq!(lookup_user(&directory, uid, uid), Err(LookupError::Io));
        fs::remove_dir_all(directory).expect("remove directory");
    }

    #[test]
    fn reads_peer_uid_from_kernel_socket_credentials() {
        let (left, _right) = UnixStream::pair().expect("socket pair");
        assert_eq!(peer_uid(left.as_raw_fd()).expect("peer uid"), unsafe {
            libc::geteuid()
        });
    }

    fn temporary_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!("pi-sandbox-users-{}-{nonce}", std::process::id()))
    }
}
