// Versioned staging of the factory role plugins (change factory-roles, task 2.2).
//
// The bundle's `factory/` is read-only and signed, so each role is staged into
// `<app data>/factory/v-<hash>/<role>/` and `<app data>/factory/current` names the version a spawn uses.
// A version folder is built in a temp sibling, then renamed into place; it is never changed afterwards, so a
// running agent (also after an app restart) keeps the exact files it started with. Nothing here deletes an old
// version: a spawn can read the old `current` just before a new one is published (backlog: safe cleanup).
use std::fs;
use std::path::{Path, PathBuf};

const TMP_PREFIX: &str = ".stage.tmp-";
static STAGE_RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn factory_dir() -> PathBuf {
    super::app_data_dir().join("factory")
}

// Same candidates as resolve_chatbridge_mod_js; the last one is the repo's `factory/` during `tauri dev`.
pub(crate) fn resolve_factory_src() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or_else(|| "no exe dir".to_string())?.to_path_buf();
    let candidates = [
        exe_dir.join("../Resources/factory"),
        exe_dir.join("../Resources/resources/factory"),
        exe_dir.join("../../../factory"),
    ];
    candidates
        .iter()
        .find(|p| p.join("worker/worker.md").is_file())
        .cloned()
        .ok_or_else(|| format!("bundled factory/ not found near {} (checked {:?})", exe_dir.display(), candidates))
}

