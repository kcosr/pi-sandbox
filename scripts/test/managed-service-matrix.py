#!/usr/bin/env python3
"""Offline compiled-client qualification; Linux uses the real root daemon.

Invoked only by verify:release. The Linux caller supplies a fresh mount namespace.
No host service, account database, policy, credential, or log destination is changed.
"""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
import uuid

plan_path = Path(sys.argv[1])
assert plan_path.is_absolute() and not plan_path.is_symlink()
assert plan_path.stat().st_size < 1024 * 1024
plan = json.loads(plan_path.read_text())
assert plan["version"] == 1 and re.fullmatch(r"[0-9a-f]{32}", plan["runId"])
linux = plan["platform"] == "linux"
assert plan["platform"] == ("linux" if sys.platform.startswith("linux") else "darwin")
root = Path(plan["runtimeRoot"])
if linux:
    assert os.geteuid() == 0, "Linux release qualification requires sudo and mount namespaces"
    assert root == Path("/run/pi-sandbox-verify") / plan["runId"]
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    parent = root.parent
    if not parent.exists():
        parent.mkdir(mode=0o755)
    metadata = parent.lstat()
    assert stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_mode & 0o022 == 0
    account = pwd.getpwnam("nobody")
else:
    assert os.geteuid() != 0, "macOS client qualification must run as an ordinary account"
    assert root == plan_path.parent / "runtime"
    account = pwd.getpwuid(os.geteuid())
assert account.pw_uid > 0 and 0 <= account.pw_gid <= 0xffffffff
assert re.fullmatch(r"[^\s:\x00-\x1f]+", account.pw_name)
root.mkdir(mode=0o755)
children = []
mounts = []
records = []
record_lock = threading.Lock()
provider_calls = []
provider_errors = []
daemon = None
sink = None
sink_stop = None
sink_thread = None
mock_service = None
mock_handles = {}
mock_epoch = uuid.uuid4().hex
mock_audit_enabled = True
mock_requests = 0
sink_number = 0
syslog_target = os.path.realpath("/dev/log") if linux else None


def protected_file(path, data, mode=0o644):
    path = Path(path)
    assert path.is_relative_to(root) and not path.is_symlink()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if isinstance(data, str):
        data = data.encode()
    path.write_bytes(data)
    path.chmod(mode)


def owned_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if linux:
        os.chown(path, account.pw_uid, account.pw_gid)
    path.chmod(0o700)


def safe_tree(path):
    assert path.is_absolute() and path.is_dir() and not path.is_symlink()
    for directory, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            entry = Path(directory) / name
            kind = entry.lstat().st_mode
            assert stat.S_ISDIR(kind) or stat.S_ISREG(kind), f"Nonregular fixture input {entry}"


def stop_sink():
    global sink, sink_stop, sink_thread, mock_audit_enabled
    mock_audit_enabled = False
    if sink_stop is not None:
        sink_stop.set()
    if sink is not None:
        sink.close()
    if sink_thread is not None:
        sink_thread.join(timeout=2)
    sink = sink_stop = sink_thread = None


def start_sink():
    global sink, sink_stop, sink_thread, sink_number, mock_audit_enabled
    mock_audit_enabled = True
    if not linux:
        return
    sink_number += 1
    current = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    current.bind(str(root / f"syslog-{sink_number}"))
    current.settimeout(0.1)
    subprocess.run(["mount", "--bind", str(root / f"syslog-{sink_number}"), syslog_target], check=True)
    mounts.append(syslog_target)
    stopped = threading.Event()

    def collect():
        while not stopped.is_set():
            try:
                value = current.recv(65536)
                decoded = json.loads(value[value.index(b"{"):])
                with record_lock:
                    records.append(decoded)
            except socket.timeout:
                pass
            except OSError:
                break
            except Exception as error:
                provider_errors.append(f"Invalid audit record: {error}")
    sink, sink_stop = current, stopped
    sink_thread = threading.Thread(target=collect, daemon=True)
    sink_thread.start()


def stop_daemon():
    global daemon
    if daemon is not None:
        daemon.terminate()
        try:
            daemon.wait(timeout=8)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait(timeout=3)
        daemon = None


