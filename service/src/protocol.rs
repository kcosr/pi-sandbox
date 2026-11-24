use std::collections::BTreeSet;
use std::fmt;

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};

pub(crate) const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_REQUEST: usize = 32 * 1024;
pub(crate) const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl Error {
    pub(crate) fn status(self) -> u16 {
        match self.0 {
            "authentication_required" => 401,
            "admission_denied" | "incompatible_client" | "audit_disabled" => 403,
            "unknown_audit_session" => 410,
            "audit_out_of_order" => 409,
            "request_too_large" => 413,
            "configuration_unavailable" | "audit_unavailable" | "busy" => 503,
            _ => 400,
        }
    }
    pub(crate) fn message(self) -> &'static str {
        match self.0 {
            "authentication_required" => "Service authentication is required",
            "admission_denied" => "Request is not admitted for this listener or audit session",
            "incompatible_client" => {
                "Requires service API 1, policy schema 16, model schema pi-1.5.0 and the listener platform; contact the administrator for a matching distribution"
            }
            "audit_disabled" => "This listener does not admit new audit sessions",
            "unknown_audit_session" => "Audit session is no longer available",
            "audit_out_of_order" => "Audit sequence or concurrent mutation is invalid",
            "request_too_large" => "Service input or output exceeds its bound",
            "configuration_unavailable" => "Administrative configuration is unavailable or invalid",
            "audit_unavailable" => "Audit submission could not be confirmed",
            "busy" => "Service capacity or request deadline is exhausted",
            "unsupported_version" => "Unsupported service API version; expected 1",
            _ => "Invalid service request",
        }
    }
    pub(crate) fn envelope(self, id: Option<&str>) -> Value {
        let mut v = json!({"version":1,"error":{"code":self.0,"message":self.message()}});
        if let Some(id) = id {
            v["request_id"] = id.into();
        }
        v
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for Error {}
pub(crate) type Result<T> = std::result::Result<T, Error>;
pub(crate) const INVALID: Error = Error("invalid_request");
pub(crate) const CONFIG: Error = Error("configuration_unavailable");

pub(crate) fn identity_failure(error: std::io::Error) -> Error {
    if error.kind() == std::io::ErrorKind::TimedOut {
        Error("busy")
    } else {
        CONFIG
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum PolicyOrigin {
    Service { revision: String },
    Local {},
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Assertion {
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Client {
    pub platform: String,
    pub architecture: String,
    pub application_version: String,
    pub build_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Operation {
    Bootstrap {
        policy_schema: u32,
        model_schema: String,
        client: Client,
    },
    PolicyInspect {
        policy_schema: u32,
        model_schema: String,
        client: Client,
    },
    AuditOpen {
        client_instance_id: String,
        audit_generation: u64,
        pi_session_id: String,
        cwd: String,
        policy_origin: PolicyOrigin,
    },
    AuditCheck {
        audit_session_id: String,
        service_epoch: String,
    },
    AuditEvent {
        audit_session_id: String,
        service_epoch: String,
        sequence: u64,
        event: Value,
    },
    AuditClose {
        audit_session_id: String,
        service_epoch: String,
        sequence: u64,
    },
}
impl Operation {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Bootstrap { .. } => "bootstrap",
            Self::PolicyInspect { .. } => "policy_inspect",
            Self::AuditOpen { .. } => "audit_open",
            Self::AuditCheck { .. } => "audit_check",
            Self::AuditEvent { .. } => "audit_event",
            Self::AuditClose { .. } => "audit_close",
        }
    }
    pub(crate) fn new_work(&self) -> bool {
        matches!(
            self,
            Self::Bootstrap { .. } | Self::PolicyInspect { .. } | Self::AuditOpen { .. }
        )
    }
    pub(crate) fn large(&self) -> bool {
        matches!(self, Self::Bootstrap { .. } | Self::PolicyInspect { .. })
    }
}
pub(crate) struct Request {
    pub id: String,
    pub identity: Option<Assertion>,
    pub operation: Operation,
}
impl Request {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REQUEST {
            return Err(Error("request_too_large"));
        }
        let mut value = strict_json(bytes).map_err(|_| INVALID)?;
        let obj = value.as_object_mut().ok_or(INVALID)?;
        if obj.remove("version").ok_or(INVALID)? != json!(1) {
            return Err(Error("unsupported_version"));
        }
        let id = obj
            .remove("request_id")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or(INVALID)?;
        if !hex_id(&id) {
            return Err(INVALID);
        }
        if obj
            .get("identity")
            .and_then(|v| v.get("machine_id"))
            .is_some_and(Value::is_null)
        {
            return Err(INVALID);
        }
        let identity = obj
            .remove("identity")
            .map(serde_json::from_value::<Assertion>)
            .transpose()
            .map_err(|_| INVALID)?;
        if identity.as_ref().is_some_and(|i| {
            !text(&i.username, 256) || i.machine_id.as_deref().is_some_and(|s| !uuid(s))
        }) {
            return Err(INVALID);
        }
        let operation: Operation = serde_json::from_value(value).map_err(|_| INVALID)?;
        match &operation {
            Operation::Bootstrap {
                policy_schema,
                model_schema,
                client,
            }
            | Operation::PolicyInspect {
                policy_schema,
                model_schema,
                client,
            } => {
                if bytes.len() > 16 * 1024 {
                    return Err(Error("request_too_large"));
                }
                if *policy_schema != 16
                    || model_schema != "pi-1.5.0"
                    || !["linux", "darwin"].contains(&client.platform.as_str())
                    || !["x64", "arm64"].contains(&client.architecture.as_str())
                {
                    return Err(Error("incompatible_client"));
                }
                if !text(&client.application_version, 256) || !text(&client.build_id, 256) {
                    return Err(INVALID);
                }
            }
            Operation::AuditOpen {
                client_instance_id,
                audit_generation,
                pi_session_id,
                cwd,
                policy_origin,
            } => {
                if !hex_id(client_instance_id)
                    || *audit_generation == 0
                    || *audit_generation > SAFE_INTEGER
                    || !text(pi_session_id, 256)
                    || !absolute(cwd)
                    || matches!(policy_origin,PolicyOrigin::Service{revision} if !hex_id(revision))
                {
                    return Err(INVALID);
                }
            }
            Operation::AuditCheck {
                audit_session_id,
                service_epoch,
            }
            | Operation::AuditEvent {
                audit_session_id,
                service_epoch,
                ..
            }
            | Operation::AuditClose {
                audit_session_id,
                service_epoch,
                ..
            } => {
                if !hex_id(audit_session_id) || !hex_id(service_epoch) {
                    return Err(INVALID);
                }
                // Handle-specific event/sequence validation happens after principal binding,
                // so malformed authenticated mutations revoke only their own handle.
            }
        }
        Ok(Self {
            id,
            identity,
            operation,
        })
    }
}
pub(crate) fn hex_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub(crate) fn absolute(s: &str) -> bool {
    s.starts_with('/') && s.len() <= 4096 && !s.contains('\0')
}
pub(crate) fn normalized(s: &str) -> bool {
    absolute(s)
        && s != "/"
        && !s.ends_with('/')
        && !s
            .split('/')
            .skip(1)
            .any(|p| p.is_empty() || p == "." || p == "..")
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_lowercase()
            }
        })
}
pub(crate) fn random_id() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    let mut read = 0;
    while read < bytes.len() {
        let n =
            unsafe { libc::getrandom(bytes[read..].as_mut_ptr().cast(), bytes.len() - read, 0) };
        if n < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        read += n as usize;
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

struct Seed(usize);
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<Value, D::Error> {
        if self.0 > 32 {
            return Err(serde::de::Error::custom("nesting limit"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        if v.unsigned_abs() > SAFE_INTEGER {
            return Err(E::custom("unsafe integer"));
        }
        Ok(v.into())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        if v > SAFE_INTEGER {
            return Err(E::custom("unsafe integer"));
        }
        Ok(v.into())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        if !v.is_finite() || (v.fract() == 0.0 && v.abs() > SAFE_INTEGER as f64) {
            return Err(E::custom("unsafe number"));
        }
        Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("invalid number"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut v = Vec::new();
        while let Some(x) = a.next_element_seed(Seed(self.0 + 1))? {
            v.push(x)
        }
        Ok(v.into())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut v = Map::new();
        let mut keys = BTreeSet::new();
        while let Some(k) = a.next_key::<String>()? {
            if !keys.insert(k.clone()) {
                return Err(serde::de::Error::custom("duplicate key"));
            }
            v.insert(k, a.next_value_seed(Seed(self.0 + 1))?);
        }
        Ok(v.into())
    }
}
pub(crate) fn strict_json(bytes: &[u8]) -> std::result::Result<Value, serde_json::Error> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let v = Seed(0).deserialize(&mut d)?;
    d.end()?;
    Ok(v)
}
pub(crate) fn toml_json(value: toml::Value) -> Result<Value> {
    fn convert(v: toml::Value, depth: usize) -> Result<Value> {
        if depth > 32 {
            return Err(CONFIG);
        }
        Ok(match v {
            toml::Value::String(s) => s.into(),
            toml::Value::Boolean(b) => b.into(),
            toml::Value::Integer(n) if n.unsigned_abs() <= SAFE_INTEGER => n.into(),
            toml::Value::Float(n)
                if n.is_finite() && (n.fract() != 0.0 || n.abs() <= SAFE_INTEGER as f64) =>
            {
                Number::from_f64(n).ok_or(CONFIG)?.into()
            }
            toml::Value::Array(a) => a
                .into_iter()
                .map(|v| convert(v, depth + 1))
                .collect::<Result<Vec<_>>>()?
                .into(),
            toml::Value::Table(t) => t
                .into_iter()
                .map(|(k, v)| Ok((k, convert(v, depth + 1)?)))
                .collect::<Result<Map<_, _>>>()?
                .into(),
            _ => return Err(CONFIG),
        })
    }
    convert(value, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_timeouts_have_retryable_capacity_errors() {
        assert_eq!(
            identity_failure(std::io::Error::from(std::io::ErrorKind::TimedOut)),
            Error("busy")
        );
        assert_eq!(
            identity_failure(std::io::Error::from(std::io::ErrorKind::InvalidData)),
            CONFIG
        );
    }
    #[test]
    fn strict_json_rejects_duplicates_unsafe_numbers_and_excessive_depth() {
        for bytes in [
            br#"{"nested":{"a":1,"a":2}}"#.as_slice(),
            br#"{"a":9007199254740992}"#,
            b"{\"a\":1e30}",
            b"{\"a\":1e999}",
            b"\xef\xbb\xbf{}",
            b"{\"a\":\"\xff\"}",
        ] {
            assert!(strict_json(bytes).is_err(), "{bytes:?}");
        }
        assert!(strict_json(format!("{}0{}", "[".repeat(33), "]".repeat(33)).as_bytes()).is_err());
        assert_eq!(
            strict_json(b"{\"a\":9007199254740991,\"b\":0.5}").unwrap()["b"],
            0.5
        );
    }
    #[test]
    fn toml_conversion_preserves_keys_and_rejects_dates_and_unsafe_numbers() {
        let value = toml_json(
            toml::from_str("[MixedCase]\nValue = '$!{{username}}'\namount = 0.125").unwrap(),
        )
        .unwrap();
        assert_eq!(value["MixedCase"]["Value"], "$!{{username}}");
        for text in [
            "x = 9007199254740992",
            "x = inf",
            "x = nan",
            "x = 2026-01-01",
        ] {
            assert!(toml_json(toml::from_str(text).unwrap()).is_err());
        }
    }
    fn open() -> Value {
        json!({"version":1,"request_id":"1".repeat(32),"operation":"audit_open","client_instance_id":"2".repeat(32),"audit_generation":1,"pi_session_id":"p","cwd":"/work","policy_origin":{"source":"local"}})
    }
    #[test]
    fn exact_origin_and_request_variants() {
        let mut value = open();
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
        value["policy_origin"]["revision"] = "3".repeat(32).into();
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        value["policy_origin"]["source"] = "service".into();
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
        value["policy_revision"] = "3".repeat(32).into();
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = open();
        value["audit_generation"] = 0.into();
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = open();
        value["identity"] = json!({"username":"alice","uid":1000});
        assert!(Request::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}
