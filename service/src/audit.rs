use std::collections::BTreeMap;
use std::os::unix::net::UnixDatagram;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::manifest::Limits;
use crate::protocol::{Error, INVALID, PolicyOrigin, Result, SAFE_INTEGER, random_id};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "snake_case")]
pub(crate) enum Identity {
    UnixPeer {
        uid: u32,
        pid: i32,
        user: Option<String>,
    },
    HttpsAssertion {
        credential_name: String,
        username: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        machine_id: Option<String>,
    },
}
impl Identity {
    fn matches(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::UnixPeer { uid, pid, .. }, Self::UnixPeer { uid: u, pid: p, .. }) => {
                uid == u && pid == p
            }
            _ => self == other,
        }
    }
    fn principal(&self) -> String {
        match self {
            Self::UnixPeer { uid, .. } => format!("unix:{uid}"),
            Self::HttpsAssertion {
                credential_name,
                username,
                ..
            } => serde_json::to_string(&(credential_name, username)).expect("strings serialize"),
        }
    }
}
pub(crate) trait Sink: Send + Sync {
    fn submit(&self, record: &[u8], deadline: Instant) -> Result<()>;
}
pub(crate) struct Syslog;
impl Sink for Syslog {
    fn submit(&self, record: &[u8], deadline: Instant) -> Result<()> {
        let socket = UnixDatagram::unbound().map_err(|_| Error("audit_unavailable"))?;
        socket
            .set_write_timeout(Some(
                Duration::from_secs(2).min(deadline.saturating_duration_since(Instant::now())),
            ))
            .map_err(|_| Error("audit_unavailable"))?;
        let count = socket
            .send_to(record, "/dev/log")
            .map_err(|_| Error("audit_unavailable"))?;
        if count != record.len() {
            return Err(Error("audit_unavailable"));
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Metadata {
    id: String,
    listener: String,
    client: String,
    generation: u64,
    session: String,
    origin: PolicyOrigin,
    identity: Identity,
    facility: u32,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Live,
    Closing,
    Revoked,
}
struct Entry {
    meta: Metadata,
    state: State,
    busy: bool,
    next: u64,
    last: Instant,
}
pub(crate) struct Audit {
    epoch: String,
    limits: Limits,
    entries: Mutex<BTreeMap<String, Entry>>,
    sink: Arc<dyn Sink>,
}
pub(crate) struct Open<'a> {
    pub listener: &'a str,
    pub client: &'a str,
    pub generation: u64,
    pub session: &'a str,
    pub cwd: &'a str,
    pub origin: PolicyOrigin,
    pub identity: Identity,
    pub facility: u32,
}
pub(crate) struct Mutation {
    audit: Arc<Audit>,
    meta: Metadata,
    sequence: u64,
    close: bool,
    settled: bool,
}
impl Drop for Mutation {
    fn drop(&mut self) {
        if !self.settled {
            self.audit.finish_failed(&self.meta.id)
        }
    }
}
impl Audit {
    pub(crate) fn new(limits: Limits, sink: Arc<dyn Sink>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            epoch: random_id().map_err(|_| Error("audit_unavailable"))?,
            limits,
            entries: Mutex::new(BTreeMap::new()),
            sink,
        }))
    }
    fn expire(&self, entries: &mut BTreeMap<String, Entry>) {
        let now = Instant::now();
        let idle = Duration::from_secs(self.limits.audit_session_idle_seconds);
        entries.retain(|_, e| {
            e.busy || (e.state == State::Live && now.saturating_duration_since(e.last) < idle)
        });
    }
    fn evict(entries: &mut BTreeMap<String, Entry>, predicate: impl Fn(&Entry) -> bool) -> bool {
        let candidate = entries
            .iter()
            .filter(|(_, e)| !e.busy && predicate(e))
            .min_by(|(a, x), (b, y)| x.last.cmp(&y.last).then_with(|| a.cmp(b)))
            .map(|(id, _)| id.clone());
        if let Some(id) = candidate {
            entries.remove(&id);
            true
        } else {
            false
        }
    }
    pub(crate) fn open(self: &Arc<Self>, open: Open<'_>, deadline: Instant) -> Result<Value> {
        let meta = Metadata {
            id: random_id().map_err(|_| Error("audit_unavailable"))?,
            listener: open.listener.into(),
            client: open.client.into(),
            generation: open.generation,
            session: open.session.into(),
            origin: open.origin,
            identity: open.identity,
            facility: open.facility,
        };
        {
            let mut entries = self.entries.lock().unwrap();
            self.expire(&mut entries);
            let principal = meta.identity.principal();
            entries.retain(|_, e| {
                e.busy || e.meta.identity.principal() != principal || e.meta.client != meta.client
            });
            while entries
                .values()
                .filter(|e| e.meta.identity.principal() == principal)
                .count()
                >= self.limits.max_audit_sessions_per_principal
            {
                if !Self::evict(&mut entries, |e| e.meta.identity.principal() == principal) {
                    return Err(Error("busy"));
                }
            }
            while entries.len() >= self.limits.max_audit_sessions {
                if !Self::evict(&mut entries, |_| true) {
                    return Err(Error("busy"));
                }
            }
            entries.insert(
                meta.id.clone(),
                Entry {
                    meta: meta.clone(),
                    state: State::Pending,
                    busy: true,
                    next: 1,
                    last: Instant::now(),
                },
            );
        }
        let mut guard = Mutation {
            audit: self.clone(),
            meta: meta.clone(),
            sequence: 0,
            close: false,
            settled: false,
        };
        self.send(
            &meta,
            0,
            json!({"event":"session_started","pi_session_id":open.session,"cwd":open.cwd}),
            deadline,
        )?;
        {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(&meta.id)
                .ok_or(Error("unknown_audit_session"))?;
            entry.state = State::Live;
            entry.busy = false;
            entry.last = Instant::now();
        }
        guard.settled = true;
        Ok(self.reply(&meta, Some(1), false))
    }
    fn bound<'a>(
        &self,
        entries: &'a mut BTreeMap<String, Entry>,
        id: &str,
        epoch: &str,
        listener: &str,
        identity: &Identity,
    ) -> Result<&'a mut Entry> {
        if epoch != self.epoch {
            return Err(Error("unknown_audit_session"));
        }
        let entry = entries.get_mut(id).ok_or(Error("unknown_audit_session"))?;
        if entry.meta.listener != listener || !entry.meta.identity.matches(identity) {
            return Err(Error("admission_denied"));
        }
        if entry.state != State::Live {
            return Err(Error("unknown_audit_session"));
        }
        Ok(entry)
    }
    pub(crate) fn check(
        &self,
        id: &str,
        epoch: &str,
        listener: &str,
        identity: &Identity,
    ) -> Result<Value> {
        let mut entries = self.entries.lock().unwrap();
        self.expire(&mut entries);
        let entry = self.bound(&mut entries, id, epoch, listener, identity)?;
        Ok(self.reply(&entry.meta, None, false))
    }
    pub(crate) fn claim(
        self: &Arc<Self>,
        id: &str,
        epoch: &str,
        listener: &str,
        identity: &Identity,
        sequence: u64,
        close: bool,
    ) -> Result<Mutation> {
        let mut entries = self.entries.lock().unwrap();
        self.expire(&mut entries);
        let entry = self.bound(&mut entries, id, epoch, listener, identity)?;
        if entry.busy || sequence != entry.next || sequence >= SAFE_INTEGER {
            entry.state = State::Revoked;
            if !entry.busy {
                entries.remove(id);
            }
            return Err(Error("audit_out_of_order"));
        }
        entry.busy = true;
        if close {
            entry.state = State::Closing;
        }
        Ok(Mutation {
            audit: self.clone(),
            meta: entry.meta.clone(),
            sequence,
            close,
            settled: false,
        })
    }
    fn finish_failed(&self, id: &str) {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(id);
    }
    fn reply(&self, meta: &Metadata, next: Option<u64>, closed: bool) -> Value {
        let mut v = json!({"audit_session_id":meta.id,"service_epoch":self.epoch,"audit_generation":meta.generation});
        if let Some(next) = next {
            v["next_sequence"] = next.into()
        }
        if closed {
            v["closed"] = true.into()
        }
        v
    }
    fn send(&self, meta: &Metadata, sequence: u64, event: Value, deadline: Instant) -> Result<()> {
        if deadline.saturating_duration_since(Instant::now()) < Duration::from_millis(2500) {
            return Err(Error("busy"));
        }
        let record = json!({"schema_version":7,"listener_id":meta.listener,"service_epoch":self.epoch,"audit_session_id":meta.id,"client_instance_id":meta.client,"audit_generation":meta.generation,"sequence":sequence,"policy_origin":meta.origin,"identity":meta.identity,"event":event});
        let mut bytes = format!(
            "<{}>pi-sandbox[{}]: ",
            meta.facility * 8 + 6,
            std::process::id()
        )
        .into_bytes();
        serde_json::to_writer(&mut bytes, &record).map_err(|_| Error("audit_unavailable"))?;
        if bytes.len() > 40 * 1024 {
            return Err(Error("request_too_large"));
        }
        self.sink
            .submit(&bytes, Instant::now() + Duration::from_secs(2))
    }
}
impl Mutation {
    pub(crate) fn complete(mut self, event: Option<Value>, deadline: Instant) -> Result<Value> {
        let event = if self.close {
            json!({"event":"session_ended","pi_session_id":self.meta.session})
        } else {
            let event = event.ok_or(INVALID)?;
            if contains_null(&event) {
                return Err(INVALID);
            }
            let typed: crate::events::Event =
                serde_json::from_value(event.clone()).map_err(|_| INVALID)?;
            if !crate::events::valid_event(&typed)
                || typed.pi_session_id != self.meta.session
                || matches!(typed.event.as_str(), "session_started" | "session_ended")
            {
                return Err(INVALID);
            }
            event
        };
        {
            let entries = self.audit.entries.lock().unwrap();
            if entries
                .get(&self.meta.id)
                .is_none_or(|e| e.state == State::Revoked)
            {
                return Err(Error("unknown_audit_session"));
            }
        }
        self.audit
            .send(&self.meta, self.sequence, event, deadline)?;
        {
            let mut entries = self.audit.entries.lock().unwrap();
            let entry = entries
                .get_mut(&self.meta.id)
                .ok_or(Error("unknown_audit_session"))?;
            if entry.state == State::Revoked {
                return Err(Error("unknown_audit_session"));
            }
            entry.next = self.sequence + 1;
            entry.last = Instant::now();
            entry.busy = false;
            if self.close {
                entries.remove(&self.meta.id);
            }
        }
        self.settled = true;
        Ok(self
            .audit
            .reply(&self.meta, Some(self.sequence + 1), self.close))
    }
}