def start_daemon():
    global daemon, mock_epoch
    if not linux:
        mock_handles.clear()
        mock_epoch = uuid.uuid4().hex
        return
    path = root / "service.sock"
    if path.exists():
        path.unlink()
    with (root / "service.log").open("ab") as output:
        daemon = subprocess.Popen([str(root / "pi-sandbox-service"), "--manifest", str(root / "service.toml")], cwd="/", env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}, stdin=subprocess.DEVNULL, stdout=output, stderr=output)
    deadline = time.monotonic() + 10
    while not path.exists():
        assert daemon.poll() is None and time.monotonic() < deadline, (root / "service.log").read_text()
        time.sleep(0.02)
    # A TLS listener may activate just after the Unix listener.
    while True:
        try:
            with socket.create_connection(("127.0.0.1", plan["port"]), timeout=1):
                return
        except OSError:
            assert daemon.poll() is None and time.monotonic() < deadline
            time.sleep(0.02)


class Provider(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            assert self.path == "/v1/chat/completions"
            size = int(self.headers["Content-Length"])
            assert 0 < size <= 1024 * 1024
            value = json.loads(self.rfile.read(size))
            assert self.headers["Authorization"] == "Bearer managed-fixture-token"
            assert self.headers["X-Fixture-User"] == account.pw_name
            provider_calls.append(value)
            messages = value["messages"]
            prompt = str(next(message.get("content", "") for message in reversed(messages) if message["role"] == "user"))
            already_executed = messages[-1]["role"] == "tool"
            calls = []
            if not already_executed and "OUTAGE_TOOL" in prompt:
                stop_sink()
                calls = [("write", {"path": "must-not-exist.txt", "content": "unaudited"})]
            elif not already_executed and "WRITE_OK" in prompt:
                # Direct mode retains the original caller environment, but must
                # never receive the administrative Pi-scoped credential value.
                calls = [("bash", {"command": 'test "${FIXTURE_TOKEN-}" != "managed-fixture-token" && printf "once\\n" >> count.txt'})]
            elif not already_executed and "READ_POLICY" in prompt:
                calls = [("read", {"path": "count.txt"})]
            elif not already_executed and "PARALLEL" in prompt:
                for side, peer in [("left", "right"), ("right", "left")]:
                    command = f"printf ready > {side}; for attempt in {{1..400}}; do test -f {peer} && break; sleep 0.01; done; test -f {peer} || exit 71; printf {side}-ok"
                    calls.append(("bash", {"command": command}))
            if calls:
                offered = {tool.get("function", tool.get("custom", {})).get("name") for tool in value["tools"]}
                assert all(name in offered for name, _ in calls)
                assert "powershell" not in offered
                delta = {"role": "assistant", "tool_calls": [{"index": index, "id": f"fixture-{len(provider_calls)}-{index}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}} for index, (name, arguments) in enumerate(calls)]}
                finish = "tool_calls"
            else:
                delta, finish = {"role": "assistant", "content": "OFFLINE_MATRIX_OK"}, "stop"
            chunks = []
            for data, reason in [(delta, None), ({}, finish)]:
                chunks.append("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "offline", "choices": [{"index": 0, "delta": data, "finish_reason": reason}]}) + "\n\n")
            payload = ("".join(chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            provider_errors.append(str(error))
            self.send_error(500)


class MacService(http.server.BaseHTTPRequestHandler):
    """Client protocol fixture only; Linux always exercises the real daemon."""
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        global mock_requests
        mock_requests += 1
        request = {}
        status, result = 200, None
        error = None
        try:
            assert self.path == "/v1/service"
            size = int(self.headers["Content-Length"])
            assert 0 < size <= 32768
            request = json.loads(self.rfile.read(size))
            expected = "Basic " + base64.b64encode(b"fixture:" + password).decode()
            if self.headers.get("Authorization") != expected:
                status, error = 401, "authentication_required"
            else:
                assert request["identity"]["username"] == account.pw_name
                assert re.fullmatch(r"[0-9A-Fa-f-]{36}", request["identity"]["machine_id"])
                operation = request["operation"]
                if operation == "bootstrap":
                    result = {"policy": plan["policyObject"], "overrides": {"tools": {"read": {"mode": "deny", "session_grant": "never"}}}, "environment": {"pi": {"FIXTURE_TOKEN": "managed-fixture-token", "FIXTURE_USER": "{{username}}"}, "sandbox": {}, "extensions": {}}, "models": json.loads((root / "models.json").read_text()), "policy_revision": "a" * 32}
                elif operation == "policy_inspect":
                    result = {"policy": plan["policyObject"], "workspace_overrides": None}
                elif operation == "audit_open":
                    if not mock_audit_enabled:
                        status, error = 503, "audit_unavailable"
                    else:
                        result = {"audit_session_id": uuid.uuid4().hex, "service_epoch": mock_epoch, "audit_generation": request["audit_generation"], "next_sequence": 1}
                        mock_handles[result["audit_session_id"]] = dict(result, session=request["pi_session_id"])
                else:
                    handle = mock_handles.get(request["audit_session_id"])
                    if handle is None or request["service_epoch"] != mock_epoch:
                        status, error = 410, "unknown_audit_session"
                    elif operation == "audit_check":
                        result = {key: handle[key] for key in ["audit_session_id", "service_epoch", "audit_generation"]}
                    elif not mock_audit_enabled:
                        mock_handles.pop(request["audit_session_id"], None)
                        status, error = 503, "audit_unavailable"
                    else:
                        assert request["sequence"] == handle["next_sequence"]
                        handle["next_sequence"] += 1
                        result = {key: handle[key] for key in ["audit_session_id", "service_epoch", "audit_generation", "next_sequence"]}
                        if operation == "audit_close":
                            result["closed"] = True
                            mock_handles.pop(request["audit_session_id"], None)
                        else:
                            records.append({"event": request["event"], "audit_generation": handle["audit_generation"]})
        except Exception as failure:
            provider_errors.append(str(failure))
            status, error = 400, "invalid_request"
        payload = {"version": 1, "request_id": request.get("request_id")}
        if error:
            payload["error"] = {"code": error, "message": error}
        else:
            payload.update(operation=request["operation"], result=result)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True


class Client:
    def __init__(self, fixture):
        self.fixture = fixture
        self.directory = Path(fixture["installation"])
        self.workspace = self.directory / "workspace"
        self.state = self.directory / "state"
        self.payload = Path(fixture["payload"])
        launcher = fixture.get("bundleLauncher")
        self.executable = Path(launcher["link"]) if launcher else self.payload / "pi-sandbox"
        self.env = {"PATH": str(root / "test-bin") + ":" + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.directory / "fake-home"), "PI_CODING_AGENT_DIR": str(self.state), "FIXTURE_TOKEN": "ambient-must-not-win", "FIXTURE_USER": "forged", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        self.prefix = ["/usr/bin/setpriv", f"--reuid={account.pw_uid}", f"--regid={account.pw_gid}", "--clear-groups", "--"] if linux else []
        self.configuration = ["--config", str(self.directory / "config/selected.toml")] if fixture["name"] == "audit-local" else []
        self.child = None
        self.messages = []
        self.stderr = []

    def command(self, args, expect_success=True, configured=True):
        value = subprocess.run(self.prefix + [str(self.executable)] + (self.configuration if configured else []) + args, cwd=self.workspace, env=self.env, capture_output=True, text=True, timeout=30)
        if expect_success:
            assert value.returncode == 0, f"{self.fixture['name']} {args}: {value.stderr} {value.stdout}"
        else:
            assert value.returncode != 0, f"Unexpected success: {args}"
        return value

    def start(self):
        self.child = subprocess.Popen(self.prefix + [str(self.executable)] + self.configuration + ["--mode", "rpc", "--no-session", "--provider", "fixture", "--model", "offline"], cwd=self.workspace, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        children.append(self.child)

        def output():
            for line in self.child.stdout:
                try:
                    self.messages.append(json.loads(line))
                except Exception:
                    provider_errors.append("Non-JSON RPC stdout: " + line)
        threading.Thread(target=output, daemon=True).start()
        threading.Thread(target=lambda: self.stderr.extend(self.child.stderr), daemon=True).start()
        result = self.rpc("get_available_models")
        assert result["success"], result
        assert "offline" in json.dumps(result) and "decoy" not in json.dumps(result)

    def wait(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            match = next((message for message in self.messages if predicate(message)), None)
            if match is not None:
                return match
            assert self.child.poll() is None, "Pi exited: " + "".join(self.stderr)
            assert time.monotonic() < deadline, "RPC timed out: " + "".join(self.stderr) + json.dumps(self.messages[-8:])
            time.sleep(0.01)

    def send(self, command):
        self.child.stdin.write(json.dumps(command) + "\n")
        self.child.stdin.flush()

    def rpc(self, kind, **fields):
        identifier = uuid.uuid4().hex
        self.send({"id": identifier, "type": kind, **fields})
        return self.wait(lambda message: message.get("type") == "response" and message.get("id") == identifier)

    def prompt(self, text, admitted=True):
        count = sum(message.get("type") == "agent_end" for message in self.messages)
        response = self.rpc("prompt", message=text)
        assert response["success"] == admitted, response
        if admitted:
            deadline = time.monotonic() + 45
            while sum(message.get("type") == "agent_end" for message in self.messages) <= count:
                assert self.child.poll() is None and time.monotonic() < deadline, "Turn failed: " + "".join(self.stderr) + json.dumps(self.messages[-8:])
                time.sleep(0.01)

    def stop(self):
        if self.child is not None and self.child.poll() is None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=3)
            assert self.child.returncode == 0, "".join(self.stderr)


provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
provider.daemon_threads = True
threading.Thread(target=provider.serve_forever, daemon=True).start()
password = Path(plan["passwordFile"]).read_bytes()
assert len(password) == 64
try:
    # This matrix exercises Bash/read/write, not find. Keep its unused finder
    # prerequisite explicit, as in the existing packaged smoke. Any accidental
    # finder invocation fails; real finder behavior has its separate tool suites.
    protected_file(root / "test-bin/fd", "#!/bin/sh\necho 'unexpected finder invocation in service matrix' >&2\nexit 71\n", 0o755)
    production = Path(plan["productionPayload"])
    safe_tree(production)
    public_root_probe = Path(plan["publicRootProbe"]["executable"])
    assert public_root_probe.parent == plan_path.parent and stat.S_ISREG(public_root_probe.lstat().st_mode)
    assert hashlib.sha256(public_root_probe.read_bytes()).hexdigest() == plan["publicRootProbe"]["sha256"]
    protected_file(root / "public-root-probe", public_root_probe.read_bytes(), 0o755)
    for fixture in plan["fixtures"]:
        assert fixture["name"] in ["fixed-local", "audit-local", "service-unix", "service-https"]
        installation = Path(fixture["installation"])
        assert installation == root / fixture["name"]
        binary = Path(fixture["executable"])
        assert binary.parent == plan_path.parent and stat.S_ISREG(binary.lstat().st_mode)
        assert hashlib.sha256(binary.read_bytes()).hexdigest() == fixture["sha256"]
        payload = Path(fixture["payload"])
        launcher = fixture.get("bundleLauncher")
        if launcher:
            assert not linux and fixture["name"] == "service-https"
            assert payload.resolve().is_relative_to(installation.resolve())
            assert Path(launcher["target"]).resolve().is_relative_to(installation.resolve())
            assert Path(launcher["link"]) == installation / "bin/pi-sandbox"
        else:
            assert payload == installation / "payload"
        shutil.copytree(production, payload)
        shutil.copyfile(binary, payload / "pi-sandbox")
        if launcher:
            source = Path(launcher["source"])
            target = Path(launcher["target"])
            link = Path(launcher["link"])
            assert stat.S_ISREG(source.lstat().st_mode)
            target.parent.mkdir(parents=True)
            shutil.copy2(source, target)
            link.parent.mkdir(parents=True)
            link.symlink_to(target)
        for directory, dirs, files in os.walk(payload):
            Path(directory).chmod(0o755)
            for name in files:
                path = Path(directory) / name
                path.chmod(0o755 if path.stat().st_mode & 0o111 or name == "pi-sandbox" else 0o644)
        for name in ["workspace", "state", "fake-home"]:
            owned_directory(Path(fixture["installation"]) / name)
        # User-managed model and credential files cannot replace the captured catalog/key.
        state = Path(fixture["installation"]) / "state"
        for name, value in [("models.json", {"providers": {"decoy": {"baseUrl": "http://127.0.0.1:1", "models": [{"id": "decoy"}]}}}), ("auth.json", {"fixture": {"type": "api_key", "key": "unadmitted-personal-key"}})]:
            (state / name).write_text(json.dumps(value))
            if linux:
                os.chown(state / name, account.pw_uid, account.pw_gid)
            (state / name).chmod(0o600)
        if fixture["name"] in ["fixed-local", "audit-local"]:
            text = plan["policyText"]
            if fixture["name"] == "fixed-local":
                text = text.replace("[audit]\nenabled = true", "[audit]\nenabled = false")
            config_directory = Path(fixture["installation"]) / "config"
            if fixture["name"] == "audit-local":
                protected_file(config_directory / "selected.toml", text)
                protected_file(config_directory / "config.toml", "invalid default TOML")
            else:
                protected_file(config_directory / "config.toml", text)
    models = {"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions", "apiKey": "$FIXTURE_TOKEN", "headers": {"X-Fixture-User": "$FIXTURE_USER"}, "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False}, "models": [{"id": "offline", "name": "Offline service fixture", "reasoning": False, "input": ["text"], "contextWindow": 32768, "maxTokens": 8192, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}
    protected_file(root / "models.json", json.dumps(models))
    protected_file(root / "policy.toml", plan["policyText"])
    protected_file(root / "password", password, 0o600)
    protected_file(root / "certificate.pem", Path(plan["certificate"]).read_bytes())
    protected_file(root / "key.pem", Path(plan["key"]).read_bytes(), 0o600)
    if linux:
        service_binary = Path(plan["serviceBinary"])
        assert service_binary.is_absolute() and stat.S_ISREG(service_binary.lstat().st_mode)
        protected_file(root / "pi-sandbox-service", service_binary.read_bytes(), 0o755)
        manifest = f'''manifest_version = 1
[[listeners]]
id = "unix_fixture"
transport = "unix"
platform = "linux"
socket_path = "{root}/service.sock"
audit_facility = "local3"
policy_file = "{root}/policy.toml"
rule_directory = "{root}/rules"
[[listeners]]
id = "https_fixture"
transport = "https"
platform = "linux"
listen_address = "127.0.0.1:{plan['port']}"
audit_facility = "local3"
policy_file = "{root}/policy.toml"
rule_directory = "{root}/rules"
certificate_file = "{root}/certificate.pem"
private_key_file = "{root}/key.pem"
[[listeners.credentials]]
name = "fixture"
password_file = "{root}/password"
'''
        protected_file(root / "rules/users.d/fixture.toml", f'version = 12\nuser = "{account.pw_name}"\n[overrides.tools.read]\nmode = "deny"\nsession_grant = "never"\n', 0o600)
        protected_file(root / "service.toml", manifest)
        subprocess.run([str(root / "pi-sandbox-service"), "--validate", "--manifest", str(root / "service.toml")], check=True, cwd="/")
    else:
        mock_service = http.server.ThreadingHTTPServer(("127.0.0.1", plan["port"]), MacService)
        mock_service.daemon_threads = True
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(root / "certificate.pem"), str(root / "key.pem"))
        mock_service.socket = tls.wrap_socket(mock_service.socket, server_side=True)
        threading.Thread(target=mock_service.serve_forever, daemon=True).start()
    start_sink()
    start_daemon()
    for fixture in plan["fixtures"]:
        client = Client(fixture)
        service_source = fixture["name"].startswith("service-")
        enabled = fixture["name"] != "fixed-local"
        capabilities = json.loads(client.command(["--print-build-capabilities"]).stdout)
        assert capabilities["configuration_source"] == ("service" if service_source else "local")
        client.command(["--version"])
        if service_source:
            saved_environment = dict(client.env)
            client.env.update({"HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "NODE_USE_ENV_PROXY": "1"})
            try:
                client.command(["--list-workspace-modes"])
            finally:
                client.env = saved_environment
        if fixture["name"] == "service-https":
            # The positive custom-CA request above proves this endpoint is live;
            # the same certificate must not enter the default public trust set
            # through runtime environment, even with TLS verification disabled.
            trust_environment = dict(client.env, NODE_EXTRA_CA_CERTS=str(root / "certificate.pem"), SSL_CERT_FILE=str(root / "certificate.pem"), NODE_TLS_REJECT_UNAUTHORIZED="0")
            subprocess.run(client.prefix + [str(root / "public-root-probe")], cwd=client.workspace, env=trust_environment, check=True, timeout=30)
            rogue_certificate, rogue_key = root / "rogue-cert.pem", root / "rogue-key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(rogue_key), "-out", str(rogue_certificate), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            rogue_key.chmod(0o600)
            saved_certificate, saved_key = (root / "certificate.pem").read_bytes(), (root / "key.pem").read_bytes()
            if linux:
                stop_daemon()
                protected_file(root / "certificate.pem", rogue_certificate.read_bytes())
                protected_file(root / "key.pem", rogue_key.read_bytes(), 0o600)
                start_daemon()
            else:
                mock_service.socket.context.load_cert_chain(str(rogue_certificate), str(rogue_key))
            saved_environment = dict(client.env)
            client.env.update({"NODE_TLS_REJECT_UNAUTHORIZED": "0", "NODE_EXTRA_CA_CERTS": str(rogue_certificate), "SSL_CERT_FILE": str(rogue_certificate)})
            try:
                client.command(["--list-workspace-modes"], expect_success=False)
            finally:
                client.env = saved_environment
                if linux:
                    stop_daemon()
                    protected_file(root / "certificate.pem", saved_certificate)
                    protected_file(root / "key.pem", saved_key, 0o600)
                    start_daemon()
                else:
                    mock_service.socket.context.load_cert_chain(str(root / "certificate.pem"), str(root / "key.pem"))
            saved_password = password
            password = b"x" * 64
            if linux:
                stop_daemon()
                protected_file(root / "password", password, 0o600)
                start_daemon()
            try:
                result = client.command(["--list-workspace-modes"], expect_success=False)
                assert "authentication" in result.stderr.lower(), result.stderr
            finally:
                password = saved_password
                if linux:
                    stop_daemon()
                    protected_file(root / "password", password, 0o600)
                    start_daemon()
        fixture_policy = json.loads(json.dumps(plan["policyObject"]))
        bootstrap_fixture = client.state / "bootstrap-fixture.json"
        bootstrap_fixture.write_text(json.dumps({"version": 1, "request_id": "b" * 32, "operation": "bootstrap", "result": {"policy": fixture_policy, "overrides": {"tools": {}}, "environment": {"pi": {"FIXTURE_TOKEN": "managed-fixture-token", "FIXTURE_USER": "{{username}}"}, "sandbox": {}, "extensions": {}}, "models": models, "policy_revision": "a" * 32}}))
        if linux:
            os.chown(bootstrap_fixture, account.pw_uid, account.pw_gid)
        bootstrap_fixture.chmod(0o600)
        client.command(["--validate-bootstrap", str(bootstrap_fixture), "--candidate-payload", str(client.payload)])
        bootstrap_fixture.unlink()
        client.command(["--api-key", "unmanaged"], expect_success=False)
        if fixture["name"] != "audit-local":
            client.command(["--config", str(root / "policy.toml"), "--help"], expect_success=False, configured=False)
        if service_source:
            client.command(["--validate-installation"], expect_success=False)
            client.command(["--validate-service", "--candidate-payload", str(client.payload)])
        else:
            client.command(["--validate-service", "--candidate-payload", str(client.payload)], expect_success=False)
            expected = "seatbelt" if plan["platform"] == "darwin" else "direct"
            assert client.command(["--validate-installation"]).stdout.strip() == expected
        # Inspection must not read catalogs or secret files.
        original_models = (root / "models.json").read_bytes()
        (root / "models.json").unlink()
        assert "host (default)" in client.command(["--list-workspace-modes"]).stdout
        protected_file(root / "models.json", original_models)
        assert "managed-fixture-token" in client.command(["auth", "print-api-key", "--model", "fixture/offline"]).stdout
        if fixture["name"] == "audit-local":
            client.command(["--help"], expect_success=False, configured=False)
            local_policy = Path(client.configuration[1])
            original_policy = local_policy.read_text()
            protected_file(local_policy, original_policy.replace("[audit]\nenabled = true", "[audit]\nenabled = false"))
            if linux:
                stop_daemon()
            previous_requests = mock_requests
            disabled_client = Client(fixture)
            disabled_client.start()
            disabled_client.prompt("WRITE_OK with audit disabled")
            disabled_client.stop()
            assert (client.workspace / "count.txt").read_text().count("once") == 1
            (client.workspace / "count.txt").unlink()
            assert mock_requests == previous_requests, "Audit-disabled launch contacted its endpoint"
            protected_file(local_policy, original_policy)
            if linux:
                start_daemon()
        client.start()
        client.prompt("WRITE_OK")
        assert (client.workspace / "count.txt").exists(), json.dumps({"tools": [message for message in client.messages if message.get("type") == "tool_execution_end"], "stderr": client.stderr, "provider_errors": provider_errors})
        assert (client.workspace / "count.txt").read_text().count("once") == 1
        client.prompt("PARALLEL")
        assert (client.workspace / "left").exists() and (client.workspace / "right").exists()
        assert not any(message.get("type") == "tool_execution_end" and message.get("isError") for message in client.messages), client.messages[-8:]
        before_policy = len(client.messages)
        client.prompt("READ_POLICY")
        read_results = [message for message in client.messages[before_policy:] if message.get("type") == "tool_execution_end"]
        assert read_results and bool(read_results[-1].get("isError")) == service_source, read_results
        # Changing authored/catalog inputs cannot change an already captured runtime.
        protected_file(root / "models.json", "not JSON")
        assert client.rpc("get_available_models")["success"]
        client.prompt("SNAPSHOT_STILL_USABLE")
        if enabled:
            client.prompt("OUTAGE_TOOL")
            assert not (client.workspace / "must-not-exist.txt").exists(), "An audited effect ran without its ACK"
            before = len(provider_calls)
            client.prompt("REJECT_WHILE_AUDIT_DOWN", admitted=False)
            assert len(provider_calls) == before, "A rejected checkpoint reached the model"
            start_sink()
            client.prompt("WRITE_OK after recovery")
            assert (client.workspace / "count.txt").read_text().count("once") == 2, "Recovery replayed or lost an effect"
            # A fresh audit handle does not read the unavailable catalog. Restore it
            # before startup validation on the subsequent full daemon restart.
            protected_file(root / "models.json", original_models)
            if linux:
                stop_daemon()
                client.prompt("REJECT_WHILE_SERVICE_DOWN", admitted=False)
                start_daemon()
            else:
                start_daemon()  # The fixture discards handles on restart.
            client.prompt("WRITE_OK after daemon restart")
            assert (client.workspace / "count.txt").read_text().count("once") == 3
        else:
            protected_file(root / "models.json", original_models)
        client.stop()
        if fixture["name"] == "fixed-local":
            policy_path = client.directory / "config/config.toml"
            original_policy = policy_path.read_text()
            protected_file(policy_path, original_policy.replace("[audit]\nenabled = false", "[audit]\nenabled = true"))
            client.command(["--list-workspace-modes"], expect_success=False)
            client.command(["--validate-installation"], expect_success=False)
            protected_file(policy_path, original_policy)
        assert not provider_errors, provider_errors
        print(f"Qualified compiled {fixture['name']} as {account.pw_name}", flush=True)
    if linux:
        time.sleep(0.2)
        with record_lock:
            attributed = [record for record in records if record.get("identity", {}).get("uid") == account.pw_uid]
            assert attributed, "No kernel-authenticated non-root audit records"
            assert any(record.get("policy_origin", {}).get("source") == "service" for record in attributed)
            assert any(record.get("identity", {}).get("source") == "https_assertion" for record in records), "No HTTPS identity records"
    assert not provider_errors, provider_errors
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
    stop_daemon()
    stop_sink()
    provider.shutdown()
    provider.server_close()
    if mock_service is not None:
        mock_service.shutdown()
        mock_service.server_close()
    for target in reversed(mounts):
        subprocess.run(["umount", target], check=True)
    assert not root.is_symlink()
    shutil.rmtree(root)
