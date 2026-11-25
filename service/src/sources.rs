use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::manifest::{Listener, Manifest, identifier};
use crate::protocol::{CONFIG, Result, normalized, strict_json, toml_json};
use crate::rules::{self, Principal};
use serde_json::{Value, json};

pub(crate) fn protected_directory(path: &Path, owner: u32) -> Result<()> {
    for ancestor in path.ancestors() {
        let m = std::fs::symlink_metadata(ancestor).map_err(|_| CONFIG)?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || !(m.uid() == 0 || m.uid() == owner)
            || m.mode() & 0o022 != 0
        {
            return Err(CONFIG);
        }
    }
    Ok(())
}
pub(crate) fn protected_metadata(path: &Path, max: usize, secret: bool, owner: u32) -> Result<()> {
    if !path.to_str().is_some_and(normalized) {
        return Err(CONFIG);
    }
    protected_directory(path.parent().ok_or(CONFIG)?, owner)?;
    let m = std::fs::symlink_metadata(path).map_err(|_| CONFIG)?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.uid() != owner
        || m.mode() & if secret { 0o777 } else { 0o022 } != if secret { 0o600 } else { 0 }
        || m.len() > max as u64
    {
        return Err(CONFIG);
    }
    Ok(())
}
pub(crate) fn read_protected(path: &Path, max: usize, secret: bool, owner: u32) -> Result<Vec<u8>> {
    protected_metadata(path, max, secret, owner)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| CONFIG)?;
    let m = file.metadata().map_err(|_| CONFIG)?;
    if !m.is_file()
        || m.uid() != owner
        || m.mode() & if secret { 0o777 } else { 0o022 } != if secret { 0o600 } else { 0 }
        || m.len() > max as u64
    {
        return Err(CONFIG);
    }
    read_bounded(file, max)
}
fn read_bounded(file: File, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CONFIG)?;
    if bytes.len() > max {
        return Err(CONFIG);
    }
    Ok(bytes)
}
fn keys(value: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or(CONFIG)?;
    if required.iter().any(|k| !map.contains_key(*k))
        || map
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(CONFIG);
    }
    Ok(())
}
fn bool_field(value: &Value, key: &str) -> Result<()> {
    if !value[key].is_boolean() {
        Err(CONFIG)
    } else {
        Ok(())
    }
}
fn distinct_names(value: &Value, allow_empty: bool) -> Result<Vec<&str>> {
    let values = value.as_array().ok_or(CONFIG)?;
    if values.len() > 32 || (!allow_empty && values.is_empty()) {
        return Err(CONFIG);
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for v in values {
        let s = v.as_str().ok_or(CONFIG)?;
        if !workspace_name(s) || !seen.insert(s) {
            return Err(CONFIG);
        }
        out.push(s)
    }
    Ok(out)
}
pub(crate) fn policy(listener: &Listener, owner: u32) -> Result<Value> {
    let bytes = read_protected(Path::new(&listener.policy_file), 1024 * 1024, false, owner)?;
    let value = toml_json(
        toml::from_str(std::str::from_utf8(&bytes).map_err(|_| CONFIG)?).map_err(|_| CONFIG)?,
    )?;
    validate_policy(&value)?;
    Ok(value)
}
pub(crate) fn audit_enabled(listener: &Listener, owner: u32) -> Result<bool> {
    let bytes = read_protected(Path::new(&listener.policy_file), 1024 * 1024, false, owner)?;
    let value = toml_json(
        toml::from_str(std::str::from_utf8(&bytes).map_err(|_| CONFIG)?).map_err(|_| CONFIG)?,
    )?;
    if value["config_version"] != 16 {
        return Err(CONFIG);
    }
    audit_shape(&value["audit"])?;
    value["audit"]["enabled"].as_bool().ok_or(CONFIG)
}
fn audit_shape(value: &Value) -> Result<()> {
    keys(value, &["enabled", "tools"], &[])?;
    bool_field(value, "enabled")?;
    let tools = value["tools"].as_object().ok_or(CONFIG)?;
    if tools.len() > 256
        || tools.is_empty()
        || tools
            .iter()
            .any(|(k, v)| k.is_empty() || k.len() > 128 || !v.is_boolean())
    {
        return Err(CONFIG);
    }
    Ok(())
}
fn validate_policy(value: &Value) -> Result<()> {
    keys(
        value,
        &[
            "config_version",
            "models_file",
            "codemode",
            "mcp",
            "audit",
            "sessions",
            "execution",
            "filesystem",
            "network",
            "environment",
            "extensions",
            "tools",
            "workspace",
            "model_auth",
        ],
        &["exports", "skills", "subagents", "extension_guidance"],
    )?;
    if value["config_version"] != 16 || !value["models_file"].as_str().is_some_and(normalized) {
        return Err(CONFIG);
    }
    audit_shape(&value["audit"])?;
    if !rules::validate_environment(&value["environment"]) {
        return Err(CONFIG);
    }
    keys(&value["model_auth"], &["personal_providers"], &[])?;
    let providers = value["model_auth"]["personal_providers"]
        .as_array()
        .ok_or(CONFIG)?;
    let mut names = BTreeSet::new();
    if providers.iter().any(|v| {
        !v.as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 256 && names.insert(s))
    }) {
        return Err(CONFIG);
    }
    keys(
        &value["execution"],
        &["backend"],
        &["max_command_timeout_seconds", "command_path_prepend"],
    )?;
    if !["bubblewrap", "seatbelt", "direct"]
        .contains(&value["execution"]["backend"].as_str().ok_or(CONFIG)?)
    {
        return Err(CONFIG);
    }
    if value["execution"]
        .get("max_command_timeout_seconds")
        .is_some_and(|v| {
            !v.as_f64()
                .is_some_and(|n| n > 0.0 && n * 1000.0 <= 2_147_483_647.0)
        })
    {
        return Err(CONFIG);
    }
    if let Some(paths) = value["execution"].get("command_path_prepend")
        && !paths
            .as_array()
            .is_some_and(|a| a.iter().all(|p| p.as_str().is_some_and(normalized)))
    {
        return Err(CONFIG);
    }
    keys(&value["network"], &["mode"], &[])?;
    if !["none", "local", "host"].contains(&value["network"]["mode"].as_str().ok_or(CONFIG)?) {
        return Err(CONFIG);
    }
    keys(
        &value["filesystem"],
        &[],
        &["cwd_writable", "hidden_paths", "denied_paths"],
    )?;
    if value["filesystem"]
        .get("cwd_writable")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(CONFIG);
    }
    let tools = value["tools"].as_object().ok_or(CONFIG)?;
    if tools.iter().any(|(k, v)| {
        !value["audit"]["tools"]
            .as_object()
            .is_some_and(|a| a.contains_key(k))
            || !rules::validate_tool(v, k)
    }) {
        return Err(CONFIG);
    }
    keys(&value["workspace"], &["default", "allowed", "modes"], &[])?;
    let modes = value["workspace"]["modes"].as_object().ok_or(CONFIG)?;
    if modes.is_empty() || modes.len() > 32 || modes.keys().any(|k| !workspace_name(k)) {
        return Err(CONFIG);
    }
    let allowed = distinct_names(&value["workspace"]["allowed"], false)?;
    let default = value["workspace"]["default"].as_str().ok_or(CONFIG)?;
    if !allowed.contains(&default) || allowed.iter().any(|k| !modes.contains_key(*k)) {
        return Err(CONFIG);
    }
    for mode in modes.values() {
        keys(
            mode,
            &[],
            &["description", "filesystem", "exports", "tools"],
        )?;
        if let Some(fs) = mode.get("filesystem") {
            keys(fs, &["cwd_writable"], &[])?;
            bool_field(fs, "cwd_writable")?;
        }
        if let Some(exports) = mode.get("exports") {
            keys(exports, &["enabled"], &[])?;
            bool_field(exports, "enabled")?;
        }
        if let Some(tools) = mode.get("tools") {
            let tools = tools.as_object().ok_or(CONFIG)?;
            if tools.iter().any(|(k, v)| {
                !["bash", "write", "edit"].contains(&k.as_str()) || !rules::validate_tool(v, k)
            }) {
                return Err(CONFIG);
            }
        }
    }
    keys(&value["mcp"], &["servers"], &[])?;
    let servers = value["mcp"]["servers"].as_object().ok_or(CONFIG)?;
    if servers.len() > 32 || servers.keys().any(|k| !identifier(k)) {
        return Err(CONFIG);
    }
    for server in servers.values() {
        let transport = server["transport"].as_str().ok_or(CONFIG)?;
        let extra = match transport {
            "http" => vec![
                "url",
                "headers",
                "headers_from_env",
                "bearer_token_from_env",
            ],
            "stdio" => vec!["command", "args", "env", "env_from_env"],
            _ => return Err(CONFIG),
        };
        let mut optional = vec!["timeout_ms", "tool_rules"];
        optional.extend(extra);
        keys(
            server,
            &["enabled", "transport", "exposure", "default_policy"],
            &optional,
        )?;
        bool_field(server, "enabled")?;
        if !["direct", "codemode"].contains(&server["exposure"].as_str().ok_or(CONFIG)?)
            || !rules::validate_main_mcp_policy(&server["default_policy"], false)
        {
            return Err(CONFIG);
        }
        if let Some(raw) = server.get("tool_rules") {
            let rules = raw.as_array().ok_or(CONFIG)?;
            let mut patterns = BTreeSet::new();
            if rules.len() > 256
                || rules.iter().any(|rule| {
                    !rules::validate_main_mcp_policy(rule, true)
                        || !patterns.insert(rule["match"].as_str().unwrap_or_default())
                })
            {
                return Err(CONFIG);
            }
        }
        // Literal connections, credential projection, exposure/backend combinations
        // and extension semantics are validated by the pinned client.
        if !server[if transport == "http" {
            "url"
        } else {
            "command"
        }]
        .is_string()
        {
            return Err(CONFIG);
        }
    }
    Ok(())
}
pub(crate) fn catalog(path: &str, policy: &Value, owner: u32) -> Result<Value> {
    let bytes = read_protected(Path::new(path), 2 * 1024 * 1024, false, owner)?;
    let catalog = strict_json(&bytes).map_err(|_| CONFIG)?;
    if !catalog.is_object() {
        return Err(CONFIG);
    }
    let providers = catalog["providers"].as_object().ok_or(CONFIG)?;
    let personal = policy["model_auth"]["personal_providers"]
        .as_array()
        .ok_or(CONFIG)?;
    if personal
        .iter()
        .any(|v| !v.as_str().is_some_and(|s| providers.contains_key(s)))
    {
        return Err(CONFIG);
    }
    for (name, provider) in providers {
        if provider.get("oauth").is_some_and(|v| v == "radius")
            && !personal.iter().any(|v| v == name)
        {
            return Err(CONFIG);
        }
    }
    Ok(catalog)
}
pub(crate) fn bootstrap(
    listener: &Listener,
    principal: Principal<'_>,
    owner: u32,
    deadline: Instant,
    inspect: bool,
) -> Result<Value> {
    let mut policy = policy(listener, owner)?;
    if Instant::now() >= deadline {
        return Err(crate::protocol::Error("busy"));
    }
    let resolved = rules::resolve_inputs(&policy, listener, principal, owner, deadline, !inspect)?;
    let models = if inspect {
        None
    } else {
        Some(catalog(&resolved.models_file, &policy, owner)?)
    };
    policy.as_object_mut().ok_or(CONFIG)?.remove("models_file");
    if Instant::now() >= deadline {
        return Err(crate::protocol::Error("busy"));
    }
    if inspect {
        Ok(
            json!({"policy":policy,"workspace_overrides":resolved.overrides.get("workspace").cloned().unwrap_or(Value::Null)}),
        )
    } else {
        Ok(
            json!({"policy":policy,"overrides":resolved.overrides,"environment":resolved.environment,"models":models,"policy_revision":crate::protocol::random_id().map_err(|_|CONFIG)?}),
        )
    }
}
pub fn validate(manifest: &Manifest) -> Result<()> {
    manifest.check()?;
    let owner = manifest.admitted_owner()?;
    for listener in &manifest.listeners {
        listener.validate_material_metadata(owner)?;
        if let Some(certificate) = &listener.certificate_file {
            let bytes = read_protected(Path::new(certificate), 1024 * 1024, false, owner)?;
            let certs = rustls_pemfile::certs(&mut bytes.as_slice())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| CONFIG)?;
            if certs.is_empty() {
                return Err(CONFIG);
            }
        }
        let policy = policy(listener, owner)?;
        let mut catalogs =
            rules::validate_sources(listener, owner, Instant::now() + Duration::from_secs(30))?;
        catalogs.push(policy["models_file"].as_str().ok_or(CONFIG)?.into());
        for path in catalogs.into_iter().collect::<BTreeSet<_>>() {
            catalog(&path, &policy, owner)?;
        }
    }
    Ok(())
}

