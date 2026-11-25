use crate::protocol::{Error, Result};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;

pub(crate) struct Fixture {
    pub path: PathBuf,
    pub owner: u32,
    pub listener: crate::manifest::Listener,
}
impl Fixture {
    pub fn new() -> Self {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "service-fixture-{}",
                crate::protocol::random_id().unwrap()
            ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let policy = include_str!("../../packaging/service/audit-only-policy.toml").replace(
            "/etc/pi-sandbox-service/main/audit-only-models.json",
            path.join("models.json").to_str().unwrap(),
        );
        std::fs::write(path.join("policy.toml"), policy).unwrap();
        std::fs::write(
            path.join("models.json"),
            include_str!("../../packaging/service/audit-only-models.json"),
        )
        .unwrap();
        let listener=serde_json::from_value(serde_json::json!({"id":"test","transport":"unix","platform":"linux","socket_path":path.join("service.sock"),"policy_file":path.join("policy.toml"),"audit_facility":"local3"})).unwrap();
        Self {
            path,
            owner: unsafe { libc::geteuid() },
            listener,
        }
    }
    pub fn write(&self, name: &str, bytes: impl AsRef<[u8]>, secret: bool) -> PathBuf {
        let path = self.path.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(
            &path,
            std::fs::Permissions::from_mode(if secret { 0o600 } else { 0o644 }),
        )
        .unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
#[derive(Default)]
pub(crate) struct MemorySink {
    pub records: Mutex<Vec<Value>>,
    pub fail: AtomicBool,
}
impl crate::audit::Sink for MemorySink {
    fn submit(&self, bytes: &[u8], _: Instant) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error("audit_unavailable"));
        }
        let index = bytes.iter().position(|b| *b == b'{').unwrap();
        self.records
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&bytes[index..]).unwrap());
        Ok(())
    }
}