// The role file without its YAML frontmatter (`---` ... `---`). No frontmatter: the whole file.
fn strip_frontmatter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n") else { return text };
    match rest.find("\n---\n") {
        Some(i) => &rest[i + 5..],
        None => text,
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let mut entries: Vec<_> = fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name();
        if name == ".DS_Store" {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        let ty = e.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_tree(&src, &dst)?;
        } else if ty.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("copy {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

// A role is a folder `<name>/<name>.md`; `shared` has a manifest and no role file.
fn stage_role(src: &Path, role: &str, tmp: &Path) -> Result<(), String> {
    let dst = tmp.join(role);
    if role == "shared" {
        return copy_tree(src, &dst);
    }
    let mut manifest = serde_json::Map::new();
    manifest.insert("name".into(), format!("factory-{role}").into());
    fs::create_dir_all(dst.join(".claude-plugin")).map_err(|e| e.to_string())?;
    fs::write(
        dst.join(".claude-plugin/plugin.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if src.join("skills").is_dir() {
        copy_tree(&src.join("skills"), &dst.join("skills"))?;
    }
    let md = src.join(format!("{role}.md"));
    let text = fs::read_to_string(&md).map_err(|e| format!("read {}: {e}", md.display()))?;
    fs::write(dst.join("role.md"), strip_frontmatter(&text)).map_err(|e| e.to_string())?;
    // hooks/hooks.json only; no `agents/` (the role plugin has skills and hooks only).
    if src.join("hooks/hooks.json").is_file() {
        fs::create_dir_all(dst.join("hooks")).map_err(|e| e.to_string())?;
        fs::copy(src.join("hooks/hooks.json"), dst.join("hooks/hooks.json")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// The `name:` value of a SKILL.md frontmatter, quotes stripped. None when there is no frontmatter or no name.
fn skill_name(text: &str) -> Option<String> {
    let rest = text.strip_prefix("---\n")?;
    let fm = &rest[..rest.find("\n---")?];
    fm.lines()
        .find_map(|l| l.strip_prefix("name:"))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
}

// The user layer (task 8.1): `<user>/<role>/skills/<name>/` replaces the staged `<role>/skills/<name>/` as a
// whole (the bundled folder is removed first, so no bundled support file survives). The folder name is the key
// and must equal the SKILL.md `name`; a mismatch is skipped and logged. Runs before hash_tree, so the layer is
// part of the version hash. The only write to `user` is creating the empty skills folders.
fn apply_user_layer(user: &Path, tmp: &Path, roles: &[String]) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    for role in roles {
        let skills = user.join(role).join("skills");
        fs::create_dir_all(&skills).map_err(|e| format!("create {}: {e}", skills.display()))?;
        let mut entries: Vec<_> = fs::read_dir(&skills).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if !e.path().is_dir() || name.starts_with('.') {
                continue;
            }
            let declared = fs::read_to_string(e.path().join("SKILL.md")).ok().and_then(|t| skill_name(&t));
            if declared.as_deref() != Some(name.as_str()) {
                log.push(format!(
                    "[factory] skipped user skill {role}/{name}: folder name does not match the SKILL.md name ({})",
                    declared.as_deref().unwrap_or("missing")
                ));
                continue;
            }
            let target = tmp.join(role).join("skills").join(&name);
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
                log.push(format!("[factory] user skill replaces bundled skill: role={role} skill={name}"));
            }
            copy_tree(&e.path(), &target)?;
        }
    }
    Ok(log)
}

// FNV-1a 64 over every file's relative path and bytes, in sorted order. Stable across Rust versions (unlike
// DefaultHasher), so one input set gives one `v-<hash>` across builds. Not a security hash; it names a folder.
fn hash_tree(root: &Path) -> Result<String, String> {
    fn walk(dir: &Path, rel: &Path, h: &mut u64) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let rel = rel.join(e.file_name());
            if e.file_type().map_err(|e| e.to_string())?.is_dir() {
                fnv(h, format!("d:{}\0", rel.display()).as_bytes());
                walk(&e.path(), &rel, h)?;
            } else {
                fnv(h, format!("f:{}\0", rel.display()).as_bytes());
                fnv(h, &fs::read(e.path()).map_err(|e| e.to_string())?);
            }
        }
        Ok(())
    }
    fn fnv(h: &mut u64, bytes: &[u8]) {
        for b in bytes {
            *h ^= *b as u64;
            *h = h.wrapping_mul(0x100000001b3);
        }
    }
    let mut h = 0xcbf29ce484222325u64;
    walk(root, Path::new(""), &mut h)?;
    Ok(format!("v-{h:016x}"))
}

fn sweep_stale_tmp(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(TMP_PREFIX) else { continue };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else { continue };
        if !super::pid_is_running(pid) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

// Stage every role in `src` plus `shared` (and the user layer in `user`) into a version folder under `dest`
// and point `current` at it.
// Returns the version name. An identical input set reuses its existing version folder.
pub(crate) fn stage_factory(src: &Path, dest: &Path, user: &Path) -> Result<String, String> {
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    sweep_stale_tmp(dest);
    let run = STAGE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = dest.join(format!("{TMP_PREFIX}{}-{run}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);

    let build = || -> Result<String, String> {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let mut names: Vec<String> = fs::read_dir(src)
            .map_err(|e| format!("read {}: {e}", src.display()))?
            .flatten()
            .filter(|e| e.path().join(format!("{}.md", e.file_name().to_string_lossy())).is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for role in &names {
            stage_role(&src.join(role), role, &tmp)?;
        }
        if src.join("shared").is_dir() {
            stage_role(&src.join("shared"), "shared", &tmp)?;
            names.push("shared".to_string());
        }
        for line in apply_user_layer(user, &tmp, &names)? {
            eprintln!("{line}");
        }
        hash_tree(&tmp)
    };
    let version = match build() {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(format!("stage factory: {e}"));
        }
    };

    let final_dir = dest.join(&version);
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&tmp); // identical inputs: reuse
    } else if let Err(e) = fs::rename(&tmp, &final_dir) {
        let _ = fs::remove_dir_all(&tmp);
        // A concurrent run published the same version first: reuse it.
        if !final_dir.exists() {
            return Err(format!("stage factory: install {version}: {e}"));
        }
    }

    let cur_tmp = dest.join(format!("current.tmp-{}-{run}", std::process::id()));
    fs::write(&cur_tmp, &version).map_err(|e| format!("write current: {e}"))?;
    fs::rename(&cur_tmp, dest.join("current")).map_err(|e| {
        let _ = fs::remove_file(&cur_tmp);
        format!("publish current: {e}")
    })?;
    Ok(version)
}

// The version folder a spawn uses: whatever `current` names, if that folder exists.
pub(crate) fn current_version_dir() -> Result<PathBuf, String> {
    let dest = factory_dir();
    let name = fs::read_to_string(dest.join("current")).map_err(|e| format!("factory/current: {e}"))?;
    let dir = dest.join(name.trim());
    if dir.is_dir() { Ok(dir) } else { Err(format!("factory version {} is missing", name.trim())) }
}

pub(crate) fn materialize_factory() -> Result<String, String> {
    stage_factory(&resolve_factory_src()?, &factory_dir(), &super::app_data_dir().join("factory-user"))
}

// ---- Per-agent settings (task 2.3; same rules as write_settings in factory/scripts/factory-launch.sh, task 1.3) ----
pub(crate) fn factory_settings_dir() -> PathBuf {
    super::app_data_dir().join("factory-settings")
}

// Skill (and slash command) names that a role launch turns off. `skills/<name>/SKILL.md` counts when it exists
// (`name:` in its frontmatter, else the folder name); a command `commands/a/b.md` is listed as `a:b`.
fn skill_override_names(root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join("skills")) {
        for e in entries.flatten() {
            let skill_md = e.path().join("SKILL.md"); // follows symlinked skill folders
            let Ok(text) = fs::read_to_string(&skill_md) else { continue };
            let folder = e.file_name().to_string_lossy().into_owned();
            names.push(skill_name(&text).filter(|n| !n.is_empty()).unwrap_or(folder));
        }
    }
    fn commands(base: &Path, rel: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(base.join(rel)) else { return };
        for e in entries.flatten() {
            let path = rel.join(e.file_name());
            if e.path().is_dir() {
                commands(base, &path, out);
            } else if path.extension().is_some_and(|x| x == "md") {
                out.push(path.with_extension("").to_string_lossy().replace('/', ":"));
            }
        }
    }
    commands(&root.join("commands"), Path::new(""), &mut names);
    names
}

// settings for one launch: installed marketplace plugins off (not the --plugin-dir ones: role, shared and
// chatbridge are never in installed_plugins.json), user and project skills and commands off. Account-synced
// plugins stay on: no setting turns them off (check 0.2).
pub(crate) fn build_agent_settings(role: &str, user_claude: &Path, project: &Path) -> serde_json::Value {
    let mut plugins: Vec<String> = fs::read_to_string(user_claude.join("plugins/installed_plugins.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("plugins").and_then(|p| p.as_object()).map(|o| o.keys().cloned().collect()))
        .unwrap_or_default();
    // These stay on whatever installed_plugins.json says: the role plugin, the shared plugin and the chatbridge mod.
    let keep = [format!("factory-{role}@inline"), "factory-shared@inline".to_string(), "chatbridge@inline".to_string()];
    plugins.retain(|k| !keep.contains(k));
    plugins.sort();
    let mut skills = skill_override_names(user_claude);
    skills.extend(skill_override_names(&project.join(".claude")));
    skills.sort();
    skills.dedup();
    serde_json::json!({
        "enabledPlugins": plugins.into_iter().map(|k| (k, false.into())).collect::<serde_json::Map<_, _>>(),
        "skillOverrides": skills.into_iter().map(|k| (k, "off".into())).collect::<serde_json::Map<_, _>>(),
    })
}

// <dir>/<agent>.json, mode 0600, tmpfile + rename. One file per agent, outside the version folders, because the
// lists depend on the agent's project folder.
pub(crate) fn write_agent_settings(agent: &str, role: &str, project: &Path, user_claude: &Path, dir: &Path) -> Result<PathBuf, String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    if agent.is_empty() || agent.starts_with('.') || agent.contains('/') || agent.contains('\\') {
        return Err(format!("invalid agent name for a settings file: {agent:?}"));
    }
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&build_agent_settings(role, user_claude, project)).map_err(|e| e.to_string())?;
    let run = STAGE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = dir.join(format!(".{agent}.json.tmp-{}-{run}", std::process::id()));
    let path = dir.join(format!("{agent}.json"));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", path.display()));
    }
    Ok(path)
}