fn workspace_name(s: &str) -> bool {
    s.len() <= 32
        && s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(6)
    }
    #[test]
    fn bootstrap_keeps_authored_source_and_separately_resolves_winning_secrets() {
        let mut f = Fixture::new();
        f.listener.transport = "https".into();
        let secret = f.write("secret", "opaque{{uid}}$!\r\n", false);
        let missing = f.path.join("missing");
        let input = std::fs::read_to_string(&f.listener.policy_file)
            .unwrap()
            .replace(
                "[environment.pi]",
                &format!(
                    "[environment.pi]\nTOKEN = {{ file = {:?} }}",
                    missing.to_str().unwrap()
                ),
            );
        f.write("policy.toml", input, false);
        f.listener.rule_directory = Some(f.path.join("rules").to_str().unwrap().into());
        f.write(
            "rules/users.d/alice.toml",
            format!(
                "version = 12\nuser = 'alice'\n[environment.pi]\nTOKEN = {{ file = {:?} }}",
                secret.to_str().unwrap()
            ),
            true,
        );
        let result = bootstrap(
            &f.listener,
            Principal::Https("alice"),
            f.owner,
            deadline(),
            false,
        )
        .unwrap();
        assert!(result["policy"].get("models_file").is_none());
        assert_eq!(
            result["policy"]["environment"]["pi"]["TOKEN"]["file"],
            missing.to_str().unwrap()
        );
        assert_eq!(
            result["environment"]["pi"]["TOKEN"]["literal"],
            "opaque{{uid}}$!"
        );
        assert_eq!(result["overrides"], json!({"tools":{}}));
        assert!(crate::protocol::hex_id(
            result["policy_revision"].as_str().unwrap()
        ));
    }
    #[test]
    fn inspection_and_audit_open_do_not_read_catalog_or_secret_refs() {
        let f = Fixture::new();
        std::fs::remove_file(f.path.join("models.json")).unwrap();
        let input = std::fs::read_to_string(&f.listener.policy_file)
            .unwrap()
            .replace(
                "[environment.pi]",
                &format!(
                    "[environment.pi]\nTOKEN = {{ file = {:?} }}",
                    f.path.join("missing").to_str().unwrap()
                ),
            );
        f.write("policy.toml", input, false);
        let result = bootstrap(
            &f.listener,
            Principal::Unix(f.owner),
            f.owner,
            deadline(),
            true,
        )
        .unwrap();
        assert_eq!(result["workspace_overrides"], Value::Null);
        assert!(result.get("environment").is_none());
        assert!(audit_enabled(&f.listener, f.owner).unwrap());
        assert!(
            bootstrap(
                &f.listener,
                Principal::Unix(f.owner),
                f.owner,
                deadline(),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn matching_inventory_only_and_http_selector_restrictions() {
        let mut f = Fixture::new();
        f.listener.transport = "https".into();
        f.listener.rule_directory = Some(f.path.join("rules").to_str().unwrap().into());
        f.write("rules/users.d/other.toml","version = 12\nuser = 'other'\n[overrides.tools.unknown]\nmode = 'allow'\nsession_grant = 'never'",true);
        assert!(
            bootstrap(
                &f.listener,
                Principal::Https("alice"),
                f.owner,
                deadline(),
                false
            )
            .is_ok()
        );
        assert!(
            bootstrap(
                &f.listener,
                Principal::Https("other"),
                f.owner,
                deadline(),
                false
            )
            .is_err()
        );
        f.write("rules/users.d/other.toml", "version = 12\nuid = 42", true);
        assert!(
            bootstrap(
                &f.listener,
                Principal::Https("alice"),
                f.owner,
                deadline(),
                true
            )
            .is_err()
        );
        f.write(
            "rules/users.d/other.toml",
            "version = 12\nuser = 'other'",
            true,
        );
        f.write("rules/groups.d/README", "nonempty", false);
        assert!(
            bootstrap(
                &f.listener,
                Principal::Https("alice"),
                f.owner,
                deadline(),
                true
            )
            .is_err()
        );
    }
    #[test]
    fn partial_common_workspace_keeps_hyphenated_modes_and_shared_tool_inventory() {
        let f = Fixture::new();
        let mut source = policy(&f.listener, f.owner).unwrap();
        source["filesystem"]
            .as_object_mut()
            .unwrap()
            .remove("cwd_writable");
        source.as_object_mut().unwrap().remove("exports");
        source["tools"].as_object_mut().unwrap().remove("write");
        source["workspace"] = json!({"default":"read-only","allowed":["read-only"],"modes":{"read-only":{"filesystem":{"cwd_writable":false},"exports":{"enabled":false},"tools":{"write":{"mode":"deny","session_grant":"never"}}}}});
        assert!(validate_policy(&source).is_ok());
    }
    #[test]
    fn protected_inputs_reject_symlinks_unsafe_modes_and_obsolete_facility() {
        let f = Fixture::new();
        let link = f.path.join("linked");
        symlink(f.path.join("models.json"), &link).unwrap();
        assert!(read_protected(&link, 1024 * 1024, false, f.owner).is_err());
        let path = f.path.join("models.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read_protected(&path, 1024 * 1024, false, f.owner).is_err());
        let mut source = policy(&f.listener, f.owner).unwrap();
        source["audit"]["facility"] = "local0".into();
        assert!(validate_policy(&source).is_err());
    }
    #[test]
    fn catalog_rejects_duplicates_and_unadmitted_personal_provider() {
        let f = Fixture::new();
        let mut policy = policy(&f.listener, f.owner).unwrap();
        f.write("models.json", b"{\"providers\":{},\"providers\":{}}", false);
        assert!(
            catalog(
                f.path.join("models.json").to_str().unwrap(),
                &policy,
                f.owner
            )
            .is_err()
        );
        f.write("models.json", b"{\"providers\":{}}", false);
        policy["model_auth"]["personal_providers"] = json!(["not-configured"]);
        assert!(
            catalog(
                f.path.join("models.json").to_str().unwrap(),
                &policy,
                f.owner
            )
            .is_err()
        );
    }
}
