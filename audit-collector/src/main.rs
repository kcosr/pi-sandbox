use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::RawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixDatagram;
use std::path::Path;
use std::time::{Duration, Instant};

// The broker also uses this shared module's group lookup operations.
#[allow(dead_code)]
#[path = "../../native/host_identity.rs"]
mod host_identity;
use host_identity::HostIdentityResolver;

use serde::{Deserialize, Serialize};

const MAX_FRAME_BYTES: usize = 32 * 1024;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    event: Event,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Event {
    event: String,
    pi_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_truncated: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditConfig {
    enabled: bool,
    facility: String,
}

#[derive(Serialize)]
struct Record<'a> {
    schema_version: u32,
    principal_uid: u32,
    principal_user: Option<&'a str>,
    principal_pid: i32,
    audit_session_id: &'a str,
    sequence: u64,
    #[serde(flatten)]
    event: &'a Event,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid audit input")
}

fn facility(config: &str) -> io::Result<Option<u32>> {
    let value: toml::Value = toml::from_str(config).map_err(|_| invalid())?;
    if value
        .get("config_version")
        .and_then(toml::Value::as_integer)
        != Some(6)
    {
        return Err(invalid());
    }
    let audit: AuditConfig = value
        .get("audit")
        .ok_or_else(invalid)?
        .clone()
        .try_into()
        .map_err(|_| invalid())?;
    let number = match audit.facility.as_str() {
        "local0" => 16,
        "local1" => 17,
        "local2" => 18,
        "local3" => 19,
        "local4" => 20,
        "local5" => 21,
        "local6" => 22,
        "local7" => 23,
        _ => return Err(invalid()),
    };
    Ok(audit.enabled.then_some(number))
}

fn load_config(path: &Path) -> io::Result<Option<u32>> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata.file_type().is_symlink() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "unprotected ownership, permissions, or symlink at {:?}",
                    ancestor
                ),
            ));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(invalid());
    }
    facility(std::str::from_utf8(&bytes).map_err(|_| invalid())?)
}

fn peer_credentials(fd: RawFd) -> io::Result<libc::ucred> {
    let mut credentials: libc::ucred = unsafe { zeroed() };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if length as usize != size_of::<libc::ucred>() || credentials.pid <= 0 {
        return Err(invalid());
    }
    Ok(credentials)
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Request>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(invalid())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |position| position + 1);
        if bytes.len() + count > MAX_FRAME_BYTES {
            return Err(invalid());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            break;
        }
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if request.version != 1 || !valid_event(&request.event) {
        return Err(invalid());
    }
    Ok(Some(request))
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}
fn one_of(value: &Option<String>, choices: &[&str]) -> bool {
    value.as_ref().is_none_or(|s| choices.contains(&s.as_str()))
}
fn valid_event(e: &Event) -> bool {
    let tool_event = matches!(
        e.event.as_str(),
        "tool_requested" | "tool_denied" | "tool_execution_intent" | "tool_completed"
    );
    if !tool_event && !matches!(e.event.as_str(), "session_started" | "session_ended") {
        return false;
    }
    if !bounded(&e.pi_session_id, 256) {
        return false;
    }
    for (value, maximum) in [
        (&e.cwd, 4096),
        (&e.invocation_id, 256),
        (&e.tool, 128),
        (&e.extension, 128),
        (&e.path, 4096),
        (&e.repository, 8192),
    ] {
        if value.as_ref().is_some_and(|s| !bounded(s, maximum)) {
            return false;
        }
    }
    if e.cwd.as_ref().is_some_and(|p| !p.starts_with('/'))
        || e.path.as_ref().is_some_and(|p| !p.starts_with('/'))
    {
        return false;
    }
    if e.event == "session_started" && e.cwd.is_none() {
        return false;
    }
    if tool_event && (e.tool.is_none() || e.invocation_id.is_none()) {
        return false;
    }
    if !tool_event
        && (e.tool.is_some()
            || e.invocation_id.is_some()
            || e.path.is_some()
            || e.command.is_some()
            || e.command_truncated.is_some()
            || e.repository.is_some()
            || e.boundary.is_some()
            || e.extension.is_some()
            || e.approval_source.is_some()
            || e.reason.is_some()
            || e.outcome.is_some()
            || e.duration_ms.is_some())
    {
        return false;
    }
    if e.command.as_ref().is_some_and(|s| {
        serde_json::to_string(s).map_or(true, |encoded| encoded.len() - 2 > 4096)
            || s.contains('\0')
    }) || e.command.is_some() != e.command_truncated.is_some()
    {
        return false;
    }
    if e.repository.is_some() && e.extension.is_none() {
        return false;
    }
    if e.command.is_some() && e.tool.as_deref() != Some("bash") {
        return false;
    }
    one_of(&e.boundary, &["bubblewrap", "direct", "host"])
        && one_of(&e.approval_source, &["policy", "prompt", "session_grant"])
        && one_of(
            &e.reason,
            &[
                "policy_denied",
                "user_denied",
                "cancelled",
                "disabled",
                "no_ui",
                "prompt_error",
                "invalid_prompt_decision",
            ],
        )
        && one_of(&e.outcome, &["success", "error", "cancelled", "timeout"])
}