fn contains_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(values) => values.iter().any(contains_null),
        Value::Object(values) => values.values().any(contains_null),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MemorySink;
    use std::sync::atomic::Ordering;
    fn identity() -> Identity {
        Identity::UnixPeer {
            uid: 1000,
            pid: 42,
            user: Some("alice".into()),
        }
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(6)
    }
    fn open(a: &Arc<Audit>, client: &str) -> Value {
        a.open(
            Open {
                listener: "test",
                client,
                generation: 1,
                session: "pi",
                cwd: "/work",
                origin: PolicyOrigin::Local {},
                identity: identity(),
                facility: 16,
            },
            deadline(),
        )
        .unwrap()
    }
    fn event() -> Value {
        json!({"event":"tool_requested","pi_session_id":"pi","invocation_id":"inv","tool":"bash","boundary":"seatbelt"})
    }
    #[test]
    fn independent_handles_principal_binding_sequence_and_record_provenance() {
        let sink = Arc::new(MemorySink::default());
        let a = Audit::new(Limits::default(), sink.clone()).unwrap();
        let first = open(&a, "c1");
        let second = open(&a, "c2");
        let id = first["audit_session_id"].as_str().unwrap();
        let epoch = first["service_epoch"].as_str().unwrap();
        assert_ne!(id, second["audit_session_id"]);
        let wrong = Identity::UnixPeer {
            uid: 1001,
            pid: 42,
            user: None,
        };
        assert_eq!(
            a.claim(id, epoch, "test", &wrong, 1, false).err(),
            Some(Error("admission_denied"))
        );
        assert!(a.check(id, epoch, "test", &identity()).is_ok());
        let result = a
            .claim(id, epoch, "test", &identity(), 1, false)
            .unwrap()
            .complete(Some(event()), deadline())
            .unwrap();
        assert_eq!(result["next_sequence"], 2);
        let record = &sink.records.lock().unwrap()[1];
        assert_eq!(record["policy_origin"], json!({"source":"local"}));
        assert_eq!(record["schema_version"], 7);
        assert!(record.get("principal_uid").is_none());
    }
    #[test]
    fn concurrent_mutation_revokes_without_replay_and_checks_do_not_claim() {
        let sink = Arc::new(MemorySink::default());
        let a = Audit::new(Limits::default(), sink.clone()).unwrap();
        let opened = open(&a, "c1");
        let id = opened["audit_session_id"].as_str().unwrap();
        let epoch = opened["service_epoch"].as_str().unwrap();
        let claim = a.claim(id, epoch, "test", &identity(), 1, false).unwrap();
        assert!(a.check(id, epoch, "test", &identity()).is_ok());
        assert_eq!(
            a.claim(id, epoch, "test", &identity(), 1, false).err(),
            Some(Error("audit_out_of_order"))
        );
        assert_eq!(
            claim.complete(Some(event()), deadline()),
            Err(Error("unknown_audit_session"))
        );
        assert_eq!(sink.records.lock().unwrap().len(), 1);
    }
    #[test]
    fn sink_failure_revokes_only_its_handle_and_later_open_recovers() {
        let sink = Arc::new(MemorySink::default());
        let a = Audit::new(Limits::default(), sink.clone()).unwrap();
        let one = open(&a, "c1");
        let two = open(&a, "c2");
        let id = one["audit_session_id"].as_str().unwrap();
        let epoch = one["service_epoch"].as_str().unwrap();
        sink.fail.store(true, Ordering::SeqCst);
        assert!(a.check(id, epoch, "test", &identity()).is_ok());
        assert_eq!(
            a.claim(id, epoch, "test", &identity(), 1, false)
                .unwrap()
                .complete(Some(event()), deadline()),
            Err(Error("audit_unavailable"))
        );
        assert!(a.check(id, epoch, "test", &identity()).is_err());
        assert!(
            a.check(
                two["audit_session_id"].as_str().unwrap(),
                epoch,
                "test",
                &identity()
            )
            .is_ok()
        );
        sink.fail.store(false, Ordering::SeqCst);
        assert_ne!(open(&a, "c1")["audit_session_id"], id);
    }
    #[test]
    fn close_is_immediately_revoked_and_acks_only_after_submission() {
        let sink = Arc::new(MemorySink::default());
        let a = Audit::new(Limits::default(), sink.clone()).unwrap();
        let opened = open(&a, "c1");
        let id = opened["audit_session_id"].as_str().unwrap();
        let epoch = opened["service_epoch"].as_str().unwrap();
        let claim = a.claim(id, epoch, "test", &identity(), 1, true).unwrap();
        assert!(a.check(id, epoch, "test", &identity()).is_err());
        let result = claim.complete(None, deadline()).unwrap();
        assert_eq!(result["closed"], true);
        assert_eq!(
            sink.records.lock().unwrap().last().unwrap()["event"]["event"],
            "session_ended"
        );
    }
    #[test]
    fn expired_dispatch_never_sends_and_invalid_event_revokes() {
        let sink = Arc::new(MemorySink::default());
        let a = Audit::new(Limits::default(), sink.clone()).unwrap();
        let opened = open(&a, "c1");
        let id = opened["audit_session_id"].as_str().unwrap();
        let epoch = opened["service_epoch"].as_str().unwrap();
        assert_eq!(
            a.claim(id, epoch, "test", &identity(), 1, false)
                .unwrap()
                .complete(Some(event()), Instant::now() + Duration::from_secs(2)),
            Err(Error("busy"))
        );
        assert_eq!(sink.records.lock().unwrap().len(), 1);
        let opened = open(&a, "c1");
        let id = opened["audit_session_id"].as_str().unwrap();
        let mut wrong = event();
        wrong["pi_session_id"] = "other".into();
        assert_eq!(
            a.claim(id, epoch, "test", &identity(), 1, false)
                .unwrap()
                .complete(Some(wrong), deadline()),
            Err(INVALID)
        );
        assert!(a.check(id, epoch, "test", &identity()).is_err());
    }
    #[test]
    fn lru_capacity_reclaims_idle_but_never_busy_handles() {
        let sink = Arc::new(MemorySink::default());
        let limits = Limits {
            max_audit_sessions: 2,
            max_audit_sessions_per_principal: 2,
            ..Limits::default()
        };
        let a = Audit::new(limits, sink).unwrap();
        let one = open(&a, "c1");
        let two = open(&a, "c2");
        let epoch = one["service_epoch"].as_str().unwrap();
        let busy = a
            .claim(
                one["audit_session_id"].as_str().unwrap(),
                epoch,
                "test",
                &identity(),
                1,
                false,
            )
            .unwrap();
        let three = open(&a, "c3");
        assert!(
            a.check(
                one["audit_session_id"].as_str().unwrap(),
                epoch,
                "test",
                &identity()
            )
            .is_ok()
        );
        assert!(
            a.check(
                two["audit_session_id"].as_str().unwrap(),
                epoch,
                "test",
                &identity()
            )
            .is_err()
        );
        assert!(
            a.check(
                three["audit_session_id"].as_str().unwrap(),
                epoch,
                "test",
                &identity()
            )
            .is_ok()
        );
        drop(busy);
    }
}
