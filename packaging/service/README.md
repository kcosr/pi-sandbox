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

For foreground HTTPS-only use, the executable and inputs may instead live under
an unprivileged service account's home. Remove every Unix listener. Run validation
and startup as that account; each administrative file and rule directory must be
owned by it, with non-symlink ancestors owned by root or that account and no
group/other writes. Keep the file modes above. Running as root retains root-only
ownership checks, even for HTTPS-only configurations.

Create inputs with `umask 077`, use absolute physical paths and an unprivileged
HTTPS port, then run:

```sh
ulimit -n 4096
./pi-sandbox-service --validate --manifest "$HOME/pi-service/service.toml"
exec ./pi-sandbox-service --manifest "$HOME/pi-service/service.toml"
```

The shell soft limit must be at least `max_connections + 1024`, within its hard
limit; 4096 covers the default configuration. Existing paths still need correct
ownership/modes. The account needs access to the host's existing `/dev/log` for
successful auditing; offline validation does not check syslog, and audit errors
continue to block audited operations. No systemd unit, `/opt` or `/run` staging is
needed. Clients retain their compiled endpoint/TLS trust and root-owned Unix socket
checks. Keep trial server keys and credentials separate from production.

The unit exposes the read-only host `/dev` directory with `DevicePolicy=closed`;
it does not bind-mount the `/dev/log` socket inode. Host logging-socket replacement
therefore remains visible to per-send syslog lookup without restarting the service.
