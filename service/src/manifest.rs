use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::protocol::{CONFIG, Result, normalized, text};
use crate::sources::{protected_metadata, read_protected};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub(crate) manifest_version: u32,
    #[serde(default)]
    pub(crate) limits: Limits,
    pub(crate) listeners: Vec<Listener>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct Limits {
    pub max_connections: usize,
    pub max_connections_per_uid: usize,
    pub max_connections_per_ip: usize,
    pub max_audit_sessions: usize,
    pub max_audit_sessions_per_principal: usize,
    pub audit_session_idle_seconds: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 128,
            max_connections_per_uid: 16,
            max_connections_per_ip: 32,
            max_audit_sessions: 256,
            max_audit_sessions_per_principal: 8,
            audit_session_idle_seconds: 86400,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Listener {
    pub id: String,
    pub transport: String,
    pub platform: String,
    pub policy_file: String,
    pub audit_facility: String,
    pub rule_directory: Option<String>,
    pub socket_path: Option<String>,
    pub listen_address: Option<String>,
    pub certificate_file: Option<String>,
    pub private_key_file: Option<String>,
    pub credentials: Option<Vec<Credential>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Credential {
    pub name: String,
    pub password_file: String,
}
pub(crate) struct Password {
    pub name: String,
    digest: [u8; 32],
}
impl Password {
    pub(crate) fn matches(&self, name: &str, password: &[u8]) -> bool {
        let digest: [u8; 32] = Sha256::digest(password).into();
        bool::from(self.digest.ct_eq(&digest)) && self.name == name
    }
}
impl Manifest {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = read_protected(path, 1024 * 1024, false, 0)?;
        let value = crate::protocol::toml_json(
            toml::from_str(std::str::from_utf8(&bytes).map_err(|_| CONFIG)?).map_err(|_| CONFIG)?,
        )?;
        let manifest: Self = serde_json::from_value(value).map_err(|_| CONFIG)?;
        manifest.check()?;
        Ok(manifest)
    }
    pub(crate) fn check(&self) -> Result<()> {
        if self.manifest_version != 1 || self.listeners.is_empty() || self.listeners.len() > 16 {
            return Err(CONFIG);
        }
        let l = &self.limits;
        if !(1..=4096).contains(&l.max_connections)
            || !(1..=512).contains(&l.max_connections_per_uid)
            || !(1..=4096).contains(&l.max_connections_per_ip)
            || l.max_connections_per_uid > l.max_connections
            || l.max_connections_per_ip > l.max_connections
            || !(1..=8192).contains(&l.max_audit_sessions)
            || !(1..=256).contains(&l.max_audit_sessions_per_principal)
            || l.max_audit_sessions_per_principal > l.max_audit_sessions
            || !(60..=86400).contains(&l.audit_session_idle_seconds)
        {
            return Err(CONFIG);
        }
        let mut ids = BTreeSet::new();
        let mut sockets = BTreeSet::new();
        let mut addresses: Vec<SocketAddr> = Vec::new();
        for listener in &self.listeners {
            listener.check()?;
            if !ids.insert(&listener.id) {
                return Err(CONFIG);
            }
            if let Some(path) = &listener.socket_path
                && (!sockets.insert(path)
                    || l.max_connections_per_uid < l.max_audit_sessions_per_principal + 8)
            {
                return Err(CONFIG);
            }
            if let Some(address) = &listener.listen_address {
                if l.max_connections_per_ip < 8 {
                    return Err(CONFIG);
                }
                let address = address.parse::<SocketAddr>().map_err(|_| CONFIG)?;
                if addresses.iter().any(|a| {
                    a.port() == address.port()
                        && std::mem::discriminant(&a.ip()) == std::mem::discriminant(&address.ip())
                        && (a.ip() == address.ip()
                            || a.ip().is_unspecified()
                            || address.ip().is_unspecified())
                }) {
                    return Err(CONFIG);
                }
                addresses.push(address);
            }
        }
        Ok(())
    }
    pub(crate) fn descriptor_limit(&self) -> Result<()> {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0
            || limit.rlim_cur < (self.limits.max_connections + 1024) as libc::rlim_t
        {
            eprintln!(
                "pi-sandbox-service: file descriptor soft limit must be at least max_connections + 1024; raise LimitNOFILE"
            );
            return Err(CONFIG);
        }
        Ok(())
    }
}
impl Listener {
    fn check(&self) -> Result<()> {
        if !identifier(&self.id)
            || !["linux", "darwin"].contains(&self.platform.as_str())
            || !normalized(&self.policy_file)
            || self
                .rule_directory
                .as_deref()
                .is_some_and(|p| !normalized(p))
            || self.facility().is_none()
        {
            return Err(CONFIG);
        }
        match self.transport.as_str() {
            "unix"
                if self.platform == "linux"
                    && self.socket_path.as_deref().is_some_and(normalized)
                    && self.listen_address.is_none()
                    && self.certificate_file.is_none()
                    && self.private_key_file.is_none()
                    && self.credentials.is_none() => {}
            "https" if self.socket_path.is_none() => {
                let address = self
                    .listen_address
                    .as_deref()
                    .ok_or(CONFIG)?
                    .parse::<SocketAddr>()
                    .map_err(|_| CONFIG)?;
                if address.port() == 0 || !matches!(address.ip(), IpAddr::V4(_) | IpAddr::V6(_)) {
                    return Err(CONFIG);
                }
                for path in [&self.certificate_file, &self.private_key_file] {
                    if !path.as_deref().is_some_and(normalized) {
                        return Err(CONFIG);
                    }
                }
                let credentials = self.credentials.as_ref().ok_or(CONFIG)?;
                if credentials.is_empty() || credentials.len() > 4 {
                    return Err(CONFIG);
                }
                let mut names = BTreeSet::new();
                for c in credentials {
                    if !basic_name(&c.name)
                        || !normalized(&c.password_file)
                        || !names.insert(&c.name)
                    {
                        return Err(CONFIG);
                    }
                }
            }
            _ => return Err(CONFIG),
        }
        Ok(())
    }
    pub(crate) fn facility(&self) -> Option<u32> {
        match self.audit_facility.as_str() {
            "local0" => Some(16),
            "local1" => Some(17),
            "local2" => Some(18),
            "local3" => Some(19),
            "local4" => Some(20),
            "local5" => Some(21),
            "local6" => Some(22),
            "local7" => Some(23),
            _ => None,
        }
    }
    pub(crate) fn validate_material_metadata(&self, owner: u32) -> Result<()> {
        if let Some(path) = &self.certificate_file {
            protected_metadata(Path::new(path), 1024 * 1024, false, owner)?;
        }
        if let Some(path) = &self.private_key_file {
            protected_metadata(Path::new(path), 1024 * 1024, true, owner)?;
        }
        for credential in self.credentials.iter().flatten() {
            protected_metadata(Path::new(&credential.password_file), 8194, true, owner)?;
        }
        Ok(())
    }
    pub(crate) fn passwords(&self, owner: u32) -> Result<Vec<Password>> {
        self.credentials
            .iter()
            .flatten()
            .map(|c| {
                let mut bytes = read_protected(Path::new(&c.password_file), 8194, true, owner)?;
                if bytes.ends_with(b"\n") {
                    bytes.pop();
                    if bytes.ends_with(b"\r") {
                        bytes.pop();
                    }
                }
                let value = std::str::from_utf8(&bytes).map_err(|_| CONFIG)?;
                if value.len() < 32 || !text(value, 8192) {
                    return Err(CONFIG);
                }
                Ok(Password {
                    name: c.name.clone(),
                    digest: Sha256::digest(bytes).into(),
                })
            })
            .collect()
    }
    pub(crate) fn tls(&self, owner: u32) -> Result<Option<Arc<rustls::ServerConfig>>> {
        let Some(certificate) = &self.certificate_file else {
            return Ok(None);
        };
        let certificate = read_protected(Path::new(certificate), 1024 * 1024, false, owner)?;
        let key = read_protected(
            Path::new(self.private_key_file.as_deref().ok_or(CONFIG)?),
            1024 * 1024,
            true,
            owner,
        )?;
        let certificates = rustls_pemfile::certs(&mut certificate.as_slice())
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| CONFIG)?;
        if certificates.is_empty() {
            return Err(CONFIG);
        }
        let key = rustls_pemfile::private_key(&mut key.as_slice())
            .map_err(|_| CONFIG)?
            .ok_or(CONFIG)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(|_| CONFIG)?
            .with_no_client_auth()
            .with_single_cert(certificates, key)
            .map_err(|_| CONFIG)?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Some(Arc::new(config)))
    }
}
pub(crate) fn identifier(s: &str) -> bool {
    s.len() <= 32
        && s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
pub(crate) fn basic_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| (32..=126).contains(&b) && b != b':')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    #[test]
    fn manifest_exact_shape_facility_and_listener_scoped_limits() {
        let f = Fixture::new();
        let source = format!(
            "manifest_version = 1\n[[listeners]]\nid='test'\ntransport='unix'\nplatform='linux'\nsocket_path={:?}\npolicy_file={:?}\naudit_facility='local0'",
            f.path.join("socket").to_str().unwrap(),
            f.listener.policy_file
        );
        let mut m: Manifest = toml::from_str(&source).unwrap();
        m.check().unwrap();
        m.listeners[0].audit_facility = "user".into();
        assert!(m.check().is_err());
        assert!(toml::from_str::<Manifest>(&format!("obsolete=true\n{source}")).is_err());
        let mut m: Manifest = toml::from_str(&source).unwrap();
        m.limits.max_audit_sessions_per_principal = 9;
        assert!(m.check().is_err());
        m.limits.max_connections_per_uid = 17;
        assert!(m.check().is_ok());
    }
    #[test]
    fn password_metadata_validation_never_reads_contents() {
        let mut f = Fixture::new();
        let path = f.write("password", "too-short", true);
        f.listener.credentials = Some(vec![Credential {
            name: "population".into(),
            password_file: path.to_str().unwrap().into(),
        }]);
        f.listener.validate_material_metadata(f.owner).unwrap();
        assert!(f.listener.passwords(f.owner).is_err());
        f.write("password", "x".repeat(32) + "\r\n", true);
        let passwords = f.listener.passwords(f.owner).unwrap();
        assert!(passwords[0].matches("population", &[b'x'; 32]));
        assert!(!passwords[0].matches("other", &[b'x'; 32]));
        assert!(!passwords[0].matches("population", &[b'y'; 32]));
    }
    #[test]
    fn tls_keys_must_match_before_activation() {
        let mut f = Fixture::new();
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let other = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
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
        assert!(f.listener.tls(f.owner).unwrap().is_some());
        f.write("key.pem", other.key_pair.serialize_pem(), true);
        assert!(f.listener.tls(f.owner).is_err());
    }
}
