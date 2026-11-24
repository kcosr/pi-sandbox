# Service examples

These files are templates, not automatically installed live configuration. Copy and
adapt them under `/etc/pi-sandbox-service/main`, with root ownership and protected
ancestors. Policies and catalogs may be mode 0644. Rule files, Basic password files
and TLS private keys must be mode 0600. Passwords must be generated from at least
256 bits of randomness and contain 32–8192 UTF-8 bytes without controls after one
optional trailing newline. Provision them separately; no shared credential is
included here.

`service.toml` illustrates Unix audit access for locally configured clients. Its
`audit-only-policy.toml` and `audit-only-models.json` contain no secret references
or usable credentials. The catalog preserves the public example's unauthenticated
placeholder model. Replace it only with intentionally public configuration.
Authentication grants access to every operation, including bootstrap: local-file
clients normally send only audit operations, but a user can directly request the
listener's policy/catalog/environment. Never point this listener at local users'
policies or add secrets on the assumption that an audit-only client cannot retrieve
them. Use separate deployment inputs for service-configured clients.

Use `pi-sandbox-service --validate --manifest FILE` for offline shape, source and
metadata checks. It does not read password, private-key or referenced-secret
contents. Normal startup validates TLS keys and passwords before accepting any
connection. Deployment controls activation, logging, retention and forwarding;
these examples install no syslog routes or logging daemon.

The single systemd unit supports Unix and HTTPS listeners. HTTPS clients require
TLS 1.2 or later and normal certificate hostname validation. Shared credentials
permit username assertions; they do not attest a device or isolate users sharing
a credential. Changes to TLS, credentials or the manifest require a restart.

The unit exposes the read-only host `/dev` directory with `DevicePolicy=closed`;
it does not bind-mount the `/dev/log` socket inode. Host logging-socket replacement
therefore remains visible to per-send syslog lookup without restarting the service.