// ---- Role frontmatter (task 3.1) ----
// The staged role has no frontmatter (role.md is the body only), so the spec is read from the bundled
// `factory/<role>/<role>.md`; the staged version folder only tells whether the role is staged.
#[derive(Debug, PartialEq)]
pub(crate) struct RoleSpec {
    pub name: String,
    pub harness: String, // "claude" when the file has no `harness:`
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub disallowed_tools: Vec<String>,
    pub exclude_tools: Vec<String>,
}

// A role name is a folder name: lowercase letters, digits, '-' and '_'. Never a path.
pub(crate) fn valid_role_name(role: &str) -> bool {
    !role.is_empty() && role.len() <= 40 && role.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn frontmatter_value(text: &str, key: &str) -> Option<String> {
    let rest = text.strip_prefix("---\n")?;
    let fm = &rest[..rest.find("\n---")?];
    fm.lines()
        .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(':')))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
}

fn csv_list(v: Option<String>) -> Vec<String> {
    v.map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default()
}

// A council role (`council:` key: a11y, seo) is not a single agent and has no launch command.
pub(crate) fn parse_role_spec(role: &str, text: &str) -> Result<RoleSpec, String> {
    if frontmatter_value(text, "council").is_some() {
        return Err(format!("role '{role}' is a council, not a single agent; it cannot be spawned"));
    }
    let name = frontmatter_value(text, "name").ok_or_else(|| format!("role '{role}': no frontmatter name"))?;
    if name != role {
        return Err(format!("role '{role}': frontmatter name is '{name}'"));
    }
    let harness = frontmatter_value(text, "harness").filter(|h| !h.is_empty()).unwrap_or_else(|| "claude".to_string());
    if harness != "claude" && harness != "pi" {
        return Err(format!("role '{role}': unknown harness '{harness}'"));
    }
    let opt = |k: &str| frontmatter_value(text, k).filter(|v| !v.is_empty());
    Ok(RoleSpec {
        name,
        harness,
        provider: opt("provider"),
        model: opt("model"),
        thinking: opt("thinking"),
        disallowed_tools: csv_list(frontmatter_value(text, "disallowedTools")),
        exclude_tools: csv_list(frontmatter_value(text, "excludeTools")),
    })
}

