use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Event {
    pub(crate) event: String,
    pub(crate) pi_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_task_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    command_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    known_read_only_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_set_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_export: Option<ExportDetails>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum ExportDetails {
    Intent(ExportIntent),
    Complete(ExportComplete),
    ReplaceIntent(ExportReplaceIntent),
    ReplaceComplete(ExportReplaceComplete),
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportIntent {
    operation_id: String,
    destination: String,
    roots: Vec<String>,
    entry_count: u64,
    file_count: u64,
    total_bytes: u64,
    manifest_digest: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportComplete {
    operation_id: String,
    destination: String,
    saved_files: u64,
    saved_bytes: u64,
    failed_files: u64,
    not_saved_files: u64,
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportPrior {
    dev: String,
    ino: String,
    size: String,
    mtime_ns: String,
    ctime_ns: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportReplaceIntent {
    operation_id: String,
    destination: String,
    path: String,
    prior: ExportPrior,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportReplaceComplete {
    operation_id: String,
    destination: String,
    path: String,
    prior: ExportPrior,
    outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
fn valid_export_details(kind: &str, details: &ExportDetails) -> bool {
    let base =
        |id: &str, path: &str| bounded(id, 256) && bounded(path, 4096) && path.starts_with('/');
    let error = |e: &Option<String>| e.as_ref().is_none_or(|s| bounded(s, 1024));
    let prior = |p: &ExportPrior| {
        [&p.dev, &p.ino, &p.size]
            .iter()
            .all(|s| !s.starts_with('-'))
            && [&p.dev, &p.ino, &p.size, &p.mtime_ns, &p.ctime_ns]
                .iter()
                .all(|s| {
                    let digits = s.strip_prefix('-').unwrap_or(s);
                    !digits.is_empty()
                        && digits.len() <= 30
                        && digits.bytes().all(|b| b.is_ascii_digit())
                })
    };
    let relative =
        |p: &str| bounded(p, 4096) && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..");
    match details {
        ExportDetails::Intent(e) => {
            kind == "export_intent"
                && base(&e.operation_id, &e.destination)
                && !e.roots.is_empty()
                && e.roots.len() <= 2
                && e.roots.iter().all(|r| r == "home" || r == "tmp")
                && (e.roots.len() != 2 || e.roots[0] != e.roots[1])
                && e.entry_count <= 100_000
                && e.file_count <= e.entry_count
                && e.total_bytes <= 4 * 1024_u64.pow(3)
                && e.manifest_digest.len() == 64
                && e.manifest_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        ExportDetails::Complete(e) => {
            kind == "export_complete"
                && base(&e.operation_id, &e.destination)
                && e.saved_files <= 100_000
                && e.failed_files <= 100_000
                && e.not_saved_files <= 100_000
                && e.saved_bytes <= 4 * 1024_u64.pow(3)
                && error(&e.error)
        }
        ExportDetails::ReplaceIntent(e) => {
            kind == "export_replace_intent"
                && base(&e.operation_id, &e.destination)
                && relative(&e.path)
                && prior(&e.prior)
        }
        ExportDetails::ReplaceComplete(e) => {
            kind == "export_replace_complete"
                && base(&e.operation_id, &e.destination)
                && relative(&e.path)
                && prior(&e.prior)
                && matches!(e.outcome.as_str(), "saved" | "failed")
                && error(&e.error)
        }
    }
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}
fn one_of(value: &Option<String>, choices: &[&str]) -> bool {
    value.as_ref().is_none_or(|s| choices.contains(&s.as_str()))
}
pub(crate) fn valid_event(e: &Event) -> bool {
    if let Some(details) = &e.user_export {
        return bounded(&e.pi_session_id, 256)
            && valid_export_details(&e.event, details)
            && serde_json::to_value(e)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .is_some_and(|v| {
                    v.keys().all(|key| {
                        matches!(key.as_str(), "event" | "pi_session_id" | "user_export")
                    })
                });
    }

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
        (&e.mcp_server, 32),
        (&e.mcp_tool, 128),
        (&e.parent_invocation_id, 256),
        (&e.child_id, 128),
        (&e.child_session_id, 256),
        (&e.child_task_id, 128),
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
            || e.mcp_server.is_some()
            || e.mcp_tool.is_some()
            || e.mcp_transport.is_some()
            || e.parent_invocation_id.is_some()
            || e.child_id.is_some()
            || e.child_session_id.is_some()
            || e.child_task_id.is_some()
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
    if e.mcp_server.is_some() || e.mcp_tool.is_some() || e.mcp_transport.is_some() {
        let valid_name = e.mcp_server.as_ref().is_some_and(|name| {
            name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        });
        if !valid_name
            || e.mcp_tool
                .as_ref()
                .is_none_or(|s| s.chars().any(char::is_control))
            || e.mcp_transport.is_none()
            || !one_of(&e.mcp_transport, &["http", "stdio"])
            || e.boundary.as_deref() != Some("host")
            || e.extension.is_some()
        {
            return false;
        }
    }
    if e.parent_invocation_id.is_some() && e.parent_invocation_id == e.invocation_id {
        return false;
    }
    if e.child_id.is_some() != e.child_session_id.is_some()
        || e.child_id.is_some() != e.child_task_id.is_some()
    {
        return false;
    }
    if e.repository.is_some() && e.extension.is_none() {
        return false;
    }
    if e.command.is_some() && e.tool.as_deref() != Some("bash") {
        return false;
    }
    // Bash command classification accompanies only bash decision events, as a pair.
    if (e.command_class.is_some() || e.known_read_only_version.is_some())
        && (e.command_class.is_none()
            || e.known_read_only_version.is_none_or(|version| version == 0)
            || !one_of(
                &e.command_class,
                &["known_read_only", "unclassified", "configured_command"],
            )
            || !matches!(e.event.as_str(), "tool_execution_intent" | "tool_denied")
            || e.tool.as_deref() != Some("bash"))
    {
        return false;
    }
    if e.command_class.as_deref() == Some("configured_command") {
        let Some(ids) = &e.command_set_ids else {
            return false;
        };
        if ids.is_empty()
            || ids.len() > 64
            || ids.iter().enumerate().any(|(i, id)| {
                id.len() > 64
                    || !id.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                    || matches!(id.as_str(), "__proto__" | "prototype" | "constructor")
                    || ids[..i].contains(id)
            })
        {
            return false;
        }
    } else if e.command_set_ids.is_some() {
        return false;
    }
    one_of(&e.boundary, &["bubblewrap", "direct", "seatbelt", "host"])
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn accepted(value: &Value) -> bool {
        serde_json::from_value::<Event>(value.clone()).is_ok_and(|event| valid_event(&event))
    }
    fn tool() -> Value {
        json!({"event":"tool_execution_intent","pi_session_id":"pi","invocation_id":"call","tool":"bash","boundary":"bubblewrap","approval_source":"policy","command":"printf hello","command_truncated":false})
    }
    #[test]
    fn child_provenance_is_complete_bounded_and_tool_only() {
        let mut event = tool();
        event["child_id"] = "child".into();
        event["child_session_id"] = "child-session".into();
        event["child_task_id"] = "task".into();
        event["parent_invocation_id"] = "parent".into();
        assert!(accepted(&event));
        for key in ["child_id", "child_session_id", "child_task_id"] {
            let mut incomplete = event.clone();
            incomplete.as_object_mut().unwrap().remove(key);
            assert!(!accepted(&incomplete));
        }
        event["parent_invocation_id"] = "call".into();
        assert!(!accepted(&event));
        event["parent_invocation_id"] = "parent".into();
        event["child_task_id"] = "a".repeat(129).into();
        assert!(!accepted(&event));
        event = json!({"event":"session_ended","pi_session_id":"pi","child_id":"child","child_session_id":"session","child_task_id":"task"});
        assert!(!accepted(&event));
    }
    #[test]
    fn mcp_metadata_is_complete_host_bound_and_excludes_payloads() {
        let base = json!({"event":"tool_requested","pi_session_id":"pi","invocation_id":"call","tool":"mcp_lookup","boundary":"host","mcp_server":"company","mcp_tool":"lookup","mcp_transport":"http"});
        assert!(accepted(&base));
        let mut stdio = base.clone();
        stdio["mcp_transport"] = "stdio".into();
        assert!(accepted(&stdio));
        for key in ["mcp_server", "mcp_tool", "mcp_transport", "boundary"] {
            let mut missing = base.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(!accepted(&missing));
        }
        for (key, value) in [
            ("boundary", json!("direct")),
            ("extension", json!("other")),
            ("mcp_server", json!("invalid-name")),
            ("mcp_tool", json!("line\nfeed")),
            ("mcp_transport", json!("socket")),
            ("arguments", json!({"secret":"value"})),
            ("response", json!("secret")),
            ("principal_uid", json!(0)),
        ] {
            let mut invalid = base.clone();
            invalid[key] = value;
            assert!(!accepted(&invalid), "{key}");
        }
    }
    #[test]
    fn bash_classification_and_command_sets_remain_separate_and_decision_only() {
        let mut event = tool();
        event["command_class"] = "known_read_only".into();
        event["known_read_only_version"] = 1.into();
        assert!(accepted(&event));
        for key in ["command_class", "known_read_only_version"] {
            let mut missing = event.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(!accepted(&missing));
        }
        for kind in ["tool_requested", "tool_completed"] {
            let mut invalid = event.clone();
            invalid["event"] = kind.into();
            assert!(!accepted(&invalid));
        }
        event["command_class"] = "configured_command".into();
        assert!(!accepted(&event));
        event["command_set_ids"] = json!(["git-status", "inspect_tree"]);
        assert!(accepted(&event));
        for ids in [
            json!([]),
            json!(["x", "x"]),
            json!(["../bad"]),
            json!(["constructor"]),
            json!(["x".repeat(65)]),
            json!("x"),
            Value::Null,
        ] {
            let mut invalid = event.clone();
            invalid["command_set_ids"] = ids;
            assert!(!accepted(&invalid));
        }
        event["command_class"] = "unclassified".into();
        assert!(!accepted(&event));
        event.as_object_mut().unwrap().remove("command_set_ids");
        assert!(accepted(&event));
    }
    #[test]
    fn escaped_commands_and_repository_targets_preserve_bounds() {
        let mut event = tool();
        event["command"] = "\n".repeat(2048).into();
        assert!(accepted(&event));
        event["command"] = "\n".repeat(2049).into();
        assert!(!accepted(&event));
        event.as_object_mut().unwrap().remove("command");
        assert!(!accepted(&event));
        event.as_object_mut().unwrap().remove("command_truncated");
        event["tool"] = "git_clone".into();
        event["repository"] = "https://git.example/repo.git".into();
        assert!(!accepted(&event));
        event["extension"] = "git".into();
        assert!(accepted(&event));
        event["boundary"] = "smolvm".into();
        assert!(!accepted(&event));
    }
    #[test]
    fn export_variants_are_typed_bounded_and_never_model_tools() {
        let prior = json!({"dev":"1","ino":"2","size":"3","mtimeNs":"-4","ctimeNs":"5"});
        let variants = [
            (
                "export_intent",
                json!({"operationId":"op","destination":"/work","roots":["home","tmp"],"entryCount":2,"fileCount":1,"totalBytes":4,"manifestDigest":"a".repeat(64)}),
            ),
            (
                "export_complete",
                json!({"operationId":"op","destination":"/work","savedFiles":1,"savedBytes":4,"failedFiles":0,"notSavedFiles":0,"cancelled":false}),
            ),
            (
                "export_replace_intent",
                json!({"operationId":"op","destination":"/work","path":"nested/file","prior":prior}),
            ),
            (
                "export_replace_complete",
                json!({"operationId":"op","destination":"/work","path":"nested/file","prior":prior,"outcome":"saved"}),
            ),
        ];
        for (kind, details) in variants {
            let mut event = json!({"event":kind,"pi_session_id":"pi","user_export":details});
            assert!(accepted(&event), "{kind}");
            event["tool"] = "write".into();
            assert!(!accepted(&event));
            event.as_object_mut().unwrap().remove("tool");
            event["user_export"]["destination"] = "relative".into();
            assert!(!accepted(&event));
        }
        let traversal = json!({"event":"export_replace_intent","pi_session_id":"pi","user_export":{"operationId":"op","destination":"/work","path":"../escape","prior":prior}});
        assert!(!accepted(&traversal));
    }
}