fn reply(output: &mut impl Write, value: serde_json::Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &value).map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn serve(
    input: &mut impl BufRead,
    output: &mut impl Write,
    credentials: libc::ucred,
    session: &str,
    facility: u32,
    resolve_user: impl FnOnce(u32) -> io::Result<Option<String>>,
    mut submit: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let principal_user = resolve_user(credentials.uid).inspect_err(|error| {
        eprintln!("pi-sandbox-audit-collector: account lookup failed: {error}");
    })?;
    let mut sequence = 0_u64;
    let mut active_session: Option<String> = None;
    loop {
        let request = match read_frame(input) {
            Ok(Some(request)) => request,
            Ok(None) => return Ok(()),
            Err(_) => {
                return reply(
                    output,
                    serde_json::json!({"version":1,"ok":false,"code":"protocol_error"}),
                );
            }
        };
        if (request.event.event == "session_started" && active_session.is_some())
            || (request.event.event != "session_started"
                && active_session.as_deref() != Some(request.event.pi_session_id.as_str()))
        {
            return reply(
                output,
                serde_json::json!({"version":1,"ok":false,"code":"protocol_error"}),
            );
        }
        sequence = sequence.checked_add(1).ok_or_else(invalid)?;
        let record = Record {
            schema_version: 2,
            principal_uid: credentials.uid,
            principal_user: principal_user.as_deref(),
            principal_pid: credentials.pid,
            audit_session_id: session,
            sequence,
            event: &request.event,
        };
        let mut message =
            format!("<{}>pi-sandbox[{}]: ", facility * 8 + 6, std::process::id()).into_bytes();
        serde_json::to_writer(&mut message, &record).map_err(io::Error::other)?;
        if submit(&message).is_err() {
            return reply(
                output,
                serde_json::json!({"version":1,"ok":false,"code":"syslog_unavailable"}),
            );
        }
        reply(
            output,
            serde_json::json!({"version":1,"ok":true,"audit_session_id":session}),
        )?;
        if request.event.event == "session_started" {
            active_session = Some(request.event.pi_session_id);
        } else if request.event.event == "session_ended" {
            active_session = None;
        }
    }
}

fn run() -> io::Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "must run as root",
        ));
    }
    let args: Vec<_> = env::args_os().collect();
    if args.len() != 2 {
        return Err(invalid());
    }
    let Some(facility) = load_config(Path::new(&args[1])).inspect_err(|error| {
        eprintln!(
            "pi-sandbox-audit-collector: configuration rejected {:?}: {}",
            args[1], error
        );
    })?
    else {
        return reply(
            &mut io::stdout().lock(),
            serde_json::json!({"version":1,"ok":false,"code":"audit_disabled"}),
        );
    };
    let credentials = peer_credentials(0)?;
    let timeout = libc::timeval {
        tv_sec: 2,
        tv_usec: 0,
    };
    if unsafe {
        libc::setsockopt(
            1,
            libc::SOL_SOCKET,
            libc::SO_SNDTIMEO,
            (&timeout as *const libc::timeval).cast(),
            size_of::<libc::timeval>() as libc::socklen_t,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut random = [0_u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let session = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let syslog = UnixDatagram::unbound()?;
    syslog.set_write_timeout(Some(Duration::from_secs(2)))?;
    let resolver = HostIdentityResolver::new(Instant::now() + Duration::from_secs(4));
    // A datagram send is the delivery boundary; no persistence or forwarding promise.
    serve(
        &mut BufReader::new(io::stdin().lock()),
        &mut io::stdout().lock(),
        credentials,
        &session,
        facility,
        |uid| {
            resolver
                .account(uid)
                .map(|account| account.map(|account| account.user))
        },
        |message| {
            if syslog.send_to(message, "/dev/log")? != message.len() {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "short syslog submission",
                ));
            }
            Ok(())
        },
    )
}

