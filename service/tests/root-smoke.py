#!/usr/bin/env python3
"""Real root and unprivileged HTTPS daemons in a private mount namespace, without host logs."""
import json
import base64
import hashlib
import pwd
import concurrent.futures
import ssl
import threading
import os
from pathlib import Path
import resource
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

binary = Path(sys.argv[1]).resolve()
repository = Path(sys.argv[2]).resolve()
if os.geteuid() != 0:
    raise SystemExit("root daemon qualification requires root")
subprocess.run(["mount", "--make-rprivate", "/"], check=True)
root = Path(tempfile.mkdtemp(prefix="pi-service-test-", dir="/run"))
os.chmod(root, 0o755)
child = None
sink = None
draining = None
mounts = []
pressure_clients = []
stress_stop = threading.Event()
syslog_target = os.path.realpath("/dev/log")
try:
    policy = (repository / "packaging/service/audit-only-policy.toml").read_text()
    policy = policy.replace("/etc/pi-sandbox-service/main/audit-only-models.json", str(root / "models.json"))
    (root / "policy.toml").write_text(policy)
    shutil.copyfile(repository / "packaging/service/audit-only-models.json", root / "models.json")
    password = os.urandom(32).hex()
    (root / "password").write_text(password)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        tls_port = reservation.getsockname()[1]
    manifest = root / "service.toml"
    manifest.write_text(f'''manifest_version = 1
[limits]
max_connections = 4096
max_connections_per_uid = 512
max_connections_per_ip = 4096
max_audit_sessions = 8192
max_audit_sessions_per_principal = 256
[[listeners]]
id = "qualified"
transport = "unix"
platform = "linux"
socket_path = "{root}/service.sock"
audit_facility = "local3"
policy_file = "{root}/policy.toml"
''')
    with manifest.open("a") as output:
        for index in range(14):
            output.write(f'\n[[listeners]]\nid = "extra_{index}"\ntransport = "unix"\nplatform = "linux"\nsocket_path = "{root}/extra-{index}.sock"\naudit_facility = "local3"\npolicy_file = "{root}/policy.toml"\n')
        output.write(f'\n[[listeners]]\nid = "https_pressure"\ntransport = "https"\nplatform = "linux"\nlisten_address = "127.0.0.1:{tls_port}"\naudit_facility = "local3"\npolicy_file = "{root}/policy.toml"\ncertificate_file = "{root}/cert.pem"\nprivate_key_file = "{root}/key.pem"\n[[listeners.credentials]]\nname = "qualification"\npassword_file = "{root}/password"\n')
    for path in root.iterdir():
        os.chmod(path, 0o600 if path.name in ("password", "key.pem") else 0o644)
    command = [str(binary), "--manifest", str(manifest)]
    subprocess.run([str(binary), "--validate", "--manifest", str(manifest)], check=True)
    def low_limit():
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
    limited = subprocess.run(command, preexec_fn=low_limit, capture_output=True)
    assert limited.returncode != 0, "daemon accepted insufficient file descriptor headroom"
    def logging_socket(name):
        value = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        value.bind(str(root / name))
        os.chmod(root / name, 0o666)
        value.settimeout(3)
        subprocess.run(["mount", "--bind", str(root / name), syslog_target], check=True)
        mounts.append(syslog_target)
        return value
    sink = logging_socket("syslog-one")
    log = open(root / "operations.log", "wb")
    def unit_limits():
        resource.setrlimit(resource.RLIMIT_NOFILE, (16384, 16384))
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd="/", preexec_fn=unit_limits)
    end = time.monotonic() + 5
    while not (root / "service.sock").exists():
        if child.poll() is not None or time.monotonic() > end:
            raise AssertionError("daemon did not start: " + (root / "operations.log").read_text())
        time.sleep(0.01)
    def request(operation, **fields):
        body = {"version": 1, "request_id": os.urandom(16).hex(), "operation": operation, **fields}
        data = json.dumps(body).encode()
        header = (f"POST /v1/service HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n").encode()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(str(root / "service.sock"))
            connection.sendall(header + data)
            response = b""
            while True:
                part = connection.recv(65536)
                if not part:
                    break
                response += part
        head, payload = response.split(b"\r\n\r\n", 1)
        return int(head.split()[1]), json.loads(payload)
    def record():
        raw = sink.recv(40960)
        assert raw.startswith(b"<158>pi-sandbox["), raw[:80]
        return json.loads(raw[raw.index(b"{"):])
    status, bootstrap = request("bootstrap", policy_schema=16, model_schema="pi-1.5.0", client={"platform":"linux","architecture":"x64","application_version":"qualification","build_id":"offline"})
    assert status == 200 and "models_file" not in bootstrap["result"]["policy"]
    client = os.urandom(16).hex()
    def open_session(generation):
        status, value = request("audit_open", client_instance_id=client, audit_generation=generation, pi_session_id="qualification", cwd="/", policy_origin={"source":"local"})
        assert status == 200, value
        return value["result"]
    session = open_session(1)
    started = record()
    assert started["identity"]["uid"] == 0 and started["identity"]["pid"] == os.getpid()
    assert started["policy_origin"] == {"source":"local"}
    status, _ = request("audit_event", audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"], sequence=1, event={"event":"tool_requested","pi_session_id":"qualification","invocation_id":"one","tool":"write","boundary":"seatbelt"})
    assert status == 200 and record()["sequence"] == 1
    sink.close()
    status, failure = request("audit_event", audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"], sequence=2, event={"event":"tool_execution_intent","pi_session_id":"qualification","invocation_id":"one","tool":"write","boundary":"seatbelt","approval_source":"policy"})
    assert status == 503 and failure["error"]["code"] == "audit_unavailable"
    sink = logging_socket("syslog-two")
    recovered = open_session(2)
    assert recovered["audit_session_id"] != session["audit_session_id"] and record()["audit_generation"] == 2
    status, _ = request("audit_check", audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"])
    assert status == 410
    status, _ = request("audit_close", audit_session_id=recovered["audit_session_id"], service_epoch=recovered["service_epoch"], sequence=1)
    assert status == 200 and record()["event"]["event"] == "session_ended"
    def qualify_live_installer():
        account = pwd.getpwnam("nobody")
        assert account.pw_uid > 0
        release = root / "root-only-unpack"
        release.mkdir(mode=0o700)
        payload = release / "payload/pi-sandbox"
        (payload / "skills/review").mkdir(parents=True)
        (payload / "skills/review/SKILL.md").write_text("# Test shared skill\n")
        (payload / "skills-modes.txt").write_text("0644 skills/review/SKILL.md\n")
        (payload / "tools/bin").mkdir(parents=True)
        (payload / "tools/bin/fd").write_text("#!/bin/sh\nexit 0\n")
        (payload / "tools/bin/fd").chmod(0o755)
        for name in ("release-manifest.json", "sbom.cdx.json"):
            (payload / name).write_text("{}\n")
        architecture = "x64" if os.uname().machine == "x86_64" else "arm64"
        candidate = payload / "pi-sandbox"
        candidate.write_text(f'''#!/bin/sh
set -eu
case "$1" in
 --print-build-capabilities) echo '{{"configuration_source":"service","architecture":"{architecture}","platform":"linux"}}'; exit 0 ;;
 --validate-service)
   [ "$(id -u)" = "{account.pw_uid}" ]
   [ "$(pwd -P)" = / ]
   [ -z "${{PI_SANDBOX_INSTALL_TEST_SECRET:-}}" ]
   [ "$2" = --candidate-payload ]
   [ "$(dirname "$0")" = "$3" ]
   [ "$(stat -c %u "$3")" = 0 ]
   [ -x "$3/skills/review" ]
   [ -r "$3/skills/review/SKILL.md" ]
   [ ! -e "$3/reject-validation" ]
   echo '{{"status":"valid","policy_schema":16}}' ;;
 *) exit 98 ;;
esac
''')
        candidate.chmod(0o755)
        installation = root / "client-install"
        script = (repository / "scripts/install/install.sh").read_text()
        script = script.replace("configuration_source=local", "configuration_source=service")
        script = script.replace("expected_arch=x64", f"expected_arch={architecture}")
        script = script.replace("bundled_commands=''", "bundled_commands='fd'")
        script = script.replace("/usr/libexec/pi-sandbox", str(installation / "usr/libexec/pi-sandbox"))
        script = script.replace("/usr/bin/pi-sandbox", str(installation / "usr/bin/pi-sandbox"))
        installer = release / "install.sh"
        installer.write_text(script)
        installer.chmod(0o755)
        def sums():
            (release / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(release)}\n" for path in sorted(payload.rglob("*")) if path.is_file()))
        sums()
        environment = dict(os.environ, PI_SANDBOX_INSTALL_TEST_SECRET="must-not-reach-candidate")
        environment.pop("DESTDIR", None)
        installed = subprocess.run([str(installer), "--validation-user", account.pw_name], env=environment, capture_output=True, text=True)
        assert installed.returncode == 0, installed.stderr
        published = installation / "usr/libexec/pi-sandbox/pi-sandbox"
        original = published.read_bytes()
        (payload / "reject-validation").write_text("reject\n")
        sums()
        rejected = subprocess.run([str(installer), "--validation-user", account.pw_name], env=environment, capture_output=True, text=True)
        assert rejected.returncode != 0
        assert published.read_bytes() == original
        assert not (published.parent / "reject-validation").exists()
        assert not list(published.parent.parent.glob(".pi-sandbox.staging.*"))
    def drain():
        while not stress_stop.is_set():
            try:
                sink.recv(40960)
            except socket.timeout:
                continue
    context = ssl.create_default_context(cafile=str(root / "cert.pem"))
    authorization = base64.b64encode(f"qualification:{password}".encode()).decode()
    def https_request(operation, username, *, port=tls_port, **fields):
        body = json.dumps({"version":1,"request_id":os.urandom(16).hex(),"operation":operation,"identity":{"username":username},**fields}).encode()
        headers = (f"POST /v1/service HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nAuthorization: Basic {authorization}\r\nConnection: close\r\n\r\n").encode()
        with socket.create_connection(("127.0.0.1", port), timeout=10) as tcp:
            with context.wrap_socket(tcp, server_hostname="localhost") as connection:
                connection.sendall(headers + body)
                response = b""
                while True:
                    part = connection.recv(65536)
                    if not part:
                        break
                    response += part
        head, payload = response.split(b"\r\n\r\n",1)
        return int(head.split()[1]), json.loads(payload)
    def qualify_unprivileged_https():
        owner = 31000
        home = root / "https-owner"
        home.mkdir(mode=0o700)
        executable = home / "pi-sandbox-service"
        shutil.copyfile(binary, executable)
        executable.chmod(0o755)
        for name in ("models.json", "cert.pem", "key.pem", "password"):
            shutil.copyfile(root / name, home / name)
            (home / name).chmod(0o600 if name in ("key.pem", "password") else 0o644)
        (home / "policy.toml").write_text(policy.replace(str(root / "models.json"), str(home / "models.json")))
        (home / "rules/users.d").mkdir(parents=True)
        (home / "rules/users.d/alice.toml").write_text('version = 12\nuser = "alice"\n[environment.pi]\nQUALIFIED = { file = "' + str(home / "secret") + '" }\n')
        (home / "rules/users.d/alice.toml").chmod(0o600)
        (home / "secret").write_text("unprivileged-secret\n")
        (home / "secret").chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        https = f'''[[listeners]]
id = "user_https"
transport = "https"
platform = "linux"
listen_address = "127.0.0.1:{port}"
audit_facility = "local3"
policy_file = "{home}/policy.toml"
rule_directory = "{home}/rules"
certificate_file = "{home}/cert.pem"
private_key_file = "{home}/key.pem"
[[listeners.credentials]]
name = "qualification"
password_file = "{home}/password"
'''
        unix = f'''[[listeners]]
id = "forbidden_unix"
transport = "unix"
platform = "linux"
socket_path = "{home}/forbidden.sock"
audit_facility = "local3"
policy_file = "{home}/missing-policy.toml"
'''
        prefix = "manifest_version = 1\n"
        selected = home / "service.toml"
        selected.write_text(prefix + https)
        for path in [home, *home.rglob("*")]:
            os.chown(path, owner, owner)
            if path.is_dir():
                path.chmod(0o700)
            elif path != executable:
                path.chmod(0o600 if path.name in ("password", "key.pem", "secret", "alice.toml") else 0o644)
        def as_owner():
            unit_limits()
            os.setgroups([])
            os.setgid(owner)
            os.setuid(owner)
        def run_service(validate=False, privileged=False):
            return subprocess.run([str(executable), *(["--validate"] if validate else []), "--manifest", str(selected)], cwd="/", preexec_fn=unit_limits if privileged else as_owner, capture_output=True, timeout=10)
        assert run_service(validate=True).returncode == 0, "non-root HTTPS validation failed"
        # Missing HTTPS material and an occupied port make any pre-admission
        # material read or bind fail differently from the required admission error.
        unavailable_https = https
        for name in ("cert.pem", "key.pem", "password"):
            unavailable_https = unavailable_https.replace(f'{home}/{name}"', f'{home}/missing-{name}"')
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", port))
            occupied.listen()
            for listeners in (unix, unavailable_https + unix, unix + unavailable_https):
                selected.write_text(prefix + listeners)
                for validate in (True, False):
                    denied = run_service(validate)
                    assert denied.returncode != 0 and b"not admitted" in denied.stderr, denied.stderr
                    assert b"Unix listeners require root" in denied.stderr, denied.stderr
                    assert not (home / "forbidden.sock").exists()
        selected.write_text(prefix + https)
        def rejected_configuration():
            for validate in (True, False):
                rejected = run_service(validate)
                assert rejected.returncode != 0 and b"configuration" in rejected.stderr, rejected.stderr
        # Every protected input uses the process owner, including rules and catalogs.
        for path in (selected, home / "policy.toml", home / "models.json", home / "rules/users.d/alice.toml", home / "password", home / "key.pem", home / "cert.pem"):
            os.chown(path, 0, 0)
            try:
                # Startup reads policy/rules/catalog lazily; offline validation checks all.
                rejected = run_service(validate=True)
                assert rejected.returncode != 0, path
            finally:
                os.chown(path, owner, owner)
        for path, bad_mode in ((selected, 0o664), (home / "key.pem", 0o644), (home / "password", 0o644), (home, 0o770)):
            original = path.stat().st_mode & 0o777
            path.chmod(bad_mode)
            try:
                rejected_configuration()
            finally:
                path.chmod(original)
        alias = root / "https-owner-alias"
        alias.symlink_to(home, target_is_directory=True)
        selected.write_text(prefix + https.replace(str(home), str(alias)))
        rejected_configuration()
        selected.write_text(prefix + https)
        for validate in (True, False):
            assert run_service(validate, privileged=True).returncode != 0, "root accepted user-owned inputs"
        # A root-owned leaf still cannot authorize root to trust a user-owned parent.
        os.chown(selected, 0, 0)
        try:
            assert run_service(validate=True, privileged=True).returncode != 0
        finally:
            os.chown(selected, owner, owner)
        with open(home / "operations.log", "wb") as output:
            process = subprocess.Popen([str(executable), "--manifest", str(selected)], cwd="/", preexec_fn=as_owner, stdin=subprocess.DEVNULL, stdout=output, stderr=output)
            try:
                end = time.monotonic() + 5
                while True:
                    try:
                        status, response = https_request("bootstrap", "alice", port=port, policy_schema=16, model_schema="pi-1.5.0", client={"platform":"linux","architecture":"x64","application_version":"qualification","build_id":"offline"})
                        break
                    except ConnectionRefusedError:
                        if process.poll() is not None or time.monotonic() > end:
                            raise AssertionError("unprivileged daemon did not start: " + (home / "operations.log").read_text())
                        time.sleep(0.01)
                assert status == 200, response
                assert response["result"]["environment"]["pi"]["QUALIFIED"] == {"literal":"unprivileged-secret"}, response
                for path in (home / "policy.toml", home / "models.json", home / "rules/users.d/alice.toml"):
                    os.chown(path, 0, 0)
                    try:
                        status, response = https_request("bootstrap", "alice", port=port, policy_schema=16, model_schema="pi-1.5.0", client={"platform":"linux","architecture":"x64","application_version":"qualification","build_id":"offline"})
                        assert status == 503 and response["error"]["code"] == "configuration_unavailable", response
                    finally:
                        os.chown(path, owner, owner)
                status, response = https_request("audit_open", "alice", port=port, client_instance_id=os.urandom(16).hex(), audit_generation=1, pi_session_id="unprivileged", cwd=str(home), policy_origin={"source":"local"})
                assert status == 200, response
                session = response["result"]
                assert record()["identity"] == {"source":"https_assertion", "credential_name":"qualification", "username":"alice"}
                status, response = https_request("audit_event", "alice", port=port, audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"], sequence=1, event={"event":"tool_execution_intent","pi_session_id":"unprivileged","invocation_id":"one","tool":"write","boundary":"direct","approval_source":"policy"})
                assert status == 200 and record()["sequence"] == 1, response
                # Loss of syslog write permission must still fail the audit gate.
                (root / "syslog-two").chmod(0o600)
                try:
                    status, response = https_request("audit_event", "alice", port=port, audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"], sequence=2, event={"event":"tool_requested","pi_session_id":"unprivileged","invocation_id":"two","tool":"write","boundary":"direct"})
                    assert status == 503 and response["error"]["code"] == "audit_unavailable", response
                finally:
                    (root / "syslog-two").chmod(0o666)
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        print("Unprivileged HTTPS daemon qualification passed: bootstrap, rules/secrets, audit, ownership and Unix/mixed denial")
    qualify_unprivileged_https()
    qualify_live_installer()
    # Exercise supported maximum session capacity through real HTTPS and syslog.
    sink.settimeout(0.1)
    draining = threading.Thread(target=drain, daemon=True)
    draining.start()
    def populate(principal):
        username = f"pressure-{principal}"
        first = None
        for sequence in range(256):
            status, response = https_request("audit_open", username, client_instance_id=os.urandom(16).hex(), audit_generation=1, pi_session_id="s"*256, cwd="/", policy_origin={"source":"local"})
            assert status == 200, response
            if first is None:
                first = response["result"]
        return username, first
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as clients:
        sessions = list(clients.map(populate, range(32)))
    for username, session in sessions:
        status, response = https_request("audit_check", username, audit_session_id=session["audit_session_id"], service_epoch=session["service_epoch"])
        assert status == 200, response
    # Eight distinct real kernel UIDs each hold the per-UID maximum. No request
    # body is sent, so synthetic pressure UIDs need no host account records.
    base_descriptors = len(list(Path(f"/proc/{child.pid}/fd").iterdir()))
    pressure_code = """import os,socket,sys
sockets=[]
for index in range(512):
    connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    connection.settimeout(3)
    connection.connect(sys.argv[1]); sockets.append(connection)
print('ready',flush=True)
sys.stdin.read(1)
"""
    for index in range(8):
        def identity(uid=30000+index):
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
        pressure_clients.append(subprocess.Popen([sys.executable,"-c",pressure_code,str(root/"service.sock")],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=identity,text=True))
    for pressure in pressure_clients:
        assert pressure.stdout.readline().strip() == "ready", pressure.stderr.read()
    # connect() may complete while sockets are still queued in the listen backlog.
    acceptance_deadline = time.monotonic() + 3
    while len(list(Path(f"/proc/{child.pid}/fd").iterdir())) < base_descriptors + 4096 and time.monotonic() < acceptance_deadline:
        time.sleep(0.01)
    memory = {line.split(":",1)[0]:line.split(":",1)[1].strip() for line in Path(f"/proc/{child.pid}/status").read_text().splitlines() if line.startswith(("VmHWM:","Threads:"))}
    memory["file_descriptors"] = len(list(Path(f"/proc/{child.pid}/fd").iterdir()))
    assert base_descriptors + 4096 <= memory["file_descriptors"] < 16384, memory
    assert int(memory["Threads"]) <= 64, memory
    assert int(memory["VmHWM"].split()[0]) < 4*1024*1024, memory
    memory.update({"audit_sessions":8192,"listeners":16,"connections":4096})
    print("Root daemon maximum-capacity qualification passed: " + json.dumps(memory, sort_keys=True))

finally:
    stress_stop.set()
    for pressure in pressure_clients:
        if pressure.poll() is None:
            pressure.communicate("x",timeout=5)
    if child is not None and child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    if draining is not None:
        draining.join(timeout=1)
    if sink is not None:
        sink.close()
    for target in reversed(mounts):
        subprocess.run(["umount", target], check=True)
    shutil.rmtree(root)
