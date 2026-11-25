use std::collections::BTreeMap;
use std::io;
use std::net::SocketAddr;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpSocket, UnixListener};
use tokio::sync::oneshot;

use crate::audit::{Audit, Identity, Mutation, Open, Syslog};
use crate::host_identity::HostIdentityResolver;
use crate::manifest::{Listener, Manifest, Password};
use crate::protocol::{
    CONFIG, Error, INVALID, MAX_REQUEST, MAX_RESPONSE, Operation, Request, Result,
};
use crate::rules::Principal;

trait Connection: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Connection for T {}
type Stream = Box<dyn Connection>;
#[derive(Clone)]
enum Peer {
    Unix { uid: u32, pid: i32 },
    Https(std::net::IpAddr),
}
impl Peer {
    fn key(&self) -> String {
        match self {
            Self::Unix { uid, .. } => format!("u:{uid}"),
            Self::Https(ip) => format!("i:{ip}"),
        }
    }
}
struct Quotas {
    total: usize,
    connections: BTreeMap<String, usize>,
    new_work: BTreeMap<String, usize>,
}
struct Permit {
    quotas: Arc<Mutex<Quotas>>,
    key: String,
    new_work: bool,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut q = self.quotas.lock().unwrap();
        let map = if self.new_work {
            &mut q.new_work
        } else {
            &mut q.connections
        };
        if let Some(count) = map.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.key);
            }
        }
        if !self.new_work {
            q.total -= 1;
        }
    }
}
struct Completion {
    result: Result<Value>,
    _release: crossbeam_channel::Sender<()>,
}
struct Job {
    work: Box<dyn FnOnce() -> Result<Value> + Send>,
    reply: oneshot::Sender<Completion>,
    _connection: Arc<Permit>,
    _admission: Option<Permit>,
}
struct Pool {
    sender: crossbeam_channel::Sender<Job>,
}
impl Pool {
    fn new(workers: usize, capacity: usize) -> io::Result<Self> {
        let (sender, receiver) = crossbeam_channel::bounded::<Job>(capacity);
        for index in 0..workers {
            let receiver = receiver.clone();
            std::thread::Builder::new()
                .name(format!("service-worker-{workers}-{index}"))
                .spawn(move || {
                    while let Ok(job) = receiver.recv() {
                        let result = (job.work)();
                        let (tx, rx) = crossbeam_channel::bounded::<()>(0);
                        if job
                            .reply
                            .send(Completion {
                                result,
                                _release: tx,
                            })
                            .is_ok()
                        {
                            let _ = rx.recv();
                        }
                        // The request/worker slot stays charged until response drain or receiver drop.
                    }
                })?;
        }
        Ok(Self { sender })
    }
}
struct Runtime {
    audit: Arc<Audit>,
    new_pool: Pool,
    event_pool: Pool,
    quotas: Arc<Mutex<Quotas>>,
    limits: crate::manifest::Limits,
    owner: u32,
}
struct ActiveListener {
    config: Listener,
    passwords: Vec<Password>,
    tls: Option<Arc<rustls::ServerConfig>>,
}
impl Runtime {
    fn connection(self: &Arc<Self>, peer: &Peer) -> Result<Arc<Permit>> {
        let mut q = self.quotas.lock().unwrap();
        let key = peer.key();
        let cap = match peer {
            Peer::Unix { .. } => self.limits.max_connections_per_uid,
            Peer::Https(_) => self.limits.max_connections_per_ip,
        };
        if q.total >= self.limits.max_connections
            || q.connections.get(&key).copied().unwrap_or(0) >= cap
        {
            return Err(Error("busy"));
        }
        q.total += 1;
        *q.connections.entry(key.clone()).or_default() += 1;
        Ok(Arc::new(Permit {
            quotas: self.quotas.clone(),
            key,
            new_work: false,
        }))
    }
    fn admission(&self, peer: &Peer) -> Result<Permit> {
        let mut q = self.quotas.lock().unwrap();
        let key = peer.key();
        let count = q.new_work.entry(key.clone()).or_default();
        if *count >= 4 {
            return Err(Error("busy"));
        }
        *count += 1;
        Ok(Permit {
            quotas: self.quotas.clone(),
            key,
            new_work: true,
        })
    }
}
struct HttpRequest {
    body: Vec<u8>,
    authorization: Option<String>,
    bytes: usize,
}
async fn read_request(stream: &mut Stream) -> Result<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0; 4096];
    let header_end = loop {
        if let Some(end) = buffer.windows(4).position(|s| s == b"\r\n\r\n") {
            if end + 4 > 16 * 1024 {
                return Err(Error("request_too_large"));
            }
            break end + 4;
        }
        if buffer.len() >= 16 * 1024 {
            return Err(Error("request_too_large"));
        }
        let n = stream.read(&mut chunk).await.map_err(|_| INVALID)?;
        if n == 0 {
            return Err(INVALID);
        }
        buffer.extend_from_slice(&chunk[..n]);
    };
    let mut headers = [httparse::EMPTY_HEADER; 128];
    let mut request = httparse::Request::new(&mut headers);
    if request
        .parse(&buffer[..header_end])
        .map_err(|_| INVALID)?
        .is_partial()
        || request.method != Some("POST")
        || request.path != Some("/v1/service")
        || request.version != Some(1)
    {
        return Err(INVALID);
    }
    let mut length = None;
    let mut auth = None;
    let mut host = false;
    let mut content = false;
    let mut connection = false;
    for header in request.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        let value = std::str::from_utf8(header.value)
            .map_err(|_| INVALID)?
            .trim();
        match name.as_str() {
            "content-length" => {
                if length.is_some()
                    || value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(INVALID);
                }
                length = Some(value.parse::<usize>().map_err(|_| INVALID)?);
            }
            "authorization" => {
                if auth.is_some() {
                    return Err(INVALID);
                }
                auth = Some(value.to_owned());
            }
            "host" => {
                if host || value.is_empty() {
                    return Err(INVALID);
                }
                host = true;
            }
            "content-type" => {
                if content
                    || !(value.eq_ignore_ascii_case("application/json")
                        || value.eq_ignore_ascii_case("application/json; charset=utf-8"))
                {
                    return Err(INVALID);
                }
                content = true;
            }
            "connection" => {
                if connection || !value.eq_ignore_ascii_case("close") {
                    return Err(INVALID);
                }
                connection = true;
            }
            "content-encoding" | "transfer-encoding" | "upgrade" | "expect" => return Err(INVALID),
            _ => {}
        }
    }
    if !host || !content {
        return Err(INVALID);
    }
    let length = length.ok_or(INVALID)?;
    if length > MAX_REQUEST {
        return Err(Error("request_too_large"));
    }
    if buffer.len() > header_end + length {
        return Err(INVALID);
    }
    while buffer.len() < header_end + length {
        let n = stream.read(&mut chunk).await.map_err(|_| INVALID)?;
        if n == 0 {
            return Err(INVALID);
        }
        if buffer.len() + n > header_end + length {
            return Err(INVALID);
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let bytes = buffer.len();
    let body = buffer.split_off(header_end);
    Ok(HttpRequest {
        body,
        authorization: auth,
        bytes,
    })
}
fn authenticate_credential(
    listener: &ActiveListener,
    peer: &Peer,
    authorization: Option<&str>,
) -> Result<Option<String>> {
    if matches!(peer, Peer::Unix { .. }) {
        return if authorization.is_none() {
            Ok(None)
        } else {
            Err(INVALID)
        };
    }
    let authorization = authorization.ok_or(Error("authentication_required"))?;
    let (scheme, encoded) = authorization
        .split_once(' ')
        .ok_or(Error("authentication_required"))?;
    if !scheme.eq_ignore_ascii_case("Basic") {
        return Err(Error("authentication_required"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| Error("authentication_required"))?;
    let separator = decoded
        .iter()
        .position(|b| *b == b':')
        .ok_or(Error("authentication_required"))?;
    let name =
        std::str::from_utf8(&decoded[..separator]).map_err(|_| Error("authentication_required"))?;
    let mut matched = false;
    for password in &listener.passwords {
        matched |= password.matches(name, &decoded[separator + 1..]);
    }
    if !matched {
        return Err(Error("authentication_required"));
    }
    Ok(Some(name.into()))
}
fn authenticated_identity(
    peer: &Peer,
    request: &Request,
    credential: Option<String>,
) -> Result<Identity> {
    match peer {
        Peer::Unix { uid, pid } => {
            if request.identity.is_some() {
                return Err(INVALID);
            }
            Ok(Identity::UnixPeer {
                uid: *uid,
                pid: *pid,
                user: None,
            })
        }
        Peer::Https(_) => {
            let identity = request.identity.as_ref().ok_or(INVALID)?;
            Ok(Identity::HttpsAssertion {
                credential_name: credential.ok_or(Error("authentication_required"))?,
                username: identity.username.clone(),
                machine_id: identity.machine_id.clone(),
            })
        }
    }
}

fn work(
    runtime: &Arc<Runtime>,
    listener: &ActiveListener,
    request: &Request,
    mut identity: Identity,
    claim: Option<Mutation>,
    deadline: Instant,
) -> Result<Value> {
    if Instant::now() >= deadline {
        return Err(Error("busy"));
    }
    match &request.operation {
        Operation::Bootstrap { client, .. } | Operation::PolicyInspect { client, .. } => {
            if client.platform != listener.config.platform {
                return Err(Error("incompatible_client"));
            }
            let principal = match &identity {
                Identity::UnixPeer { uid, .. } => Principal::Unix(*uid),
                Identity::HttpsAssertion { username, .. } => Principal::Https(username),
            };
            crate::sources::bootstrap(
                &listener.config,
                principal,
                runtime.owner,
                deadline,
                matches!(request.operation, Operation::PolicyInspect { .. }),
            )
        }
        Operation::AuditOpen {
            client_instance_id,
            audit_generation,
            pi_session_id,
            cwd,
            policy_origin,
        } => {
            if !crate::sources::audit_enabled(&listener.config, runtime.owner)? {
                return Err(Error("audit_disabled"));
            }
            if let Identity::UnixPeer { uid, user, .. } = &mut identity {
                let lookup_deadline = deadline
                    .checked_sub(Duration::from_millis(2500))
                    .ok_or(Error("busy"))?
                    .min(Instant::now() + Duration::from_secs(4));
                if Instant::now() >= lookup_deadline {
                    return Err(Error("busy"));
                }
                *user = HostIdentityResolver::new(lookup_deadline)
                    .account(*uid)
                    .map_err(crate::protocol::identity_failure)?
                    .map(|a| a.user);
            }
            runtime.audit.open(
                Open {
                    listener: &listener.config.id,
                    client: client_instance_id,
                    generation: *audit_generation,
                    session: pi_session_id,
                    cwd,
                    origin: policy_origin.clone(),
                    identity,
                    facility: listener.config.facility().ok_or(CONFIG)?,
                },
                deadline,
            )
        }
        Operation::AuditEvent { event, .. } => claim
            .ok_or(INVALID)?
            .complete(Some(event.clone()), deadline),
        Operation::AuditClose { .. } => claim.ok_or(INVALID)?.complete(None, deadline),
        Operation::AuditCheck { .. } => Err(INVALID),
    }
}
fn response_depth_valid(value: &Value, depth: usize) -> bool {
    depth <= 32
        && match value {
            Value::Array(items) => items.iter().all(|v| response_depth_valid(v, depth + 1)),
            Value::Object(items) => items.values().all(|v| response_depth_valid(v, depth + 1)),
            _ => true,
        }
}

async fn write_response(stream: &mut Stream, status: u16, value: &Value) -> io::Result<usize> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        410 => "Gone",
        413 => "Content Too Large",
        _ => "Service Unavailable",
    };
    let auth = if status == 401 {
        "WWW-Authenticate: Basic realm=\"pi-sandbox-service\"\r\n"
    } else {
        ""
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{auth}\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await?;
    Ok(head.len() + body.len())
}
fn compatibility_message(body: &[u8], expected_platform: &str) -> Option<String> {
    let value = crate::protocol::strict_json(body).ok()?;
    fn tag(value: &Value) -> String {
        if let Some(number) = value.as_u64() {
            return number.to_string();
        }
        if let Some(text) = value.as_str()
            && !text.is_empty()
            && text.len() <= 32
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        {
            return text.to_owned();
        }
        "invalid".into()
    }
    Some(format!(
        "Expected api=1, policy=16, models=pi-1.5.0, platform={expected_platform}, arch=x64|arm64; supplied api={}, policy={}, models={}, platform={}, arch={}",
        tag(&value["version"]),
        tag(&value["policy_schema"]),
        tag(&value["model_schema"]),
        tag(&value["client"]["platform"]),
        tag(&value["client"]["architecture"])
    ))
}
fn error_envelope(error: Error, id: Option<&str>, compatibility: Option<&str>) -> Value {
    let mut envelope = error.envelope(id);
    if matches!(error.0, "incompatible_client" | "unsupported_version")
        && let Some(message) = compatibility
    {
        envelope["error"]["message"] = message.into();
    }
    envelope
}

struct RequestMetadata {
    id: String,
    operation: &'static str,
}
#[allow(clippy::too_many_arguments)]
fn log(
    listener: &str,
    request: Option<&RequestMetadata>,
    identity: Option<&Identity>,
    code: &str,
    start: Instant,
    input: usize,
    output: usize,
    result: Option<&Value>,
) {
    let mut record = json!({"listener_id":listener,"operation":request.map(|r|r.operation),"request_id":request.map(|r|r.id.as_str()),"identity":identity,"code":code,"duration_ms":start.elapsed().as_millis().min(u64::MAX as u128) as u64,"request_bytes":input,"response_bytes":output});
    if request.is_some_and(|r| r.operation == "bootstrap")
        && code == "ok"
        && let Some(revision) = result.and_then(|r| r.get("policy_revision"))
    {
        record["policy_revision"] = revision.clone();
    }
    eprintln!("{record}");
}
async fn handle(
    mut stream: Stream,
    runtime: Arc<Runtime>,
    listener: Arc<ActiveListener>,
    peer: Peer,
    permit: Arc<Permit>,
    start: Instant,
) -> Result<()> {
    let deadline = start + Duration::from_secs(6);
    let http = match read_request(&mut stream).await {
        Ok(v) => v,
        Err(e) => {
            let n = write_response(&mut stream, e.status(), &e.envelope(None))
                .await
                .unwrap_or(0);
            log(&listener.config.id, None, None, e.0, start, 0, n, None);
            return Ok(());
        }
    };
    // Authenticate ingress before decoding any protocol tags or asserted identity.
    let credential = match authenticate_credential(&listener, &peer, http.authorization.as_deref())
    {
        Ok(credential) => credential,
        Err(error) => {
            let output = write_response(&mut stream, error.status(), &error.envelope(None))
                .await
                .unwrap_or(0);
            log(
                &listener.config.id,
                None,
                None,
                error.0,
                start,
                http.bytes,
                output,
                None,
            );
            return Ok(());
        }
    };
    let request = match Request::parse(&http.body) {
        Ok(r) => r,
        Err(e) => {
            let compatibility = matches!(e.0, "incompatible_client" | "unsupported_version")
                .then(|| compatibility_message(&http.body, &listener.config.platform))
                .flatten();
            let n = write_response(
                &mut stream,
                e.status(),
                &error_envelope(e, None, compatibility.as_deref()),
            )
            .await
            .unwrap_or(0);
            log(
                &listener.config.id,
                None,
                None,
                e.0,
                start,
                http.bytes,
                n,
                None,
            );
            return Ok(());
        }
    };
    let metadata = RequestMetadata {
        id: request.id.clone(),
        operation: request.operation.name(),
    };
    let identity = match authenticated_identity(&peer, &request, credential) {
        Ok(i) => i,
        Err(e) => {
            let n = write_response(&mut stream, e.status(), &e.envelope(Some(&metadata.id)))
                .await
                .unwrap_or(0);
            log(
                &listener.config.id,
                Some(&metadata),
                None,
                e.0,
                start,
                http.bytes,
                n,
                None,
            );
            return Ok(());
        }
    };
    drop(http.authorization);
    let large = request.operation.large();
    let compatibility = large
        .then(|| compatibility_message(&http.body, &listener.config.platform))
        .flatten();
    let mut completion = None;
    let result: Result<Value> = async {
        if let Operation::AuditCheck {
            audit_session_id,
            service_epoch,
        } = &request.operation
        {
            return runtime.audit.check(
                audit_session_id,
                service_epoch,
                &listener.config.id,
                &identity,
            );
        }
        let admission = if request.operation.new_work() {
            Some(runtime.admission(&peer)?)
        } else {
            None
        };
        let claim = match &request.operation {
            Operation::AuditEvent {
                audit_session_id,
                service_epoch,
                sequence,
                ..
            }
            | Operation::AuditClose {
                audit_session_id,
                service_epoch,
                sequence,
            } => Some(runtime.audit.claim(
                audit_session_id,
                service_epoch,
                &listener.config.id,
                &identity,
                *sequence,
                matches!(request.operation, Operation::AuditClose { .. }),
            )?),
            _ => None,
        };
        let (pool_runtime, pool_listener, pool_identity) =
            (runtime.clone(), listener.clone(), identity.clone());
        let (tx, rx) = oneshot::channel();
        let body = http.body;
        let job = Job {
            work: Box::new(move || {
                let request = Request::parse(&body)?;
                work(
                    &pool_runtime,
                    &pool_listener,
                    &request,
                    pool_identity,
                    claim,
                    deadline,
                )
            }),
            reply: tx,
            _connection: permit,
            _admission: admission,
        };
        let pool = if request.operation.new_work() {
            &runtime.new_pool
        } else {
            &runtime.event_pool
        };
        // Waiting requests retain only encoded bodies and small dispatch metadata.
        drop(request);
        pool.sender.try_send(job).map_err(|_| Error("busy"))?;
        completion = Some(rx.await.map_err(|_| Error("busy"))?);
        completion.as_mut().unwrap().result.take_result()
    }
    .await;
    let (status, code, envelope) = match &result {
        Ok(value) => (
            200,
            "ok",
            json!({"version":1,"request_id":metadata.id,"operation":metadata.operation,"result":value}),
        ),
        Err(e) => (
            e.status(),
            e.0,
            error_envelope(*e, Some(&metadata.id), compatibility.as_deref()),
        ),
    };
    let bound = if large { MAX_RESPONSE } else { 4096 };
    let (status, code, envelope) = if !response_depth_valid(&envelope, 0) {
        (
            CONFIG.status(),
            CONFIG.0,
            CONFIG.envelope(Some(&metadata.id)),
        )
    } else if serde_json::to_vec(&envelope).map_err(|_| CONFIG)?.len() > bound {
        let e = Error("request_too_large");
        (e.status(), e.0, e.envelope(Some(&metadata.id)))
    } else {
        (status, code, envelope)
    };
    let output = write_response(&mut stream, status, &envelope)
        .await
        .unwrap_or(0);
    log(
        &listener.config.id,
        Some(&metadata),
        Some(&identity),
        code,
        start,
        http.bytes,
        output,
        result.as_ref().ok(),
    );
    drop(completion);
    Ok(())
}
trait TakeResult {
    fn take_result(&mut self) -> Result<Value>;
}
impl TakeResult for Result<Value> {
    fn take_result(&mut self) -> Result<Value> {
        std::mem::replace(self, Err(Error("busy")))
    }
}
fn peer_credentials(stream: &tokio::net::UnixStream) -> io::Result<Peer> {
    let mut value = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut value as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() || value.pid <= 0 {
        return Err(io::Error::other("invalid peer credentials"));
    }
    Ok(Peer::Unix {
        uid: value.uid,
        pid: value.pid,
    })
}
fn spawn_connection(
    stream: Stream,
    runtime: Arc<Runtime>,
    listener: Arc<ActiveListener>,
    peer: Peer,
    start: Instant,
) {
    let permit = match runtime.connection(&peer) {
        Ok(p) => p,
        Err(e) => {
            log(&listener.config.id, None, None, e.0, start, 0, 0, None);
            return;
        }
    };
    tokio::spawn(async move {
        let id = listener.config.id.clone();
        let tls = listener.tls.clone();
        let operation = async {
            let stream: Stream = if let Some(config) = tls {
                Box::new(
                    tokio_rustls::TlsAcceptor::from(config)
                        .accept(stream)
                        .await
                        .map_err(|_| INVALID)?,
                )
            } else {
                stream
            };
            handle(stream, runtime, listener, peer, permit, start).await
        };
        if !matches!(
            tokio::time::timeout_at(
                tokio::time::Instant::from_std(start + Duration::from_secs(6)),
                operation
            )
            .await,
            Ok(Ok(()))
        ) {
            log(&id, None, None, "request_failed", start, 0, 0, None);
        }
    });
}
struct SocketCleanup(Vec<(String, u64, u64)>);
impl Drop for SocketCleanup {
    fn drop(&mut self) {
        for (path, dev, ino) in &self.0 {
            if let Ok(metadata) = std::fs::symlink_metadata(path)
                && metadata.dev() == *dev
                && metadata.ino() == *ino
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
pub async fn run(manifest: Manifest) -> Result<()> {
    manifest.check()?;
    let owner = manifest.admitted_owner()?;
    manifest.descriptor_limit()?;
    let runtime = Arc::new(Runtime {
        audit: Audit::new(manifest.limits.clone(), Arc::new(Syslog))?,
        new_pool: Pool::new(16, manifest.limits.max_connections).map_err(|_| CONFIG)?,
        event_pool: Pool::new(32, manifest.limits.max_connections).map_err(|_| CONFIG)?,
        quotas: Arc::new(Mutex::new(Quotas {
            total: 0,
            connections: BTreeMap::new(),
            new_work: BTreeMap::new(),
        })),
        limits: manifest.limits,
        owner,
    });
    let mut prepared = Vec::new();
    for config in manifest.listeners {
        config.validate_material_metadata(owner)?;
        let passwords = config.passwords(owner)?;
        let tls = config.tls(owner)?;
        prepared.push(Arc::new(ActiveListener {
            config,
            passwords,
            tls,
        }));
    }
    enum Bound {
        Unix(UnixListener),
        Tcp(tokio::net::TcpListener),
    }
    let mut bound = Vec::new();
    let mut cleanup = SocketCleanup(Vec::new());
    for listener in prepared {
        let socket = if let Some(path) = &listener.config.socket_path {
            crate::sources::protected_directory(Path::new(path).parent().ok_or(CONFIG)?, 0)?;
            if let Ok(metadata) = std::fs::symlink_metadata(path) {
                use std::os::unix::fs::FileTypeExt;
                if !metadata.file_type().is_socket() || metadata.uid() != 0 {
                    return Err(CONFIG);
                }
                match tokio::time::timeout(
                    Duration::from_millis(100),
                    tokio::net::UnixStream::connect(path),
                )
                .await
                {
                    Ok(Err(e)) if e.kind() == io::ErrorKind::ConnectionRefused => {
                        std::fs::remove_file(path).map_err(|_| CONFIG)?
                    }
                    _ => return Err(CONFIG),
                }
            }
            let socket = UnixListener::bind(path).map_err(|_| CONFIG)?;
            let metadata = std::fs::symlink_metadata(path).map_err(|_| CONFIG)?;
            cleanup
                .0
                .push((path.clone(), metadata.dev(), metadata.ino()));
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))
                .map_err(|_| CONFIG)?;
            Bound::Unix(socket)
        } else {
            let address = listener
                .config
                .listen_address
                .as_deref()
                .ok_or(CONFIG)?
                .parse::<SocketAddr>()
                .map_err(|_| CONFIG)?;
            let socket = if address.is_ipv4() {
                TcpSocket::new_v4()
            } else {
                TcpSocket::new_v6()
            }
            .map_err(|_| CONFIG)?;
            socket.set_reuseaddr(true).map_err(|_| CONFIG)?;
            if address.is_ipv6() {
                let yes = 1 as libc::c_int;
                if unsafe {
                    libc::setsockopt(
                        socket.as_raw_fd(),
                        libc::IPPROTO_IPV6,
                        libc::IPV6_V6ONLY,
                        (&yes as *const libc::c_int).cast(),
                        std::mem::size_of_val(&yes) as libc::socklen_t,
                    )
                } != 0
                {
                    return Err(CONFIG);
                }
            }
            socket.bind(address).map_err(|_| CONFIG)?;
            Bound::Tcp(socket.listen(128).map_err(|_| CONFIG)?)
        };
        bound.push((listener, socket));
    }
    let mut tasks = tokio::task::JoinSet::new();
    for (listener, socket) in bound {
        let runtime = runtime.clone();
        tasks.spawn(async move {
            loop {
                match &socket {
                    Bound::Unix(socket) => {
                        let (stream, _) = match socket.accept().await {
                            Ok(v) => v,
                            Err(_) => return Err::<(), Error>(CONFIG),
                        };
                        let start = Instant::now();
                        if let Ok(peer) = peer_credentials(&stream) {
                            spawn_connection(
                                Box::new(stream),
                                runtime.clone(),
                                listener.clone(),
                                peer,
                                start,
                            )
                        }
                    }
                    Bound::Tcp(socket) => {
                        let (stream, address) = match socket.accept().await {
                            Ok(v) => v,
                            Err(_) => return Err::<(), Error>(CONFIG),
                        };
                        spawn_connection(
                            Box::new(stream),
                            runtime.clone(),
                            listener.clone(),
                            Peer::Https(address.ip()),
                            Instant::now(),
                        );
                    }
                }
            }
        });
    }
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| CONFIG)?;
    let failed = tokio::select! {_ = term.recv()=>false,_ = tokio::signal::ctrl_c()=>false,_ = tasks.join_next()=>true};
    tasks.abort_all();
    drop(cleanup);
    if failed { Err(CONFIG) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, MemorySink};
    fn runtime(owner: u32, sink: Arc<MemorySink>) -> Arc<Runtime> {
        let limits = crate::manifest::Limits::default();
        Arc::new(Runtime {
            audit: Audit::new(limits.clone(), sink).unwrap(),
            new_pool: Pool::new(16, limits.max_connections).unwrap(),
            event_pool: Pool::new(32, limits.max_connections).unwrap(),
            quotas: Arc::new(Mutex::new(Quotas {
                total: 0,
                connections: BTreeMap::new(),
                new_work: BTreeMap::new(),
            })),
            limits,
            owner,
        })
    }
    fn body(operation: &str) -> Value {
        json!({"version":1,"request_id":crate::protocol::random_id().unwrap(),"operation":operation})
    }
    #[test]
    fn incompatibility_messages_include_only_bounded_supplied_tags() {
        let body = json!({"version":2,"policy_schema":15,"model_schema":"pi-1.4.0","client":{"platform":"darwin","architecture":"arm64"},"Authorization":"secret","environment":{"TOKEN":"secret"}});
        let message = compatibility_message(&serde_json::to_vec(&body).unwrap(), "linux").unwrap();
        assert!(message.contains("Expected api=1, policy=16"));
        assert!(
            message.contains(
                "supplied api=2, policy=15, models=pi-1.4.0, platform=darwin, arch=arm64"
            )
        );
        assert!(!message.contains("secret"));
        let mut malformed = body;
        malformed["model_schema"] = "private\nvalue".into();
        malformed["client"]["platform"] = "x".repeat(300).into();
        let message =
            compatibility_message(&serde_json::to_vec(&malformed).unwrap(), "linux").unwrap();
        assert!(message.len() <= 256 && !message.contains("private"));
        let envelope = error_envelope(Error("incompatible_client"), None, Some(&message));
        assert_eq!(envelope["error"]["message"], message);
        assert_eq!(
            error_envelope(CONFIG, None, Some("secret"))["error"]["message"],
            CONFIG.message()
        );
    }
    fn open() -> Value {
        let mut v = body("audit_open");
        v["client_instance_id"] = "2".repeat(32).into();
        v["audit_generation"] = 1.into();
        v["pi_session_id"] = "pi".into();
        v["cwd"] = "/work".into();
        v["policy_origin"] = json!({"source":"local"});
        v
    }
    async fn post(mut stream: Stream, body: Value, authorization: Option<&str>) -> (u16, Value) {
        let bytes = serde_json::to_vec(&body).unwrap();
        let auth = authorization
            .map(|s| format!("Authorization: {s}\r\n"))
            .unwrap_or_default();
        let header = format!(
            "POST /v1/service HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{auth}\r\n",
            bytes.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let end = response.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
        let status = std::str::from_utf8(&response[..end])
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (
            status,
            serde_json::from_slice(&response[end + 4..]).unwrap(),
        )
    }
    #[tokio::test]
    async fn real_unix_connections_bootstrap_audit_and_peer_binding() {
        let f = Fixture::new();
        let sink = Arc::new(MemorySink::default());
        let runtime = runtime(f.owner, sink.clone());
        let listener = Arc::new(ActiveListener {
            config: f.listener.clone(),
            passwords: vec![],
            tls: None,
        });
        let path =
            std::env::temp_dir().join(format!("pisvc-{}", crate::protocol::random_id().unwrap()));
        let socket = UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            for _ in 0..7 {
                let (stream, _) = socket.accept().await.unwrap();
                let peer = peer_credentials(&stream).unwrap();
                spawn_connection(
                    Box::new(stream),
                    runtime.clone(),
                    listener.clone(),
                    peer,
                    Instant::now(),
                );
            }
        });
        let mut bootstrap = body("bootstrap");
        bootstrap["policy_schema"] = 16.into();
        bootstrap["model_schema"] = "pi-1.5.0".into();
        bootstrap["client"] = json!({"platform":"linux","architecture":"x64","application_version":"test","build_id":"test"});
        for (field, supplied) in [
            ("version", json!(2)),
            ("policy_schema", json!(15)),
            ("platform", json!("darwin")),
        ] {
            let mut incompatible = bootstrap.clone();
            if field == "platform" {
                incompatible["client"][field] = supplied;
            } else {
                incompatible[field] = supplied;
            }
            let (status, response) = post(
                Box::new(tokio::net::UnixStream::connect(&path).await.unwrap()),
                incompatible,
                None,
            )
            .await;
            assert!(status == 400 || status == 403);
            let message = response["error"]["message"].as_str().unwrap();
            assert!(
                message.contains("Expected api=1, policy=16") && message.contains("supplied api=")
            );
            assert!(message.contains(if field == "platform" {
                "platform=darwin"
            } else if field == "version" {
                "supplied api=2"
            } else {
                "policy=15"
            }));
        }
        let (status, result) = post(
            Box::new(tokio::net::UnixStream::connect(&path).await.unwrap()),
            bootstrap,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert!(result["result"]["policy"].get("models_file").is_none());
        let (status, result) = post(
            Box::new(tokio::net::UnixStream::connect(&path).await.unwrap()),
            open(),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let session = &result["result"];
        let mut event = body("audit_event");
        event["audit_session_id"] = session["audit_session_id"].clone();
        event["service_epoch"] = session["service_epoch"].clone();
        event["sequence"] = 1.into();
        event["event"] = json!({"event":"tool_requested","pi_session_id":"pi","invocation_id":"inv","tool":"write","boundary":"seatbelt"});
        let (status, result) = post(
            Box::new(tokio::net::UnixStream::connect(&path).await.unwrap()),
            event,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(result["result"]["next_sequence"], 2);
        let mut injected = open();
        injected["identity"] = json!({"username":"root"});
        assert_eq!(
            post(
                Box::new(tokio::net::UnixStream::connect(&path).await.unwrap()),
                injected,
                None
            )
            .await
            .0,
            400
        );
        task.await.unwrap();
        std::fs::remove_file(&path).unwrap();
        let records = sink.records.lock().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["identity"]["uid"], f.owner);
        assert_eq!(records[0]["identity"]["pid"], std::process::id());
    }
    #[tokio::test]
    async fn real_https_authentication_and_assertion_bound_handles() {
        let mut f = Fixture::new();
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        f.listener.transport = "https".into();
        f.listener.socket_path = None;
        f.listener.certificate_file = Some(
            f.write("cert.pem", generated.cert.pem(), false)
                .to_str()
                .unwrap()
                .into(),
        );
        f.listener.private_key_file = Some(
            f.write("key.pem", generated.key_pair.serialize_pem(), true)
                .to_str()
                .unwrap()
                .into(),
        );
        f.listener.credentials = Some(vec![crate::manifest::Credential {
            name: "distribution".into(),
            password_file: f
                .write("password", "z".repeat(32), true)
                .to_str()
                .unwrap()
                .into(),
        }]);
        let passwords = f.listener.passwords(f.owner).unwrap();
        let tls = f.listener.tls(f.owner).unwrap();
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        f.listener.listen_address = Some(address.to_string());
        let mut roots = rustls::RootCertStore::empty();
        roots.add(generated.cert.der().clone()).unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let sink = Arc::new(MemorySink::default());
        let runtime = runtime(f.owner, sink.clone());
        let listener = Arc::new(ActiveListener {
            config: f.listener.clone(),
            passwords,
            tls,
        });
        let task = tokio::spawn(async move {
            for _ in 0..7 {
                let (stream, peer) = socket.accept().await.unwrap();
                spawn_connection(
                    Box::new(stream),
                    runtime.clone(),
                    listener.clone(),
                    Peer::Https(peer.ip()),
                    Instant::now(),
                );
            }
        });
        let connect = || {
            let connector = connector.clone();
            async move {
                Box::new(
                    connector
                        .connect(
                            rustls::pki_types::ServerName::try_from("localhost").unwrap(),
                            tokio::net::TcpStream::connect(address).await.unwrap(),
                        )
                        .await
                        .unwrap(),
                ) as Stream
            }
        };
        let auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("distribution:{}", "z".repeat(32)))
        );
        for (invalid, auth) in [
            (json!("not-an-object"), None),
            (json!({"version":999,"operation":"bootstrap"}), None),
            (
                json!({"version":999}),
                Some("Basic aW52YWxpZDpwYXNzd29yZA=="),
            ),
        ] {
            let (status, response) = post(connect().await, invalid, auth).await;
            assert_eq!(status, 401);
            assert_eq!(response["error"]["code"], "authentication_required");
        }
        let mut request = open();
        request["identity"] = json!({"username":"alice"});
        assert_eq!(post(connect().await, request.clone(), None).await.0, 401);
        let (status, result) = post(connect().await, request, Some(&auth)).await;
        assert_eq!(status, 200);
        let mut check = body("audit_check");
        check["audit_session_id"] = result["result"]["audit_session_id"].clone();
        check["service_epoch"] = result["result"]["service_epoch"].clone();
        check["identity"] = json!({"username":"bob"});
        assert_eq!(
            post(connect().await, check.clone(), Some(&auth)).await.0,
            403
        );
        check["identity"]["username"] = "alice".into();
        assert_eq!(post(connect().await, check, Some(&auth)).await.0, 200);
        task.await.unwrap();
        assert_eq!(
            sink.records.lock().unwrap()[0]["identity"],
            json!({"source":"https_assertion","credential_name":"distribution","username":"alice"})
        );
    }
    #[tokio::test]
    async fn rejects_pipelining_duplicate_lengths_and_transfer_coding() {
        for header in [
            "Content-Length: 2\r\nContent-Length: 2\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 2\r\n",
            "Content-Length: 2\r\n",
        ] {
            let (client, server) = tokio::io::duplex(4096);
            let mut server: Stream = Box::new(server);
            let mut client = client;
            let source = format!(
                "POST /v1/service HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header}\r\n{{}}EXTRA"
            );
            client.write_all(source.as_bytes()).await.unwrap();
            assert!(read_request(&mut server).await.is_err());
        }
    }
    #[tokio::test]
    async fn worker_slots_survive_disconnection_and_are_held_through_response_drain() {
        let runtime = runtime(unsafe { libc::geteuid() }, Arc::new(MemorySink::default()));
        let peer = Peer::Unix { uid: 1000, pid: 42 };
        let permit = runtime.connection(&peer).unwrap();
        let (admit_tx, admit_rx) = crossbeam_channel::bounded(1);
        let (release_tx, release_rx) = crossbeam_channel::bounded(1);
        let (tx, rx) = oneshot::channel();
        runtime
            .new_pool
            .sender
            .send(Job {
                work: Box::new(move || {
                    admit_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(json!({}))
                }),
                reply: tx,
                _connection: permit,
                _admission: None,
            })
            .unwrap();
        admit_rx.recv().unwrap();
        drop(rx);
        assert_eq!(runtime.quotas.lock().unwrap().total, 1);
        let (tx, rx) = oneshot::channel();
        let permit = runtime.connection(&peer).unwrap();
        runtime
            .event_pool
            .sender
            .send(Job {
                work: Box::new(|| Ok(json!({"independent":true}))),
                reply: tx,
                _connection: permit,
                _admission: None,
            })
            .unwrap();
        let completion = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.quotas.lock().unwrap().total, 2);
        drop(completion);
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.quotas.lock().unwrap().total != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