fn main() {
    if run().is_err() {
        eprintln!("pi-sandbox-audit-collector: connection failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    fn start(id: &str) -> serde_json::Value {
        serde_json::json!({"version":1,"event":{"event":"session_started","pi_session_id":id,"cwd":"/workspace"}})
    }
    fn tool() -> serde_json::Value {
        serde_json::json!({"version":1,"event":{"event":"tool_execution_intent","pi_session_id":"pi-1","tool":"bash","invocation_id":"call-1","boundary":"bubblewrap","approval_source":"prompt","command":"printf 'hello\\n'","command_truncated":false}})
    }
    fn lines(values: &[serde_json::Value]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|v| format!("{v}\n").into_bytes())
            .collect()
    }
    fn credentials() -> libc::ucred {
        libc::ucred {
            pid: 42,
            uid: 1001,
            gid: 1002,
        }
    }

    #[test]
    fn stamps_principal_and_acknowledges_only_submitted_events() {
        let mut output = Vec::new();
        let mut messages = Vec::new();
        serve(
            &mut Cursor::new(lines(&[start("pi-1"), tool()])),
            &mut output,
            credentials(),
            "collector-session",
            16,
            |_| Ok(Some("alice".to_owned())),
            |message| {
                messages.push(message.to_vec());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        let line = std::str::from_utf8(&messages[1]).unwrap();
        assert!(line.starts_with("<134>pi-sandbox["));
        assert!(!line.contains('\n'));
        let record: serde_json::Value =
            serde_json::from_str(line.split_once(": ").unwrap().1).unwrap();
        assert_eq!(record["principal_uid"], 1001);
        assert_eq!(record["schema_version"], 2);
        assert_eq!(record["principal_user"], "alice");
        assert!(record.get("principal_gid").is_none());
        assert_eq!(record["principal_pid"], 42);
        assert_eq!(record["audit_session_id"], "collector-session");
        assert_eq!(record["sequence"], 2);
        assert_eq!(
            String::from_utf8(output)
                .unwrap()
                .matches("\"ok\":true")
                .count(),
            2
        );
    }

    #[test]
    fn resolves_kernel_uid_once_and_records_missing_user_as_null() {
        let mut lookups = 0;
        let mut messages = Vec::new();
        serve(
            &mut Cursor::new(lines(&[start("pi-1"), tool()])),
            &mut Vec::new(),
            credentials(),
            "a",
            16,
            |uid| {
                lookups += 1;
                assert_eq!(uid, 1001);
                Ok(None)
            },
            |message| {
                messages.push(message.to_vec());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(lookups, 1);
        for message in messages {
            let line = std::str::from_utf8(&message).unwrap();
            let record: serde_json::Value =
                serde_json::from_str(line.split_once(": ").unwrap().1).unwrap();
            assert_eq!(record["principal_uid"], 1001);
            assert_eq!(record.get("principal_user"), Some(&serde_json::Value::Null));
            assert!(record.get("principal_gid").is_none());
        }
    }

    #[test]
    fn account_lookup_failure_submits_and_acknowledges_nothing() {
        let mut output = Vec::new();
        assert!(
            serve(
                &mut Cursor::new(lines(&[start("pi-1")])),
                &mut output,
                credentials(),
                "a",
                16,
                |_| Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "account lookup deadline exceeded"
                )),
                |_| panic!("must not submit without resolving identity"),
            )
            .is_err()
        );
        assert!(output.is_empty());
    }

    #[test]
    fn failed_submission_nacks_and_stops_without_retry() {
        let mut output = Vec::new();
        let mut attempts = 0;
        serve(
            &mut Cursor::new(lines(&[start("pi-1"), tool()])),
            &mut output,
            credentials(),
            "a",
            16,
            |_| Ok(Some("alice".to_owned())),
            |_| {
                attempts += 1;
                Err(io::Error::other("sensitive internal failure"))
            },
        )
        .unwrap();
        assert_eq!(attempts, 1);
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["ok"], false);
        assert_eq!(response["code"], "syslog_unavailable");
        assert!(!String::from_utf8(output).unwrap().contains("sensitive"));
    }

    #[test]
    fn rejects_payloads_identity_injection_and_unbounded_command() {
        for (field, value) in [
            ("contents", serde_json::json!("secret")),
            ("principal_uid", serde_json::json!(0)),
            ("principal_user", serde_json::json!("root")),
            ("principal_gid", serde_json::json!(0)),
            ("offset", serde_json::json!(1)),
            ("command", serde_json::json!("x".repeat(4097))),
        ] {
            let mut event = tool();
            event["event"][field] = value;
            assert!(read_frame(&mut Cursor::new(lines(&[event]))).is_err());
        }
        let mut event = tool();
        event["event"]["command"] = serde_json::json!("é".repeat(2049));
        assert!(read_frame(&mut Cursor::new(lines(&[event]))).is_err());
        let mut event = tool();
        event["event"]["tool"] = serde_json::json!("write");
        assert!(read_frame(&mut Cursor::new(lines(&[event]))).is_err());
    }

    #[test]
    fn bounds_escaped_command_content_and_keeps_embedded_newlines_on_one_line() {
        let mut request = tool();
        request["event"]["command"] = serde_json::json!("\n".repeat(2048));
        assert!(read_frame(&mut Cursor::new(lines(&[request.clone()]))).is_ok());
        let mut messages = Vec::new();
        serve(
            &mut Cursor::new(lines(&[start("pi-1"), request.clone()])),
            &mut Vec::new(),
            credentials(),
            "a",
            16,
            |_| Ok(Some("alice".to_owned())),
            |message| {
                messages.push(message.to_vec());
                Ok(())
            },
        )
        .unwrap();
        assert!(!messages[1].contains(&b'\n'));
        request["event"]["command"] = serde_json::json!("\n".repeat(2049));
        assert!(read_frame(&mut Cursor::new(lines(&[request]))).is_err());
    }

    #[test]
    fn accepts_repository_targets_only_for_extension_tools() {
        let mut request = tool();
        request["event"]["tool"] = serde_json::json!("repository_checkout");
        request["event"].as_object_mut().unwrap().remove("command");
        request["event"]
            .as_object_mut()
            .unwrap()
            .remove("command_truncated");
        request["event"]["repository"] = serde_json::json!("https://git.example/repo.git");
        assert!(read_frame(&mut Cursor::new(lines(&[request.clone()]))).is_err());
        request["event"]["extension"] = serde_json::json!("repository");
        assert!(read_frame(&mut Cursor::new(lines(&[request]))).is_ok());
    }

    #[test]
    fn rejects_oversized_partial_and_duplicate_fields() {
        assert!(read_frame(&mut Cursor::new(vec![b' '; MAX_FRAME_BYTES + 1])).is_err());
        assert!(read_frame(&mut Cursor::new(b"{\"version\":1}")).is_err());
        assert!(
            read_frame(&mut Cursor::new(
                b"{\"version\":1,\"version\":1,\"event\":{}}\n"
            ))
            .is_err()
        );
    }

    #[test]
    fn enforces_session_lifecycle_and_allows_switches() {
        let end = serde_json::json!({"version":1,"event":{"event":"session_ended","pi_session_id":"pi-1"}});
        let mut output = Vec::new();
        let mut count = 0;
        serve(
            &mut Cursor::new(lines(&[start("pi-1"), end, start("pi-2")])),
            &mut output,
            credentials(),
            "a",
            16,
            |_| Ok(Some("alice".to_owned())),
            |_| {
                count += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(count, 3);
        for requests in [
            vec![tool()],
            vec![start("pi-2"), tool()],
            vec![start("pi-1"), start("pi-2")],
        ] {
            let mut output = Vec::new();
            serve(
                &mut Cursor::new(lines(&requests)),
                &mut output,
                credentials(),
                "a",
                16,
                |_| Ok(Some("alice".to_owned())),
                |_| Ok(()),
            )
            .unwrap();
            assert!(
                String::from_utf8(output)
                    .unwrap()
                    .contains("protocol_error")
            );
        }
    }

    #[test]
    fn accepts_shipped_configuration() {
        for source in [
            include_str!("../../config/default/config.toml"),
            include_str!("../../config/default/config.direct.toml"),
        ] {
            assert!(facility(source).is_ok());
            let enabled = source.replace("enabled = false", "enabled = true");
            assert_eq!(facility(&enabled).unwrap(), Some(16));
        }
    }

    #[test]
    fn configuration_owns_facility_and_requires_current_schema() {
        assert_eq!(
            facility("config_version=6\n[audit]\nenabled=true\nfacility='local7'").unwrap(),
            Some(23)
        );
        assert_eq!(
            facility("config_version=6\n[audit]\nenabled=false\nfacility='local0'").unwrap(),
            None
        );
        for text in [
            "config_version=5\n[audit]\nenabled=true\nfacility='local0'",
            "config_version=6\n[audit]\nenabled=true\nfacility='auth'",
            "config_version=6\n[audit]\nenabled=true\nfacility='local0'\npath='/tmp/log'",
        ] {
            assert!(facility(text).is_err());
        }
    }

    #[test]
    fn credentials_come_from_kernel_and_datagram_submission_is_real() {
        let (left, _right) = UnixStream::pair().unwrap();
        let peer = peer_credentials(left.as_raw_fd()).unwrap();
        assert_eq!(peer.uid, unsafe { libc::geteuid() });
        assert_eq!(peer.pid, std::process::id() as i32);
        let (sender, receiver) = UnixDatagram::pair().unwrap();
        let mut output = Vec::new();
        serve(
            &mut Cursor::new(lines(&[start("pi-1")])),
            &mut output,
            peer,
            "a",
            16,
            |_| Ok(Some("alice".to_owned())),
            |message| sender.send(message).map(|_| ()),
        )
        .unwrap();
        let mut buffer = [0; 4096];
        let count = receiver.recv(&mut buffer).unwrap();
        assert!(
            std::str::from_utf8(&buffer[..count])
                .unwrap()
                .contains("session_started")
        );
    }
}