// Unknown role (bad name, no file, or not staged in the current version) is an error: nothing launches.
pub(crate) fn load_role_spec(role: &str, src: &Path, version_dir: &Path) -> Result<RoleSpec, String> {
    if !valid_role_name(role) {
        return Err(format!("invalid role: {role:?}"));
    }
    let text = fs::read_to_string(src.join(role).join(format!("{role}.md"))).map_err(|_| format!("unknown role: {role}"))?;
    let spec = parse_role_spec(role, &text)?;
    if !version_dir.join(role).join("role.md").is_file() {
        return Err(format!("role '{role}' is not staged in {}", version_dir.display()));
    }
    Ok(spec)
}

// The spec a spawn uses: bundled frontmatter + the version `current` names.
pub(crate) fn resolve_role_spec(role: &str) -> Result<RoleSpec, String> {
    load_role_spec(role, &resolve_factory_src()?, &current_version_dir()?)
}

// ---- Launch with a role (tasks 3.2 and 3.3) ----
// Everything a command builder needs for a role, resolved up front so the builders stay pure.
#[derive(Debug, PartialEq)]
pub(crate) struct RoleLaunch {
    pub name: String,
    pub harness: String,       // "claude" or "pi"
    pub plugin_dir: PathBuf,   // <version>/<role>
    pub shared_dir: PathBuf,   // <version>/shared
    pub prompt_file: PathBuf,  // <version>/<role>/role.md
    pub settings: Option<PathBuf>, // <app data>/factory-settings/<agent>.json; Claude roles only
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub effort: Option<String>, // Claude only: set by the human's choice for one launch (roles have no default)
    pub disallowed_tools: Vec<String>, // Claude
    pub exclude_tools: Vec<String>,    // Pi
}

pub(crate) fn role_launch(spec: &RoleSpec, version_dir: &Path, settings: Option<PathBuf>) -> RoleLaunch {
    let plugin_dir = version_dir.join(&spec.name);
    RoleLaunch {
        name: spec.name.clone(),
        harness: spec.harness.clone(),
        prompt_file: plugin_dir.join("role.md"),
        plugin_dir,
        shared_dir: version_dir.join("shared"),
        settings,
        provider: spec.provider.clone(),
        model: spec.model.clone(),
        thinking: spec.thinking.clone(),
        effort: None,
        disallowed_tools: spec.disallowed_tools.clone(),
        exclude_tools: spec.exclude_tools.clone(),
    }
}

// IO side of a spawn: the role spec, the version `current` names, and for a Claude role this agent's settings
// file (project = cwd).
pub(crate) fn resolve_role_launch(agent: &str, role: &str, cwd: &Path) -> Result<RoleLaunch, String> {
    let version_dir = current_version_dir()?;
    let spec = load_role_spec(role, &resolve_factory_src()?, &version_dir)?;
    let settings = if spec.harness == "claude" {
        let user_claude = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?.join(".claude");
        Some(write_agent_settings(agent, role, cwd, &user_claude, &factory_settings_dir())?)
    } else {
        None
    };
    Ok(role_launch(&spec, &version_dir, settings))
}

// ---- Model override for one launch (task 5.2) ----
// A model id as the UI sends it: letters, digits and . _ : / - only. It goes into a shell command (quoted), so
// anything else is refused rather than escaped.
pub(crate) fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 80 && m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
}

// What the human picked in the model x effort grid for ONE launch (task 5.5). Every field is optional: only what
// differs from the role default (or, without a role, what the human picked) is set. `provider` is Pi only.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct LaunchChoice {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub effort: Option<String>,
}

pub(crate) const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
pub(crate) const PI_EFFORTS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// A provider id as pi lists it: lowercase letters, digits and . _ -. It goes into a quoted shell command.
pub(crate) fn valid_provider(p: &str) -> bool {
    !p.is_empty() && p.len() <= 40 && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

// Blank means not set. Anything else is checked and refused when it is not valid for the harness: a typo must show,
// not launch a different agent. The Claude effort levels and the Pi thinking levels differ.
pub(crate) fn launch_choice(
    is_pi: bool,
    model: Option<&str>,
    provider: Option<&str>,
    effort: Option<&str>,
) -> Result<LaunchChoice, String> {
    let clean = |v: Option<&str>| v.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let (model, provider, effort) = (clean(model), clean(provider), clean(effort));
    if let Some(m) = &model {
        if !valid_model(m) {
            return Err(format!("invalid model: {m:?}"));
        }
    }
    if let Some(p) = &provider {
        if !is_pi {
            return Err(format!("a provider ({p:?}) only applies to a Pi launch"));
        }
        if !valid_provider(p) {
            return Err(format!("invalid provider: {p:?}"));
        }
    }
    if let Some(e) = &effort {
        let (allowed, what): (&[&str], &str) = if is_pi { (&PI_EFFORTS, "thinking level") } else { (&CLAUDE_EFFORTS, "effort") };
        if !allowed.contains(&e.as_str()) {
            return Err(format!("invalid {what} {e:?} (allowed: {})", allowed.join(", ")));
        }
    }
    Ok(LaunchChoice { model, provider, effort })
}

// Applies the choice to ONE launch. The role file and the staged version are not touched, so the next launch of the
// role has its own default again. Effort is `--effort` for Claude and the thinking level for Pi.
pub(crate) fn with_choice(mut launch: RoleLaunch, choice: &LaunchChoice) -> RoleLaunch {
    if let Some(m) = &choice.model {
        launch.model = Some(m.clone());
    }
    if launch.harness == "pi" {
        if let Some(p) = &choice.provider {
            launch.provider = Some(p.clone());
        }
        if let Some(e) = &choice.effort {
            launch.thinking = Some(e.clone());
        }
    } else if let Some(e) = &choice.effort {
        launch.effort = Some(e.clone());
    }
    launch
}

// ---- Role list for the spawn modal (task 5.1) ----
#[derive(Debug, PartialEq, serde::Serialize)]
pub(crate) struct RoleInfo {
    pub name: String,
    pub harness: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
}

// Single-agent roles that the given staged version contains, sorted by name. A council (a11y, seo), a folder without
// a role file and `shared` are not roles and are left out.
pub(crate) fn list_roles_in(src: &Path, version_dir: &Path) -> Vec<RoleInfo> {
    let mut out: Vec<RoleInfo> = fs::read_dir(version_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| load_role_spec(&e.file_name().to_string_lossy(), src, version_dir).ok())
        .map(|s| RoleInfo { name: s.name, harness: s.harness, provider: s.provider, model: s.model, thinking: s.thinking })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub(crate) fn list_roles() -> Result<Vec<RoleInfo>, String> {
    Ok(list_roles_in(&resolve_factory_src()?, &current_version_dir()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cubilot-factory-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    // A source tree: worker (skills, agents/, hooks), editor (skills only), shared, and a non-role folder.
    fn make_src(root: &Path) -> PathBuf {
        let src = root.join("src");
        let w = src.join("worker");
        fs::create_dir_all(w.join("skills/tdd")).unwrap();
        fs::create_dir_all(w.join("agents")).unwrap();
        fs::create_dir_all(w.join("hooks")).unwrap();
        fs::write(w.join("worker.md"), "---\nname: worker\nmodel: sonnet\n---\nYou are a Worker.\n").unwrap();
        fs::write(w.join("skills/tdd/SKILL.md"), "tdd v1").unwrap();
        fs::write(w.join("agents/helper.md"), "agent").unwrap();
        fs::write(w.join("hooks/hooks.json"), "{\"hooks\":{}}").unwrap();
        let e = src.join("editor");
        fs::create_dir_all(e.join("skills/ste")).unwrap();
        fs::write(e.join("editor.md"), "no frontmatter body").unwrap();
        fs::write(e.join("skills/ste/SKILL.md"), "ste").unwrap();
        let s = src.join("shared");
        fs::create_dir_all(s.join(".claude-plugin")).unwrap();
        fs::create_dir_all(s.join("skills/asd")).unwrap();
        fs::write(s.join(".claude-plugin/plugin.json"), "{\"name\": \"factory-shared\"}").unwrap();
        fs::write(s.join("skills/asd/SKILL.md"), "asd").unwrap();
        fs::create_dir_all(src.join("brief")).unwrap();
        fs::write(src.join("brief/00.md"), "not a role").unwrap();
        src
    }

    #[test]
    fn stages_roles_without_frontmatter_or_agents() {
        let root = tmp_root("roles");
        let src = make_src(&root);
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let w = dest.join(&v).join("worker");
        assert_eq!(fs::read_to_string(dest.join("current")).unwrap(), v);
        assert_eq!(fs::read_to_string(w.join("role.md")).unwrap(), "You are a Worker.\n");
        assert_eq!(fs::read_to_string(w.join(".claude-plugin/plugin.json")).unwrap().contains("factory-worker"), true);
        assert!(w.join("skills/tdd/SKILL.md").is_file());
        assert!(!w.join("agents").exists(), "test 7: no agents/ folder");
        assert!(w.join("hooks/hooks.json").is_file(), "test 8: hooks copied");
        let e = dest.join(&v).join("editor");
        assert!(!e.join("hooks").exists());
        assert_eq!(fs::read_to_string(e.join("role.md")).unwrap(), "no frontmatter body");
        assert!(dest.join(&v).join("shared/.claude-plugin/plugin.json").is_file());
        assert!(dest.join(&v).join("shared/skills/asd/SKILL.md").is_file());
        assert!(!dest.join(&v).join("brief").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn same_inputs_reuse_one_version_and_changes_leave_old_untouched() {
        let root = tmp_root("reuse");
        let src = make_src(&root);
        let dest = root.join("out");
        let v1 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        assert_eq!(stage_factory(&src, &dest, &root.join("user")).unwrap(), v1, "test 13: same inputs reuse");
        let before = fs::read_to_string(dest.join(&v1).join("worker/skills/tdd/SKILL.md")).unwrap();
        fs::write(src.join("worker/skills/tdd/SKILL.md"), "tdd v2").unwrap();
        let v2 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        assert_ne!(v1, v2);
        assert_eq!(fs::read_to_string(dest.join("current")).unwrap(), v2);
        assert_eq!(fs::read_to_string(dest.join(&v1).join("worker/skills/tdd/SKILL.md")).unwrap(), before);
        assert!(dest.join(&v1).is_dir(), "no old version is deleted");
        let versions = fs::read_dir(&dest).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("v-")).count();
        assert_eq!(versions, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_generated_files_do_not_change_reuse() {
        let root = tmp_root("claude");
        let src = make_src(&root);
        let dest = root.join("out");
        let v1 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        // Claude Code adds these to a loaded plugin folder; they are not staged inputs.
        fs::create_dir_all(dest.join(&v1).join("worker/.claude-plugin/types")).unwrap();
        fs::write(dest.join(&v1).join("worker/.gitignore"), "x").unwrap();
        assert_eq!(stage_factory(&src, &dest, &root.join("user")).unwrap(), v1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_stages_give_a_complete_current() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let root = tmp_root("race");
        let src = make_src(&root);
        // A second tree with one different skill file: two inputs make `current` flip between two versions.
        let root2 = tmp_root("race2");
        let src2 = make_src(&root2);
        fs::write(src2.join("worker/skills/tdd/SKILL.md"), "tdd other").unwrap();
        let dest = root.join("out");
        // What a spawn does: read `current`, then expect that folder to be complete.
        fn assert_current_complete(d: &Path) -> bool {
            let Ok(name) = fs::read_to_string(d.join("current")) else { return false }; // not published yet
            assert!(d.join(name.trim()).join("worker/role.md").is_file(), "current names an incomplete {name}");
            true
        }
        let stop = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let reader = {
            let (d, stop, reads) = (dest.clone(), stop.clone(), reads.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    if assert_current_complete(&d) {
                        reads.fetch_add(1, Ordering::SeqCst);
                    }
                }
            })
        };
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let (s, d, u) = (if i < 4 { src.clone() } else { src2.clone() }, dest.clone(), root.join("user"));
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        let v = stage_factory(&s, &d, &u).unwrap();
                        assert!(d.join(&v).join("worker/role.md").is_file());
                        assert!(assert_current_complete(&d), "current exists after a stage");
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        stop.store(true, Ordering::SeqCst);
        reader.join().unwrap();
        assert!(reads.load(Ordering::SeqCst) > 0, "the reader saw current at least once");
        assert!(assert_current_complete(&dest));
        let versions = fs::read_dir(&dest).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("v-")).count();
        assert_eq!(versions, 2, "both input sets were published");
        let _ = fs::remove_dir_all(&root2);
        let leftovers = fs::read_dir(&dest).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with('.')).count();
        assert_eq!(leftovers, 0, "no temp dirs left");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_stage_keeps_current() {
        let root = tmp_root("fail");
        let src = make_src(&root);
        let dest = root.join("out");
        let v1 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        assert!(stage_factory(&root.join("missing"), &dest, &root.join("user")).is_err());
        assert_eq!(fs::read_to_string(dest.join("current")).unwrap(), v1);
        let _ = fs::remove_dir_all(&root);
    }

    fn put_skill(user: &Path, role: &str, folder: &str, name: &str, files: &[(&str, &str)]) {
        let d = user.join(role).join("skills").join(folder);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\nuser body\n")).unwrap();
        for (f, c) in files {
            fs::write(d.join(f), c).unwrap();
        }
    }

    #[test]
    fn user_skill_replaces_bundled_as_a_whole_and_deletion_restores_it() {
        let root = tmp_root("user-replace");
        let src = make_src(&root);
        fs::write(src.join("worker/skills/tdd/extra.md"), "bundled support file").unwrap();
        let (dest, user) = (root.join("out"), root.join("user"));
        let v1 = stage_factory(&src, &dest, &user).unwrap();
        assert!(user.join("worker/skills").is_dir(), "empty folder created on first start");
        assert!(user.join("shared/skills").is_dir());
        assert!(dest.join(&v1).join("worker/skills/tdd/extra.md").is_file());

        put_skill(&user, "worker", "tdd", "tdd", &[("mine.md", "x")]);
        let v2 = stage_factory(&src, &dest, &user).unwrap();
        assert_ne!(v1, v2, "the user layer is part of the hash");
        let t = dest.join(&v2).join("worker/skills/tdd");
        assert!(fs::read_to_string(t.join("SKILL.md")).unwrap().contains("user body"));
        assert!(t.join("mine.md").is_file());
        assert!(!t.join("extra.md").exists(), "no file merge: the bundled support file is absent");

        fs::remove_dir_all(user.join("worker/skills/tdd")).unwrap();
        let v3 = stage_factory(&src, &dest, &user).unwrap();
        assert_eq!(v3, v1, "same inputs as before the override");
        assert_eq!(fs::read_to_string(dest.join(&v3).join("worker/skills/tdd/SKILL.md")).unwrap(), "tdd v1");
        assert!(dest.join(&v3).join("worker/skills/tdd/extra.md").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_only_skill_appears_then_is_absent_after_deletion_and_shared_works() {
        let root = tmp_root("user-only");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        put_skill(&user, "editor", "mine", "mine", &[]);
        put_skill(&user, "shared", "asd", "asd", &[]);
        let v1 = stage_factory(&src, &dest, &user).unwrap();
        assert!(dest.join(&v1).join("editor/skills/mine/SKILL.md").is_file());
        assert!(fs::read_to_string(dest.join(&v1).join("shared/skills/asd/SKILL.md")).unwrap().contains("user body"));
        fs::remove_dir_all(user.join("editor/skills/mine")).unwrap();
        let v2 = stage_factory(&src, &dest, &user).unwrap();
        assert!(!dest.join(&v2).join("editor/skills/mine").exists());
        assert!(dest.join(&v1).join("editor/skills/mine").is_dir(), "the old version is unchanged");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_skill_with_mismatched_name_is_skipped_and_logged() {
        let root = tmp_root("user-skip");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        put_skill(&user, "worker", "tdd", "other-name", &[]);
        put_skill(&user, "worker", "nofm", "nofm", &[]);
        fs::write(user.join("worker/skills/nofm/SKILL.md"), "no frontmatter").unwrap();
        let v = stage_factory(&src, &dest, &user).unwrap();
        assert_eq!(fs::read_to_string(dest.join(&v).join("worker/skills/tdd/SKILL.md")).unwrap(), "tdd v1");
        assert!(!dest.join(&v).join("worker/skills/nofm").exists());
        let tmp = root.join("tmp-layer");
        fs::create_dir_all(tmp.join("worker/skills/tdd")).unwrap();
        let log = apply_user_layer(&user, &tmp, &["worker".to_string()]).unwrap();
        assert_eq!(log.len(), 2, "{log:?}");
        assert!(log.iter().any(|l| l.contains("skipped user skill worker/tdd") && l.contains("other-name")));
        assert!(log.iter().any(|l| l.contains("worker/nofm") && l.contains("missing")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn override_logs_one_line_with_role_and_skill() {
        let root = tmp_root("user-log");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        let v = stage_factory(&src, &dest, &user).unwrap();
        put_skill(&user, "worker", "tdd", "tdd", &[]);
        put_skill(&user, "worker", "brand-new", "brand-new", &[]);
        let tmp = root.join("layer");
        copy_tree(&dest.join(&v).join("worker"), &tmp.join("worker")).unwrap();
        let log = apply_user_layer(&user, &tmp, &["worker".to_string()]).unwrap();
        assert_eq!(log, vec!["[factory] user skill replaces bundled skill: role=worker skill=tdd".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    fn fake_home(root: &Path) -> PathBuf {
        let home = root.join("home");
        fs::create_dir_all(home.join(".claude/plugins")).unwrap();
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            r#"{"version":2,"plugins":{"ponytail@ponytail":[],"figma@official":[],"chatbridge@inline":[],"factory-worker@inline":[],"factory-shared@inline":[]}}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join(".claude/skills/humanizer")).unwrap();
        fs::write(home.join(".claude/skills/humanizer/SKILL.md"), "---\nname: humanizer\n---\n").unwrap();
        fs::create_dir_all(home.join(".claude/skills/synced")).unwrap(); // no SKILL.md: not a skill
        fs::create_dir_all(home.join(".claude/commands/opsx")).unwrap();
        fs::write(home.join(".claude/commands/opsx/apply.md"), "x").unwrap();
        fs::write(home.join(".claude/commands/plan-product.md"), "x").unwrap();
        home
    }

    #[test]
    fn agent_settings_turn_off_plugins_skills_and_commands_but_not_chatbridge() {
        let root = tmp_root("settings");
        let home = fake_home(&root);
        let proj = root.join("proj");
        fs::create_dir_all(proj.join(".claude/skills/projskill")).unwrap();
        fs::write(proj.join(".claude/skills/projskill/SKILL.md"), "---\nname: projskill\n---\n").unwrap();
        fs::create_dir_all(proj.join(".claude/commands/x")).unwrap();
        fs::write(proj.join(".claude/commands/x/y.md"), "x").unwrap();
        let path = write_agent_settings("worker-1", "worker", &proj, &home.join(".claude"), &root.join("out")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["enabledPlugins"]["ponytail@ponytail"], false);
        assert_eq!(v["enabledPlugins"]["figma@official"], false);
        for k in ["humanizer", "projskill", "opsx:apply", "plan-product", "x:y"] {
            assert_eq!(v["skillOverrides"][k], "off", "{k}");
        }
        assert!(v["skillOverrides"].get("synced").is_none());
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("chatbridge") && !text.contains("factory-"), "test 8a: role, shared and chatbridge stay on");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_agents_in_different_projects_get_separate_files() {
        let root = tmp_root("settings2");
        let home = fake_home(&root);
        let (p1, p2) = (root.join("p1"), root.join("p2"));
        for (p, skill) in [(&p1, "only-one"), (&p2, "only-two")] {
            fs::create_dir_all(p.join(".claude/skills").join(skill)).unwrap();
            fs::write(p.join(".claude/skills").join(skill).join("SKILL.md"), "x").unwrap();
        }
        let dir = root.join("out");
        let a = write_agent_settings("worker-1", "worker", &p1, &home.join(".claude"), &dir).unwrap();
        let b = write_agent_settings("worker-2", "worker", &p2, &home.join(".claude"), &dir).unwrap();
        assert_ne!(a, b);
        let (ta, tb) = (fs::read_to_string(&a).unwrap(), fs::read_to_string(&b).unwrap());
        assert!(ta.contains("only-one") && !ta.contains("only-two"));
        assert!(tb.contains("only-two") && !tb.contains("only-one"));
        // a relaunch rewrites the same file and leaves no temp file
        write_agent_settings("worker-1", "worker", &p1, &home.join(".claude"), &dir).unwrap();
        let names: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_settings_reject_a_path_in_the_agent_name() {
        let root = tmp_root("settings3");
        let home = fake_home(&root);
        for bad in ["", "../x", "a/b", ".hidden"] {
            assert!(write_agent_settings(bad, "worker", &root, &home.join(".claude"), &root.join("out")).is_err(), "{bad}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn role_spec_reads_the_frontmatter_of_every_real_single_agent_role() {
        let root = tmp_root("rolespec");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let w = load_role_spec("worker", &src, &dest.join(&v)).unwrap();
        assert_eq!((w.harness.as_str(), w.model.as_deref()), ("claude", Some("sonnet")));
        assert_eq!(w.disallowed_tools, vec!["Task", "Agent"]);
        let val = load_role_spec("validator", &src, &dest.join(&v)).unwrap();
        assert_eq!(val.harness, "pi");
        assert_eq!((val.provider.as_deref(), val.model.as_deref(), val.thinking.as_deref()), (Some("openai-codex"), Some("gpt-5.6-sol"), Some("high")));
        assert_eq!(val.exclude_tools, vec!["edit", "write"]);
        for r in ["editor", "orchestrator", "reviewer", "tester", "writer"] {
            assert!(load_role_spec(r, &src, &dest.join(&v)).is_ok(), "{r}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_council_unstaged_and_path_like_roles_are_errors() {
        let root = tmp_root("rolespec2");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let vd = dest.join(&v);
        assert!(load_role_spec("nope", &src, &vd).unwrap_err().contains("unknown role"));
        assert!(load_role_spec("seo", &src, &vd).unwrap_err().contains("council"));
        assert!(load_role_spec("a11y", &src, &vd).unwrap_err().contains("council"));
        for bad in ["", "../worker", "worker/x", "Worker", "wor'ker"] {
            assert!(load_role_spec(bad, &src, &vd).is_err(), "{bad:?}");
        }
        fs::remove_dir_all(vd.join("worker")).unwrap();
        assert!(load_role_spec("worker", &src, &vd).unwrap_err().contains("not staged"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_roles_has_the_seven_single_agent_roles_and_no_council_or_shared() {
        let root = tmp_root("listroles");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let roles = list_roles_in(&src, &dest.join(&v));
        let names: Vec<&str> = roles.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["editor", "orchestrator", "reviewer", "tester", "validator", "worker", "writer"]);
        let val = roles.iter().find(|r| r.name == "validator").unwrap();
        assert_eq!((val.harness.as_str(), val.model.as_deref()), ("pi", Some("gpt-5.6-sol")));
        assert_eq!(list_roles_in(&src, &root.join("missing")), vec![]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stages_the_real_factory_tree() {
        let root = tmp_root("real");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        for r in ["a11y", "editor", "orchestrator", "reviewer", "seo", "tester", "validator", "worker", "writer"] {
            assert!(dest.join(&v).join(r).join("role.md").is_file(), "{r}");
            assert!(!dest.join(&v).join(r).join("agents").exists(), "{r} has agents/");
        }
        assert!(dest.join(&v).join("shared/skills/asd-ste100/scripts/ste-lint.py").is_file());
        assert!(!dest.join(&v).join("editor/skills/asd-ste100").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
