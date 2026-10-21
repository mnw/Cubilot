// PTY bridge: tmux owns the session; we attach one PTY per agent and bridge raw ANSI to xterm.js.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    app_data_dir, resolve_anthropic_api_key, resolve_claude_path,
    resolve_pi_extension, resolve_pi_path,
    resolve_tmux_bin,
};

// Reserved name for the human's pinned shell — kept separate so it survives room filters.
pub const SHELL_SESSION_NAME: &str = "shell";

// Mirrors hub.ts AGENT_NAME_RE; re-enforced here against bypassed-UI shell-metacharacter injection.
pub fn valid_agent_name(name: &str) -> bool {
    if name == SHELL_SESSION_NAME {
        return false;
    }
    let n = name.chars().count();
    if !(1..=64).contains(&n) {
        return false;
    }
    if matches!(name.chars().next(), Some(' ')) || matches!(name.chars().last(), Some(' ')) {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' ')
}

pub struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Kept alive so the tmux attach-session child isn't reaped while we still read from master.
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry(pub Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>);

#[derive(Serialize, Clone)]
struct OutputPayload {
    agent: String,
    b64: String,
}

fn tmux_socket_path() -> PathBuf {
    app_data_dir().join("tmux.sock")
}

// tmux resolves a bare `-t Dev` by PREFIX: with only "Dev1" alive it matches Dev1. `=name` names the
// session exactly. A target for a session alone (has-session, attach, kill, set-environment) is
// `=name`; one for a pane, window or option (set-option, list-panes, resize-window, capture-pane,
// display-message, pipe-pane) needs the colon, `=name:` (`=name` alone is rejected there).
// Not for `refresh-client -t`, which takes a client, not a session.
fn tmux_session(name: &str) -> String {
    format!("={name}")
}
fn tmux_pane(name: &str) -> String {
    format!("={name}:")
}

fn tmux_run(args: &[&str]) -> Result<String, String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let out = Command::new(&tmux)
        .arg("-S")
        .arg(&sock)
        .args(args)
        .output()
        .map_err(|e| format!("tmux spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "tmux {:?} failed (exit {}): {}",
            args,
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn session_exists(agent: &str) -> bool {
    let Ok(tmux) = resolve_tmux_bin() else {
        return false;
    };
    let sock = tmux_socket_path();
    Command::new(tmux)
        .arg("-S")
        .arg(sock)
        .args(["has-session", "-t"])
        .arg(tmux_session(agent))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// User-editable global MCP config. Only read for slash-command discovery now; the claude spawn no longer merges it into a per-agent MCP config.
pub fn global_mcp_config_path() -> PathBuf {
    app_data_dir().join("mcp.json")
}

const RESERVED_MCP_SERVER: &str = "chatbridge";

pub fn read_global_mcp_servers() -> serde_json::Map<String, serde_json::Value> {
    let path = global_mcp_config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Default::default(),
    };
    parse_global_mcp_servers(&raw, &path.display().to_string())
}

// Only the `mcpServers` map survives (`_comment` etc. are dropped), minus the reserved name.
fn parse_global_mcp_servers(raw: &str, label: &str) -> serde_json::Map<String, serde_json::Value> {
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[mcp] {label} parse failed: {e}");
            return Default::default();
        }
    };
    let mut servers = match parsed.get("mcpServers").and_then(|v| v.as_object()) {
        Some(m) => m.clone(),
        None => return Default::default(),
    };
    if servers.remove(RESERVED_MCP_SERVER).is_some() {
        eprintln!("[mcp] dropped reserved server name '{RESERVED_MCP_SERVER}' from global config");
    }
    servers
}

fn mcp_configs_dir() -> PathBuf {
    app_data_dir().join("mcp-configs")
}

// Global MCP servers for claude agents, as a standalone --mcp-config file. Atomic (tmpfile +
// rename) because concurrent spawns rewrite it. `prompts` is Cubilot's own slash-picker key,
// not part of the MCP schema, so it is stripped. Empty map: no file, no flag.
fn write_global_mcp_config(
    dir: &std::path::Path,
    mut servers: serde_json::Map<String, serde_json::Value>,
) -> Result<Option<PathBuf>, String> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = dir.join("global.json");
    if servers.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(None);
    }
    for server_cfg in servers.values_mut() {
        if let Some(obj) = server_cfg.as_object_mut() {
            obj.remove("prompts");
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let text = serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": servers }))
        .map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".global.json.tmp-{}-{nanos}", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", path.display()));
    }
    Ok(Some(path))
}

/// Which agent binary backs a session. Captured at spawn; immutable for the
/// session's life (changing it means killing the agent and respawning, same as
/// room). Unknown values are rejected rather than defaulted, so a UI typo
/// surfaces instead of silently launching the wrong harness.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Harness {
    Claude,
    Pi,
}

impl Harness {
    fn as_str(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Pi => "pi",
        }
    }

    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("claude") => Ok(Harness::Claude),
            Some("pi") => Ok(Harness::Pi),
            Some(other) => Err(format!("invalid harness: {other}")),
        }
    }
}

fn agent_command(
    agent: &str,
    room: &str,
    cwd: &str,
    session_mode: Option<&str>,
    harness: Harness,
    claude_path: Option<&std::path::Path>,
    role: Option<&str>,
    choice: &crate::factory::LaunchChoice,
) -> Result<String, String> {
    match harness {
        Harness::Claude => claude_command(
            agent,
            room,
            session_mode,
            claude_path.ok_or_else(|| "Claude path is required for a Claude spawn".to_string())?,
            role,
            cwd,
            choice,
        ),
        Harness::Pi => {
            let launch = match role {
                Some(r) => Some(crate::factory::with_choice(
                    crate::factory::resolve_role_launch(agent, r, std::path::Path::new(cwd))?,
                    choice,
                )),
                None => None,
            };
            let cmd = pi_command(agent, room, cwd, session_mode, launch.as_ref())?;
            // Without a role the choice is appended (a role already carries it in its own flags).
            Ok(if role.is_some() { cmd } else { format!("{cmd}{}", choice_flags(true, choice)) })
        }
    }
}

// The flags of a choice for a launch WITHOUT a role (task 5.5). Empty choice: nothing, so the command is unchanged.
// Claude: --model, --effort. Pi: --provider, --model, --thinking. Values were validated by launch_choice.
fn choice_flags(is_pi: bool, c: &crate::factory::LaunchChoice) -> String {
    let sq = |s: &str| s.replace('\'', r"'\''");
    let mut f = String::new();
    if is_pi {
        if let Some(p) = &c.provider { f.push_str(&format!(" --provider '{}'", sq(p))); }
    }
    if let Some(m) = &c.model { f.push_str(&format!(" --model '{}'", sq(m))); }
    if let Some(e) = &c.effort {
        f.push_str(&format!(" {} '{}'", if is_pi { "--thinking" } else { "--effort" }, sq(e)));
    }
    f
}

/// Claude Code's skills and commands are reusable by pi as-is: pi implements the
/// same Agent Skills standard (`<dir>/SKILL.md` + name/description frontmatter)
/// and its prompt templates are shaped like `~/.claude/commands/*.md`. Sharing
/// them is what makes a pi agent feel native in a Claude-centric setup rather
/// than starting blank.
///
/// Only existing paths are passed — pi emits a diagnostic for paths that aren't
/// there, and a blank project has neither `.claude/skills` nor `.claude/commands`.
///
/// ORDER IS LOAD-BEARING: pi resolves name collisions first-one-wins (see
/// `loadSkills` in pi's core/skills.js), so project-local dirs are passed BEFORE
/// user-level ones to match Claude Code's "closest scope wins" precedence.
/// Pi's own `~/.pi/agent/skills` defaults load before any `--skill` path, so a
/// name present there still beats both; `--skill` is additive, never exclusive.
/// Which harness a live session is running, read back from tmux rather than kept in
/// memory: sessions outlive the app. `pty_spawn` records it as the session option
/// `@cubilot_harness`; that is authoritative. Sessions from older builds have no option, so
/// they fall back to inspecting the start command, and there only the executable counts
/// (never substrings, which agent names and room labels can contain).
fn harness_from_option(value: &str) -> Option<Harness> {
    match value.trim() {
        "claude" => Some(Harness::Claude),
        "pi" => Some(Harness::Pi),
        _ => None,
    }
}

// First word of `cmd` after leading `VAR=value` assignments, honouring the single/double
// quoting our commands use, reduced to its basename.
fn command_executable(cmd: &str) -> Option<String> {
    // tmux wraps pane_start_command in double quotes and escapes shell-significant bytes.
    let cmd = cmd.trim();
    let mut unquoted = String::new();
    let cmd = if let Some(inner) = cmd.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some(next @ ('"' | '\\' | '$')) => unquoted.push(next),
                    Some(next) => {
                        unquoted.push('\\');
                        unquoted.push(next);
                    }
                    None => unquoted.push('\\'),
                }
            } else {
                unquoted.push(c);
            }
        }
        unquoted.as_str()
    } else {
        cmd
    };
    let mut chars = cmd.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut word = String::new();
        let mut quoted_any = false;
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            chars.next();
            match c {
                '\'' => {
                    quoted_any = true;
                    for q in chars.by_ref() {
                        if q == '\'' {
                            break;
                        }
                        word.push(q);
                    }
                }
                '"' => {
                    quoted_any = true;
                    while let Some(q) = chars.next() {
                        match q {
                            '"' => break,
                            '\\' => {
                                if let Some(n) = chars.next() {
                                    word.push(n);
                                }
                            }
                            _ => word.push(q),
                        }
                    }
                }
                '\\' => {
                    quoted_any = true;
                    if let Some(n) = chars.next() {
                        word.push(n);
                    }
                }
                _ => word.push(c),
            }
        }
        if word.is_empty() && !quoted_any {
            return None;
        }
        // An assignment only counts when the name part is a plain identifier.
        let is_assignment = word.split_once('=').is_some_and(|(n, _)| {
            !n.is_empty()
                && !n.starts_with(|c: char| c.is_ascii_digit())
                && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        if is_assignment {
            continue;
        }
        return std::path::Path::new(&word)
            .file_name()
            .map(|f| f.to_string_lossy().to_string());
    }
}

fn harness_from_command(cmd: &str) -> Harness {
    match command_executable(cmd).as_deref() {
        Some("pi") => Harness::Pi,
        _ => Harness::Claude,
    }
}

pub fn pane_harness(agent: &str) -> Harness {
    if !valid_agent_name(agent) {
        return Harness::Claude;
    }
    if let Some(h) = tmux_run(&["show-options", "-v", "-t", &tmux_pane(agent), "@cubilot_harness"])
        .ok()
        .and_then(|v| harness_from_option(&v))
    {
        return h;
    }
    match tmux_run(&["list-panes", "-t", &tmux_pane(agent), "-F", "#{pane_start_command}"]) {
        Ok(cmd) => harness_from_command(&cmd),
        _ => Harness::Claude,
    }
}

// ---- Roster pill: role, model and (Pi) provider of a running agent (task 5.4) ----
// Recorded as tmux session options at spawn, like @cubilot_harness, because sessions outlive the app and the hub
// does not know the role. Read back with one list-sessions call.
#[derive(Debug, PartialEq, Clone, serde::Serialize)]
pub struct PillInfo {
    pub role: String,
    pub model: String,
    pub provider: String, // Pi roles only, else empty
}

fn role_options(spec: &crate::factory::RoleSpec, choice: &crate::factory::LaunchChoice) -> Vec<(&'static str, String)> {
    let model = choice.model.clone().or_else(|| spec.model.clone()).unwrap_or_default();
    let provider = if spec.harness == "pi" { choice.provider.clone().or_else(|| spec.provider.clone()).unwrap_or_default() } else { String::new() };
    vec![("@cubilot_role", spec.name.clone()), ("@cubilot_model", model), ("@cubilot_provider", provider)]
}

const PILL_FORMAT: &str = "#{session_name}\t#{@cubilot_role}\t#{@cubilot_model}\t#{@cubilot_provider}";

// Sessions without a role (no option set) are left out: their pill stays as it is.
fn parse_role_pills(out: &str) -> std::collections::HashMap<String, PillInfo> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        let mut f = line.split('\t');
        let (Some(name), Some(role), Some(model), Some(provider)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        if role.is_empty() || !valid_agent_name(name) {
            continue;
        }
        map.insert(name.to_string(), PillInfo { role: role.to_string(), model: model.to_string(), provider: provider.to_string() });
    }
    map
}

#[tauri::command]
pub fn pty_roles() -> std::collections::HashMap<String, PillInfo> {
    // "no server running" is an error here too: no sessions, no pills.
    tmux_run(&["list-sessions", "-F", PILL_FORMAT]).map(|o| parse_role_pills(&o)).unwrap_or_default()
}

#[tauri::command]
pub fn pty_harness(agent: String) -> String {
    match pane_harness(&agent) {
        Harness::Pi => "pi".to_string(),
        Harness::Claude => "claude".to_string(),
    }
}

/// Skill roots a pi agent actually sees: the same `--skill` paths
/// `claude_resource_flags` passes, plus pi's own package and project roots.
/// Kept next to that function so the two can't drift apart.
pub fn pi_skill_roots(cwd: &str) -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let cwd_path = PathBuf::from(cwd);
    let mut roots = vec![
        cwd_path.join(".claude/skills"),
        home.join(".claude/skills"),
        cwd_path.join(".pi/skills"),
        home.join(".pi/agent/skills"),
    ];
    for key in SHARED_CLAUDE_PLUGINS {
        if let Some(p) = claude_plugin_skills_dir(key) {
            roots.push(p);
        }
    }
    // Installed pi packages ship skills under <pkg>/skills.
    for base in [home.join(".pi/agent/npm/node_modules"), home.join(".pi/agent/git")] {
        collect_package_skill_dirs(&base, &mut roots, 0);
    }
    roots.retain(|p| p.is_dir());
    roots
}

// Package layouts differ (npm is flat-ish, git clones nest by host/org/repo),
// so walk a bounded depth looking for a `skills` dir rather than guessing.
fn collect_package_skill_dirs(dir: &PathBuf, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 3 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let skills = p.join("skills");
        if skills.is_dir() {
            out.push(skills);
        }
        collect_package_skill_dirs(&p, out, depth + 1);
    }
}

/// Resolve a Claude plugin's ACTIVE skills dir via `installed_plugins.json`.
///
/// The plugin cache keeps stale version directories next to the live one (figma
/// currently has both 2.2.107 and 2.2.111), so pointing `--skill` at the plugin
/// dir would load every skill twice and trip pi's name-collision diagnostics on
/// each launch. `installed_plugins.json` is the only record of which version is
/// actually installed, and it survives plugin updates — unlike a pinned path.
fn claude_plugin_skills_dir(plugin_key: &str) -> Option<PathBuf> {
    let manifest = dirs::home_dir()?.join(".claude/plugins/installed_plugins.json");
    let raw = std::fs::read_to_string(manifest).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let install_path = v
        .get("plugins")?
        .get(plugin_key)?
        .as_array()?
        .iter()
        .find_map(|e| e.get("installPath")?.as_str())?;
    let skills = PathBuf::from(install_path).join("skills");
    skills.is_dir().then_some(skills)
}

/// Claude plugins whose skills are shared with pi agents. Explicit rather than a
/// wildcard over the cache: every entry costs ~155 tokens of system prompt in
/// every request, so which plugins are worth that is a judgement call, not a
/// sweep. Listed last so a same-named skill of the user's own still wins.
const SHARED_CLAUDE_PLUGINS: &[&str] = &["figma@claude-plugins-official"];

fn claude_resource_flags(cwd: &str) -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let cwd_path = PathBuf::from(cwd);
    let candidates: [(&str, PathBuf); 4] = [
        ("--skill", cwd_path.join(".claude/skills")),
        ("--skill", home.join(".claude/skills")),
        ("--prompt-template", cwd_path.join(".claude/commands")),
        ("--prompt-template", home.join(".claude/commands")),
    ];
    let mut out = String::new();
    for (flag, path) in &candidates {
        if !path.is_dir() {
            continue;
        }
        let escaped = path.to_string_lossy().replace('\'', r"'\''");
        out.push_str(&format!("{flag} '{escaped}' "));
    }
    for key in SHARED_CLAUDE_PLUGINS {
        if let Some(path) = claude_plugin_skills_dir(key) {
            let escaped = path.to_string_lossy().replace('\'', r"'\''");
            out.push_str(&format!("--skill '{escaped}' "));
        }
    }
    out
}

// Pi has no MCP support by design, so the chatbridge ships as a pi extension
// loaded with `-e` instead of an MCP config. Identity travels as env on the
// command (tmux runs it through /bin/sh), which is what the extension reads.
// `--no-approve` answers pi's "Trust project folder?" prompt deterministically
// — no output-scanning like the claude dev-channels path needs.
fn pi_command(
    agent: &str,
    room: &str,
    cwd: &str,
    session_mode: Option<&str>,
    role: Option<&crate::factory::RoleLaunch>,
) -> Result<String, String> {
    let ext = resolve_pi_extension()?;
    let ext_str = ext.to_string_lossy().replace('\'', r"'\''");
    let mode_part = match session_mode {
        Some("continue") => "--continue ",
        Some("resume")   => "--resume ",
        Some(other)      => return Err(format!("invalid session_mode: {other}")),
        None             => "",
    };
    let pi_path = resolve_pi_path();
    let pi_escaped = pi_path.to_string_lossy().replace('\'', r"'\''");
    let agent_escaped = agent.replace('\'', r"'\''");
    let room_escaped = room.replace('\'', r"'\''");
    // A role gets exactly its own and the shared skill folders (brief tests 6 and 11): no --skill or
    // --prompt-template folder from claude_resource_flags, which would bring ~/.claude/skills back.
    let shared = if role.is_some() { String::new() } else { claude_resource_flags(cwd) };
    let (role_part, role_flags) = match role {
        Some(r) if r.harness != "pi" => return Err(format!("role '{}' runs on {}, not pi", r.name, r.harness)),
        Some(r) => pi_role_flags(r)?,
        None => (String::new(), String::new()),
    };
    Ok(format!(
        "CHATBRIDGE_AGENT='{agent_escaped}' CHATBRIDGE_ROOM='{room_escaped}' {role_part}'{pi_escaped}' {mode_part}--no-approve {role_flags}{shared}-e '{ext_str}'"
    ))
}

// Pi role flags (task 3.3). `--no-skills` is needed: without it Pi discovers ~/.claude/skills on its own and that
// copy of a skill (asd-ste100) wins over every --skill (seen live, 1.4). Explicit --skill paths still load, so the
// role gets exactly its own and the shared folder; pi_command drops the claude_resource_flags folders for a role.
// `--exclude-tools`, never `--tools`: --tools is an allowlist and would remove the chatbridge tools.
fn pi_role_flags(r: &crate::factory::RoleLaunch) -> Result<(String, String), String> {
    if !crate::factory::valid_role_name(&r.name) {
        return Err(format!("invalid role: {:?}", r.name));
    }
    let sq = |s: &str| s.replace('\'', r"'\''");
    let psq = |p: &std::path::Path| sq(&p.to_string_lossy());
    let mut f = format!("--no-skills --append-system-prompt '{}' ", psq(&r.prompt_file));
    let role_skills = r.plugin_dir.join("skills");
    if role_skills.is_dir() {
        f.push_str(&format!("--skill '{}' ", psq(&role_skills)));
    }
    f.push_str(&format!("--skill '{}' ", psq(&r.shared_dir.join("skills"))));
    for (flag, v) in [("--provider", &r.provider), ("--model", &r.model), ("--thinking", &r.thinking)] {
        if let Some(v) = v {
            f.push_str(&format!("{flag} '{}' ", sq(v)));
        }
    }
    // Always present with a role: the role's list plus ack_permission (a Pi role must not answer permission requests).
    let excluded = with_ack_permission_blocked(&r.exclude_tools, ACK_PERMISSION);
    f.push_str(&format!("--exclude-tools '{}' ", sq(&excluded.join(","))));
    Ok((format!("CHATBRIDGE_ROLE='{}' ", r.name), f))
}

// Direct-exec (no shell), so claude_path must be absolute — comes from config.yml.
// The chatbridge is a Claude Code mod loaded with --plugin-dir; identity travels as env
// on the command (tmux runs it through /bin/sh), which is what the mod reads.
// Staging is enforced: if this process has not staged the mod it retries once and
// otherwise refuses, so a spawn never runs against a leftover folder from an older build.
fn claude_command(
    agent: &str,
    room: &str,
    session_mode: Option<&str>,
    claude_path: &std::path::Path,
    role: Option<&str>,
    cwd: &str,
    choice: &crate::factory::LaunchChoice,
) -> Result<String, String> {
    // Resolved before the mod is staged or anything is written for a role-less spawn: no role, no change.
    let launch = match role {
        Some(r) => Some(crate::factory::with_choice(
            crate::factory::resolve_role_launch(agent, r, std::path::Path::new(cwd))?,
            choice,
        )),
        None => None,
    };
    let cmd = claude_command_using(
        agent,
        room,
        session_mode,
        claude_path,
        launch.as_ref(),
        &crate::ensure_chatbridge_mod_staged,
    )?;
    // Without a role the choice is appended (a role already carries it in its own flags).
    Ok(if role.is_some() { cmd } else { format!("{cmd}{}", choice_flags(false, choice)) })
}

// Mods load unreliably before this: a stale GrowthBook cache can serve
// tengu_plugin_hooks_modules "off", so the mod silently never loads (0/5 launches on 2.1.287).
const MIN_CLAUDE_CODE: (u32, u32, u32) = (2, 1, 296);
const CLAUDE_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// Parse the first `major.minor.patch` in the output, ignoring prerelease and build suffixes.
fn parse_leading_version_component(s: &str) -> Option<(u32, &str)> {
    let digits = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if digits == 0 {
        return None;
    }
    Some((s[..digits].parse().ok()?, &s[digits..]))
}

fn parse_claude_version(out: &str) -> Option<(u32, u32, u32)> {
    for line in out.lines() {
        for (start, c) in line.char_indices() {
            if !c.is_ascii_digit() {
                continue;
            }
            let Some((major, rest)) = parse_leading_version_component(&line[start..]) else {
                continue;
            };
            let Some(rest) = rest.strip_prefix('.') else { continue };
            let Some((minor, rest)) = parse_leading_version_component(rest) else {
                continue;
            };
            let Some(rest) = rest.strip_prefix('.') else { continue };
            let Some((patch, _)) = parse_leading_version_component(rest) else {
                continue;
            };
            return Some((major, minor, patch));
        }
    }
    None
}

fn check_claude_version(path: &std::path::Path, found: (u32, u32, u32)) -> Result<(), String> {
    const UPDATE: &str = "Update it with `claude update` (native install) or `npm update -g @anthropic-ai/claude-code` (npm install)";
    if found >= MIN_CLAUDE_CODE {
        return Ok(());
    }
    let (a, b, c) = found;
    Err(format!(
        "Claude Code at {} is {a}.{b}.{c}, older than 2.1.296, which chatbridge needs (mods load unreliably before it). {UPDATE}",
        path.display()
    ))
}

fn read_child_output(child: &mut std::process::Child) -> String {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_end(&mut stderr);
    }
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.into_owned(),
        (true, false) => stderr.into_owned(),
        (true, true) => String::new(),
    }
}

// No shell; kills the child if it has not exited within CLAUDE_VERSION_TIMEOUT.
fn read_claude_version(path: &std::path::Path) -> Result<(u32, u32, u32), String> {
    read_claude_version_with_timeout(path, CLAUDE_VERSION_TIMEOUT)
}

fn read_claude_version_with_timeout(
    path: &std::path::Path,
    timeout: std::time::Duration,
) -> Result<(u32, u32, u32), String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code at {} for --version: {e}", path.display()))?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let output = read_child_output(&mut child);
                return Err(format!(
                    "Claude Code --version timed out at {}. Output: {output}",
                    path.display()
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let output = read_child_output(&mut child);
                return Err(format!(
                    "Failed while checking Claude Code at {}: {e}. Output: {output}",
                    path.display()
                ));
            }
        }
    };
    let output = read_child_output(&mut child);
    if !status.success() {
        return Err(format!(
            "Claude Code --version at {} exited with {status:?}. Output: {output}",
            path.display()
        ));
    }
    parse_claude_version(&output).ok_or_else(|| {
        format!(
            "Claude Code at {} returned no parseable version. Output: {output}",
            path.display()
        )
    })
}

// Probed on every new spawn, never cached: the binary can be swapped in place (auto-update
// or downgrade at the same path). Re-attach does not come through here.
fn ensure_claude_version(path: &std::path::Path) -> Result<(), String> {
    check_claude_version(path, read_claude_version(path)?)
}

fn claude_command_using(
    agent: &str,
    room: &str,
    session_mode: Option<&str>,
    claude_path: &std::path::Path,
    role: Option<&crate::factory::RoleLaunch>,
    stage: &dyn Fn() -> Result<PathBuf, String>,
) -> Result<String, String> {
    let mod_dir = stage()?;
    let mcp_config = write_global_mcp_config(&mcp_configs_dir(), read_global_mcp_servers())?;
    format_claude_command(
        agent, room, session_mode, claude_path, &mod_dir, mcp_config.as_deref(), role,
    )
}

// What a role agent may call without a prompt (task 4.1): the handoff, interrupt and ticket tools plus post and
// post_file. `ack_permission` is NOT here: a role agent must not answer permission requests, the human does
// (from the card in the UI and from the agent's terminal).
const ROLE_ALLOWED_TOOLS: [&str; 14] = [
    "post", "post_file",
    "send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff",
    "send_interrupt", "ack_interrupt",
    "create_ticket", "claim_ticket", "transition_ticket", "assign_ticket", "attach_ticket_file", "list_tickets",
];
const ACK_PERMISSION: &str = "ack_permission";

// The role's own list plus ack_permission, without a duplicate.
fn with_ack_permission_blocked(list: &[String], name: &str) -> Vec<String> {
    let mut out = list.to_vec();
    if !out.iter().any(|t| t == name) {
        out.push(name.to_string());
    }
    out
}

fn format_claude_command(
    agent: &str,
    room: &str,
    session_mode: Option<&str>,
    claude_path: &std::path::Path,
    mod_dir: &std::path::Path,
    mcp_config: Option<&std::path::Path>,
    role: Option<&crate::factory::RoleLaunch>,
) -> Result<String, String> {
    let sq = |s: &str| s.replace('\'', r"'\''");
    let psq = |p: &std::path::Path| sq(&p.to_string_lossy());
    // Role identity travels as env like agent and room; the flags load the staged role plugin and shared plugin.
    // Nothing is added when there is no role.
    let (role_part, role_flags) = match role {
        // pty_spawn picks the harness from the role (harness_for_role), so this only guards a wrong call.
        Some(r) if r.harness != "claude" => return Err(format!("role '{}' runs on {}, not claude", r.name, r.harness)),
        Some(r) if crate::factory::valid_role_name(&r.name) => {
            let settings = r.settings.as_ref().ok_or_else(|| format!("role '{}': no settings file", r.name))?;
            let mut flags = format!(
                "--plugin-dir '{}' --plugin-dir '{}' --append-system-prompt-file '{}' --settings '{}' ",
                psq(&r.plugin_dir), psq(&r.shared_dir), psq(&r.prompt_file), psq(settings)
            );
            if let Some(m) = &r.model {
                flags.push_str(&format!("--model '{}' ", sq(m)));
            }
            if let Some(e) = &r.effort {
                flags.push_str(&format!("--effort '{}' ", sq(e)));
            }
            // Always present with a role: the role's list plus the blocked ack_permission.
            let blocked = with_ack_permission_blocked(&r.disallowed_tools, &format!("mcp__chatbridge__{ACK_PERMISSION}"));
            flags.push_str(&format!("--disallowed-tools '{}' ", sq(&blocked.join(","))));
            (format!("CHATBRIDGE_ROLE='{}' ", r.name), flags)
        }
        Some(r) => return Err(format!("invalid role: {:?}", r.name)),
        None => (String::new(), String::new()),
    };
    let mode_part = match session_mode {
        Some("continue") => "--continue ",
        Some("resume")   => "--resume ",
        Some(other)      => return Err(format!("invalid session_mode: {other}")),
        None             => "",
    };
    let claude_escaped = claude_path.to_string_lossy().replace('\'', r"'\''");
    let mod_escaped = mod_dir.to_string_lossy().replace('\'', r"'\''");
    let agent_escaped = agent.replace('\'', r"'\''");
    let room_escaped = room.replace('\'', r"'\''");
    let mcp_part = match mcp_config {
        Some(p) => format!("--mcp-config '{}' ", p.to_string_lossy().replace('\'', r"'\''")),
        None => String::new(),
    };
    // No role: the allow rule is the one the app has always passed (pinned by tests).
    let allowed_tools = if role.is_some() {
        ROLE_ALLOWED_TOOLS.iter().map(|t| format!("mcp__chatbridge__{t}")).collect::<Vec<_>>().join(",")
    } else {
        "mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file".to_string()
    };
    Ok(format!(
        "CHATBRIDGE_AGENT='{agent_escaped}' CHATBRIDGE_ROOM='{room_escaped}' {role_part}'{claude_escaped}' {mode_part}--plugin-dir '{mod_escaped}' {mcp_part}{role_flags}--allowed-tools '{allowed_tools}'"
    ))
}

// Caller owns name-validation + session-creation; this helper only attaches and streams.
fn attach_and_stream(
    app: AppHandle,
    registry: Arc<Mutex<HashMap<String, Arc<Mutex<PtyHandle>>>>>,
    name: &str,
    lang: &str,
) -> Result<(), String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut builder = CommandBuilder::new(tmux);
    builder.arg("-S");
    builder.arg(sock);
    builder.arg("attach-session");
    builder.arg("-t");
    builder.arg(tmux_session(name));
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("LANG", lang);
    builder.env("LC_ALL", lang);

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn attach-session: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    {
        let mut map = registry.lock().unwrap();
        map.insert(
            name.to_string(),
            Arc::new(Mutex::new(PtyHandle {
                master: pair.master,
                writer,
                _child: child,
            })),
        );
    }

    // PTY reads block; dedicated thread so we don't starve the tokio executor.
    let app_clone = app.clone();
    let name_clone = name.to_string();
    let registry_clone = registry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let b64 = B64.encode(&buf[..n]);
                    let _ = app_clone.emit(
                        &format!("pty://output/{}", name_clone),
                        OutputPayload {
                            agent: name_clone.clone(),
                            b64,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&format!("pty://exit/{}", name_clone), &name_clone);
        let mut map = registry_clone.lock().unwrap();
        map.remove(&name_clone);
    });

    Ok(())
}

/// Reconfigure existing tmux session; Ok(false) when none exists. Propagates errors from CRITICAL ops.
fn ensure_session_configured(agent: &str, lang: &str) -> Result<bool, String> {
    if !session_exists(agent) {
        return Ok(false);
    }

    tmux_run(&["set-option", "-t", &tmux_pane(agent), "remain-on-exit", "off"])
        .map_err(|e| format!("ensure_session_configured/remain-on-exit: {e}"))?;
    // resize BEFORE `latest`: resize-window -A pins manual mode that `latest` would undo.
    tmux_run(&["resize-window", "-t", &tmux_pane(agent), "-A"])
        .map_err(|e| format!("ensure_session_configured/resize-window: {e}"))?;
    tmux_run(&["set-option", "-w", "-t", &tmux_pane(agent), "window-size", "latest"])
        .map_err(|e| format!("ensure_session_configured/window-size latest: {e}"))?;

    if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(agent), "status", "off"]) {
        eprintln!("[pty] ensure_session_configured/status-off (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", &tmux_session(agent), "TERM", "xterm-256color"]) {
        eprintln!("[pty] ensure_session_configured/TERM (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", &tmux_session(agent), "COLORTERM", "truecolor"]) {
        eprintln!("[pty] ensure_session_configured/COLORTERM (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", &tmux_session(agent), "LANG", lang]) {
        eprintln!("[pty] ensure_session_configured/LANG (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-environment", "-t", &tmux_session(agent), "LC_ALL", lang]) {
        eprintln!("[pty] ensure_session_configured/LC_ALL (best-effort): {e}");
    }
    // Do NOT enable extended-keys/CSI-u: xterm.js doesn't speak it, breaks Shift+Enter for claude.
    if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(agent), "allow-passthrough", "on"]) {
        eprintln!("[pty] ensure_session_configured/allow-passthrough (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["set-option", "-w", "-u", "-t", &tmux_pane(agent), "window-size"]) {
        eprintln!("[pty] ensure_session_configured/window-size-unset (best-effort): {e}");
    }
    if let Err(e) = tmux_run(&["refresh-client", "-t", agent, "-S"]) {
        eprintln!("[pty] ensure_session_configured/refresh-client (best-effort): {e}");
    }

    Ok(true)
}

/// Pure argv builder. `spawn_cmd` MUST stay a single argv element (quoted-path safety).
fn build_spawn_argv(
    agent: &str,
    cwd: &str,
    lang: &str,
    api_key: Option<&str>,
    spawn_cmd: &str,
) -> Vec<String> {
    let mut argv: Vec<String> = Vec::with_capacity(20);
    argv.push("new-session".to_string());
    argv.push("-d".to_string());
    argv.push("-s".to_string());
    argv.push(agent.to_string());
    argv.push("-e".to_string());
    argv.push("TERM=xterm-256color".to_string());
    argv.push("-e".to_string());
    argv.push("COLORTERM=truecolor".to_string());
    argv.push("-e".to_string());
    argv.push(format!("LANG={lang}"));
    argv.push("-e".to_string());
    argv.push(format!("LC_ALL={lang}"));
    // The bridge finds the hub discovery files in this folder.
    argv.push("-e".to_string());
    argv.push(format!("CUBILOT_DATA_DIR={}", app_data_dir().display()));
    if let Some(key) = api_key {
        argv.push("-e".to_string());
        argv.push(format!("ANTHROPIC_API_KEY={key}"));
    }
    // -x 80 -y 24 load-bearing: without dims tmux probes TIOCGWINSZ and we have no controlling TTY.
    argv.push("-x".to_string());
    argv.push("80".to_string());
    argv.push("-y".to_string());
    argv.push("24".to_string());
    argv.push("-c".to_string());
    argv.push(cwd.to_string());
    argv.push(spawn_cmd.to_string());
    argv
}

// launchd inherits "C" locale; claude downgrades capability detection to ASCII without UTF-8.
fn resolve_utf8_locale() -> String {
    std::env::var("LANG")
        .ok()
        .filter(|v| v.to_lowercase().contains("utf"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string())
}

// Mirrors hub.ts validRoomLabel.
fn valid_room_label(room: &str) -> bool {
    let n = room.chars().count();
    if !(1..=64).contains(&n) {
        return false;
    }
    if matches!(room.chars().next(), Some(' ')) || matches!(room.chars().last(), Some(' ')) {
        return false;
    }
    room.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' ')
}

// Spawn-modal Room default: git-root basename, falling back to cwd basename.
pub fn default_room_for_cwd(cwd: &std::path::Path) -> String {
    let mut p = cwd;
    loop {
        if p.join(".git").exists() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                return name.to_string();
            }
        }
        match p.parent() {
            Some(parent) => p = parent,
            None => break,
        }
    }
    cwd.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("default")
        .to_string()
}

/// The role of a spawn request: blank is no role; anything else must be a known single-agent role that the
/// current staged version contains, else the spawn fails before a tmux session exists.
fn spawn_role(role: Option<String>) -> Result<Option<String>, String> {
    spawn_role_with(role, &|r| crate::factory::resolve_role_spec(r).map(|_| ()))
}

fn spawn_role_with(role: Option<String>, check: &dyn Fn(&str) -> Result<(), String>) -> Result<Option<String>, String> {
    let Some(r) = role.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) else { return Ok(None) };
    check(&r)?;
    Ok(Some(r))
}

/// The harness a spawn runs on: the role's frontmatter `harness` when a role is set, else the requested one.
fn harness_for_role(requested: Harness, role: Option<&str>) -> Result<Harness, String> {
    harness_for_role_with(requested, role, &|r| crate::factory::resolve_role_spec(r).map(|s| s.harness))
}

fn harness_for_role_with(
    requested: Harness,
    role: Option<&str>,
    role_harness: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Harness, String> {
    match role {
        None => Ok(requested),
        Some(r) => Harness::parse(Some(&role_harness(r)?)),
    }
}

// ---- Pi sign-in check (task 3.5) ----
// A Pi role launch names a provider (openai-codex for the validator and the reviewer). Without a sign-in Pi starts
// and then fails inside the pane, where the human sees a blank agent. So the check runs BEFORE the tmux session is
// created: `pi auth check --provider <p> --json` exits 0 with {"status":"ready"}, else exits 1 with
// {"status":"not_ready","reason":"..."}. The ticket text names `openai`; tasks.md 3.5 and the roles use the role's own
// provider (`openai-codex`, human decision 2026-10-21), so the check uses that. Never `--credentials`, and nothing
// from the answer except status and reason is read or logged.
// 20 s: without --no-refresh the check may refresh an expired OAuth token, which needs the network.
const PI_AUTH_CHECK_SECS: u64 = 20;

fn auth_check_result(provider: &str, exit_ok: bool, stdout: &str) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Null);
    if exit_ok && v.get("status").and_then(|s| s.as_str()) == Some("ready") {
        return Ok(());
    }
    Err(match v.get("reason").and_then(|r| r.as_str()) {
        Some("credentials_not_configured") => format!(
            "Pi is not signed in to {provider}. Run `pi` and /login {provider}. Nothing was started."
        ),
        Some("provider_not_found") => format!("Pi does not know the provider {provider}. Nothing was started."),
        Some(other) => format!(
            "Pi is not ready for {provider} ({other}). Run `pi` and /login {provider}. Nothing was started."
        ),
        None => format!(
            "The Pi sign-in check for {provider} gave no usable answer. Run `pi` and /login {provider}. Nothing was started."
        ),
    })
}

// Runs the check with a time limit (a bad network may hang it). Blocking: call from spawn_blocking.
pub(crate) fn pi_auth_check(pi: &std::path::Path, provider: &str) -> Result<(), String> {
    pi_auth_check_with(pi, provider, std::time::Duration::from_secs(PI_AUTH_CHECK_SECS))
}

fn pi_auth_check_with(pi: &std::path::Path, provider: &str, limit: std::time::Duration) -> Result<(), String> {
    use std::io::Read as _;
    let mut child = Command::new(pi)
        .args(["auth", "check", "--provider", provider, "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not run `pi auth check` for {provider} ({e}). Nothing was started."))?;
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "The Pi sign-in check for {provider} took more than {} seconds. Run `pi` and /login {provider}. Nothing was started.",
                    limit.as_secs()
                ));
            }
        }
    };
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    auth_check_result(provider, status.success(), &out)
}

// The provider to check for this spawn, if any. A Pi ROLE names one; the human's grid choice may name another, and
// then THAT one is checked (the user gets the sign-in message for the model they picked). A plain Pi agent with no
// choice is left alone: it may use any provider, and this check is not its business.
fn pi_provider_to_check(
    harness: Harness,
    role: Option<&str>,
    choice: &crate::factory::LaunchChoice,
) -> Result<Option<String>, String> {
    if harness != Harness::Pi {
        return Ok(None);
    }
    if let Some(p) = &choice.provider {
        return Ok(Some(p.clone()));
    }
    match role {
        Some(r) => Ok(crate::factory::resolve_role_spec(r)?.provider),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    agent: String,
    cwd: String,
    session_mode: Option<String>,
    room: Option<String>,
    harness: Option<String>,
    role: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    // An unknown or council role fails here, before any tmux session exists. No role: nothing changes.
    let role = spawn_role(role)?;
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    let harness = Harness::parse(harness.as_deref())?;
    // A role's own harness replaces the one the modal asked for (a Pi role builds the Pi command even when the
    // modal says Claude). No role: the requested harness, as before.
    let harness = harness_for_role(harness, role.as_deref())?;
    // The model x effort grid (task 5.5): only what the human changed arrives here. Checked against the EFFECTIVE
    // harness, so a Claude effort level on a Pi role (or the reverse) is refused, not guessed.
    let choice = crate::factory::launch_choice(harness == Harness::Pi, model.as_deref(), provider.as_deref(), effort.as_deref())?;

    let resolved_room = match room.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) if valid_room_label(r) => r.to_string(),
        Some(r) => return Err(format!("invalid room: {r}")),
        None => default_room_for_cwd(std::path::Path::new(&cwd)),
    };

    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&agent) {
            return Err(format!("agent '{agent}' already attached"));
        }
    }

    let api_key = resolve_anthropic_api_key();
    let lang = resolve_utf8_locale();

    let existed = ensure_session_configured(&agent, &lang)?;
    if !existed {
        // Built only for a new session: re-attaching to a live one must not depend on the
        // Claude version check or mod staging.
        // A Pi role needs its provider signed in: check before any session exists, launch nothing on failure.
        if let Some(provider) = pi_provider_to_check(harness, role.as_deref(), &choice)? {
            let pi = crate::resolve_pi_path();
            tauri::async_runtime::spawn_blocking(move || pi_auth_check(&pi, &provider))
                .await
                .map_err(|e| format!("Pi sign-in check worker failed: {e}"))??;
        }
        let claude_path = match harness {
            Harness::Claude => {
                let path = resolve_claude_path();
                let check_path = path.clone();
                tauri::async_runtime::spawn_blocking(move || ensure_claude_version(&check_path))
                    .await
                    .map_err(|e| format!("Claude version check worker failed: {e}"))??;
                Some(path)
            }
            Harness::Pi => None,
        };
        let spawn_cmd = agent_command(
            &agent,
            &resolved_room,
            &cwd,
            session_mode.as_deref(),
            harness,
            claude_path.as_deref(),
            role.as_deref(),
            &choice,
        )?;
        let argv = build_spawn_argv(&agent, &cwd, &lang, api_key.as_deref(), &spawn_cmd);
        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        tmux_run(&argv_refs)?;
        // Authoritative harness record; pane_harness falls back to the command only without it.
        if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), "@cubilot_harness", harness.as_str()]) {
            eprintln!("[pty] pty_spawn/@cubilot_harness (falls back to command inspection): {e}");
        }
        if let Some(r) = &role {
            // Best effort, like the harness record: a missing pill must not fail a launch that already runs.
            if let Ok(spec) = crate::factory::resolve_role_spec(r) {
                for (k, v) in role_options(&spec, &choice) {
                    if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), k, &v]) {
                        eprintln!("[pty] pty_spawn/{k} (pill only): {e}");
                    }
                }
            }
        }
        if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), "status", "off"]) {
            eprintln!("[pty] pty_spawn/status-off (best-effort): {e}");
        }
    }

    attach_and_stream(app, state.0.clone(), &agent, &lang)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyRegistry>,
    agent: String,
    b64: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let handle_arc = {
        let map = state.0.lock().unwrap();
        map.get(&agent)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent}"))?
    };
    let mut h = handle_arc.lock().unwrap();
    h.writer
        .write_all(&bytes)
        .map_err(|e| format!("write: {e}"))?;
    h.writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyRegistry>,
    agent: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle_arc = {
        let map = state.0.lock().unwrap();
        map.get(&agent)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent}"))?
    };
    let h = handle_arc.lock().unwrap();
    h.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(agent: String) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    tmux_run(&["kill-session", "-t", &tmux_session(&agent)])?;
    Ok(())
}

// Pinned "shell" tmux session — human's scratch shell. No claude, no MCP, no room.
#[tauri::command]
pub fn pty_spawn_shell(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let name = SHELL_SESSION_NAME;
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(name) {
            return Ok(());
        }
    }

    let lang = resolve_utf8_locale();
    let lang_env = format!("LANG={lang}");
    let lc_all_env = format!("LC_ALL={lang}");

    let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    // -il for parity with Terminal.app; explicit -i so plugin `[[ -o interactive ]]` guards fire.
    let shell_cmd = format!("'{}' -il", user_shell.replace('\'', r"'\''"));

    // .zshrc checks $CUBILOT_SHELL to scope Cubilot-only theming.
    let cubilot_marker_env = "CUBILOT_SHELL=1";

    let existed_shell = ensure_session_configured(name, &lang)?;
    if existed_shell {
        // allow-passthrough lets yazi's DA1/DSR probes reach xterm.js (silences "response timeout").
        let _ = tmux_run(&["set-option", "-t", &tmux_pane(name), "allow-passthrough", "on"]);
        let _ = tmux_run(&["set-environment", "-t", &tmux_session(name), "CUBILOT_SHELL", "1"]);
    } else {
        let args: Vec<&str> = vec![
            "new-session", "-d", "-s", name,
            "-e", "TERM=xterm-256color",
            "-e", "COLORTERM=truecolor",
            "-e", &lang_env,
            "-e", &lc_all_env,
            "-e", cubilot_marker_env,
            "-x", "80",
            "-y", "24",
            "-c", &home,
            &shell_cmd,
        ];
        tmux_run(&args)?;
        let _ = tmux_run(&["set-option", "-t", &tmux_pane(name), "status", "off"]);
        let _ = tmux_run(&["set-option", "-t", &tmux_pane(name), "allow-passthrough", "on"]);
    }

    attach_and_stream(app, state.0.clone(), name, &lang)
}

#[tauri::command]
pub fn pty_shell_exists() -> Result<bool, String> {
    Ok(session_exists(SHELL_SESSION_NAME))
}

#[tauri::command]
pub fn pty_list() -> Result<Vec<String>, String> {
    let tmux = resolve_tmux_bin()?;
    let sock = tmux_socket_path();
    let out = Command::new(tmux)
        .arg("-S")
        .arg(sock)
        .args(["list-sessions", "-F", "#S"])
        .output()
        .map_err(|e| format!("tmux list-sessions spawn: {e}"))?;
    if !out.status.success() {
        // "no server running" is exit 1 — treat as empty.
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let names: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| valid_agent_name(l))
        .collect();
    Ok(names)
}

#[tauri::command]
pub fn resolve_default_room(cwd: String) -> String {
    default_room_for_cwd(std::path::Path::new(&cwd))
}

// Live cwd of the agent's pane (tracks `cd`), not the original spawn path.
pub fn pane_current_path(agent: &str) -> Result<PathBuf, String> {
    if !valid_agent_name(agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let raw = tmux_run(&[
        "display-message", "-p", "-t", &tmux_pane(agent), "#{pane_current_path}",
    ])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("no pane_current_path for agent '{agent}'"));
    }
    Ok(PathBuf::from(trimmed))
}

// CaptureTransaction: RAII for geometry + pipe-pane state used by pty_capture_turn.

/// Tmux command runner — `RealTmux` for production, `FakeTmux` for tests.
pub trait TmuxRunner: Send + Sync {
    fn run(&self, args: &[&str]) -> Result<String, String>;
}

pub struct RealTmux;
impl TmuxRunner for RealTmux {
    fn run(&self, args: &[&str]) -> Result<String, String> {
        tmux_run(args)
    }
}

/// RAII for window-size geometry + pipe-pane. Drop disables pipe BEFORE restoring geometry
/// so the redraw bytes don't pollute the capture file.
pub struct CaptureTransaction<'a> {
    agent: &'a str,
    runner: &'a dyn TmuxRunner,
    pipe_on: bool,
    geometry_set: bool,
}

impl<'a> CaptureTransaction<'a> {
    pub fn new(agent: &'a str, runner: &'a dyn TmuxRunner) -> Self {
        Self { agent, runner, pipe_on: false, geometry_set: false }
    }

    pub fn set_geometry(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.runner
            .run(&["set-option", "-w", "-t", &tmux_pane(self.agent), "window-size", "manual"])
            .map_err(|e| format!("set window-size manual: {e}"))?;
        self.geometry_set = true;
        let cols_s = cols.to_string();
        let rows_s = rows.to_string();
        self.runner
            .run(&["resize-window", "-t", &tmux_pane(self.agent), "-x", &cols_s, "-y", &rows_s])
            .map_err(|e| format!("resize-window: {e}"))?;
        Ok(())
    }

    pub fn enable_pipe(&mut self, log_path: &std::path::Path) -> Result<(), String> {
        let pipe_target = format!(
            "cat >> '{}'",
            log_path.to_string_lossy().replace('\'', r"'\''")
        );
        self.runner
            .run(&["pipe-pane", "-o", "-t", &tmux_pane(self.agent), &pipe_target])
            .map_err(|e| format!("pipe-pane on: {e}"))?;
        self.pipe_on = true;
        Ok(())
    }
}

impl<'a> Drop for CaptureTransaction<'a> {
    fn drop(&mut self) {
        // Pipe FIRST so the geometry-restore redraw doesn't pollute the capture file.
        if self.pipe_on {
            if let Err(e) = self.runner.run(&["pipe-pane", "-t", &tmux_pane(self.agent)]) {
                eprintln!("[capture] Drop/pipe-pane-off (best-effort): {e}");
            }
        }
        if self.geometry_set {
            // resize -A BEFORE `latest`; `latest` first would be undone by the resize.
            if let Err(e) = self.runner.run(&["resize-window", "-t", &tmux_pane(self.agent), "-A"]) {
                eprintln!("[capture] Drop/resize -A (best-effort): {e}");
            }
            if let Err(e) = self.runner.run(&["set-option", "-w", "-u", "-t", &tmux_pane(self.agent), "window-size"]) {
                eprintln!("[capture] Drop/window-size-unset (best-effort): {e}");
            }
            if let Err(e) = self.runner.run(&["set-option", "-w", "-t", &tmux_pane(self.agent), "window-size", "latest"]) {
                eprintln!("[capture] Drop/window-size latest (best-effort): {e}");
            }
            if let Err(e) = self.runner.run(&["refresh-client", "-t", self.agent, "-S"]) {
                eprintln!("[capture] Drop/refresh-client (best-effort): {e}");
            }
        }
    }
}

// pty_capture_turn — deterministic single-turn TUI capture (geometry + pipe-pane + completion markers).
const CAPTURE_COLS: u16 = 240;
const CAPTURE_ROWS: u16 = 100;
const CAPTURE_RESIZE_SETTLE_MS: u64 = 200;
const CAPTURE_POLL_MS: u64 = 50;
const CAPTURE_DEFAULT_TIMEOUT_MS: u32 = 15_000;
const CAPTURE_KEEP_RECENT: usize = 10;
const CAPTURE_QUIESCENCE_MIN_MS: u64 = 1_500;
const CAPTURE_QUIESCENCE_STABLE_MS: u64 = 1_500;
const CAPTURE_READ_MAX_BYTES: usize = 256 * 1024;

const ALT_SCREEN_ENTER: &[u8] = b"\x1B[?1049h";
const ALT_SCREEN_EXIT: &[u8] = b"\x1B[?1049l";
const CURSOR_SHOW: &[u8] = b"\x1B[?25h";

#[derive(Serialize, Clone)]
pub struct CaptureResult {
    log_path: String,
    start_ms: u64,
    end_ms: u64,
    /// Completion reason: "alt-exit" | "idle-prompt" | "quiescence" | "timeout"
    status: String,
}

fn captures_dir(agent: &str) -> PathBuf {
    PathBuf::from("/tmp/cubilot").join(agent).join("captures")
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn find_subsequence(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() || needle.len() > haystack.len() - from {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

// Inline-mode idle signature: divider line, then `❯ ` prompt, then CURSOR_SHOW within 256 bytes.
fn detect_idle_prompt(buf: &[u8], from: usize) -> bool {
    const PROMPT_GLYPH: &[u8] = "❯ ".as_bytes();
    const DIVIDER_GLYPH: &[u8] = "─".as_bytes();
    let mut search_from = from;
    while let Some(p) = find_subsequence(buf, PROMPT_GLYPH, search_from) {
        let prompt_line_start = buf[..p].iter().rposition(|&c| c == b'\n').unwrap_or(0);
        if prompt_line_start > 0 {
            let above_end = prompt_line_start;
            let above_start = buf[..above_end].iter().rposition(|&c| c == b'\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            let above_line = &buf[above_start..above_end];
            let mut divider_count = 0usize;
            let mut i = 0;
            while i + DIVIDER_GLYPH.len() <= above_line.len() {
                if &above_line[i..i + DIVIDER_GLYPH.len()] == DIVIDER_GLYPH {
                    divider_count += 1;
                    i += DIVIDER_GLYPH.len();
                } else {
                    i += 1;
                }
            }
            if divider_count >= 30 {
                let scan_end = (p + 256).min(buf.len());
                if find_subsequence(&buf[..scan_end], CURSOR_SHOW, p).is_some() {
                    return true;
                }
            }
        }
        search_from = p + PROMPT_GLYPH.len();
    }
    false
}

fn prune_captures(dir: &std::path::Path, keep: usize) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?;
            if !name.ends_with(".log") || name.contains(".partial") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, p))
        })
        .collect();
    logs.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    for (_, p) in logs.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn pty_capture_turn(
    state: State<'_, PtyRegistry>,
    agent: String,
    input: String,
    timeout_ms: Option<u32>,
) -> Result<CaptureResult, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let timeout = timeout_ms.unwrap_or(CAPTURE_DEFAULT_TIMEOUT_MS) as u64;

    let cap_dir = captures_dir(&agent);
    std::fs::create_dir_all(&cap_dir)
        .map_err(|e| format!("mkdir {}: {e}", cap_dir.display()))?;

    let real_tmux = RealTmux;
    let mut tx = CaptureTransaction::new(&agent, &real_tmux);

    // Geometry FIRST so the resize redraw doesn't pollute the captured stream.
    tx.set_geometry(CAPTURE_COLS, CAPTURE_ROWS)?;
    std::thread::sleep(std::time::Duration::from_millis(CAPTURE_RESIZE_SETTLE_MS));

    let start_ms = epoch_ms();
    let log_path = cap_dir.join(format!("turn-{start_ms}.log"));
    std::fs::write(&log_path, b"")
        .map_err(|e| format!("touch {}: {e}", log_path.display()))?;

    tx.enable_pipe(&log_path)?;

    {
        let handle_arc = {
            let map = state.0.lock().unwrap();
            map.get(&agent)
                .cloned()
                .ok_or_else(|| format!("unknown agent: {agent}"))?
        };
        let mut h = handle_arc.lock().unwrap();
        let bytes = input.as_bytes();
        h.writer
            .write_all(bytes)
            .map_err(|e| format!("write: {e}"))?;
        h.writer.flush().map_err(|e| format!("flush: {e}"))?;
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut file_handle = std::fs::File::open(&log_path)
        .map_err(|e| format!("open {}: {e}", log_path.display()))?;
    let inject_instant = std::time::Instant::now();
    let deadline = inject_instant + std::time::Duration::from_millis(timeout);
    let mut last_change = inject_instant;
    let mut alt_screen_seen = false;
    let mut status: Option<&'static str> = None;

    while std::time::Instant::now() < deadline {
        let mut chunk = Vec::with_capacity(4096);
        if file_handle.read_to_end(&mut chunk).is_ok() && !chunk.is_empty() {
            buf.extend_from_slice(&chunk);
            last_change = std::time::Instant::now();
        }

        if !alt_screen_seen && find_subsequence(&buf, ALT_SCREEN_ENTER, 0).is_some() {
            alt_screen_seen = true;
        }

        if alt_screen_seen {
            let mut last_enter = 0usize;
            let mut search = 0usize;
            while let Some(p) = find_subsequence(&buf, ALT_SCREEN_ENTER, search) {
                last_enter = p;
                search = p + ALT_SCREEN_ENTER.len();
            }
            if find_subsequence(&buf, ALT_SCREEN_EXIT, last_enter + ALT_SCREEN_ENTER.len()).is_some() {
                status = Some("alt-exit");
                break;
            }
        }

        if !alt_screen_seen && detect_idle_prompt(&buf, 0) {
            status = Some("idle-prompt");
            break;
        }

        let elapsed = inject_instant.elapsed().as_millis() as u64;
        let stable = last_change.elapsed().as_millis() as u64;
        if !buf.is_empty()
            && elapsed >= CAPTURE_QUIESCENCE_MIN_MS
            && stable >= CAPTURE_QUIESCENCE_STABLE_MS
        {
            status = Some("quiescence");
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(CAPTURE_POLL_MS));
    }
    let final_status = status.unwrap_or("timeout");

    // Timeouts retained for forensics; only prune on success.
    if final_status != "timeout" {
        prune_captures(&cap_dir, CAPTURE_KEEP_RECENT);
    }

    let result = CaptureResult {
        log_path: log_path.to_string_lossy().to_string(),
        start_ms,
        end_ms: epoch_ms(),
        status: final_status.to_string(),
    };
    drop(tx);
    Ok(result)
}

// Idempotent heal so a stuck pane (e.g. interrupted capture left window-size=manual) self-heals.
#[tauri::command]
pub fn pty_heal_geometry(agent: String) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let _ = tmux_run(&["resize-window", "-t", &tmux_pane(&agent), "-A"]);
    let _ = tmux_run(&["set-option", "-w", "-u", "-t", &tmux_pane(&agent), "window-size"]);
    let _ = tmux_run(&["set-option", "-w", "-t", &tmux_pane(&agent), "window-size", "latest"]);
    let _ = tmux_run(&["refresh-client", "-t", &agent, "-S"]);
    Ok(())
}

// `capture-pane -p` returns FULL current state (replaced a pipe-pane tap that missed the footer redraw).
#[tauri::command]
pub fn pty_tap_read(agent: String, duration_ms: Option<u32>) -> Result<String, String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent: {agent}"));
    }
    let duration = duration_ms.unwrap_or(250).clamp(0, 2000) as u64;
    if duration > 0 {
        std::thread::sleep(std::time::Duration::from_millis(duration));
    }
    Ok(tmux_run(&["capture-pane", "-p", "-t", &tmux_pane(&agent)]).unwrap_or_default())
}

// /tmp/cubilot/ path-prefix guard prevents arbitrary file read via JS misuse.
#[tauri::command]
pub fn pty_read_capture(log_path: String, max_bytes: Option<u32>) -> Result<String, String> {
    let cap = max_bytes.map(|n| n as usize).unwrap_or(CAPTURE_READ_MAX_BYTES);
    let path = std::path::Path::new(&log_path);
    if !path.starts_with("/tmp/cubilot/") {
        return Err(format!("path outside capture dir: {log_path}"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {log_path}: {e}"))?;
    let trimmed = if bytes.len() > cap { &bytes[..cap] } else { &bytes[..] };
    Ok(String::from_utf8_lossy(trimmed).to_string())
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn alt_screen_exit_substring_match() {
        let buf = b"prefix\x1B[?1049henter then content \x1B[?1049l done";
        assert!(find_subsequence(buf, ALT_SCREEN_ENTER, 0).is_some());
        assert!(find_subsequence(buf, ALT_SCREEN_EXIT, 0).is_some());
        let enter_pos = find_subsequence(buf, ALT_SCREEN_ENTER, 0).unwrap();
        let exit_pos = find_subsequence(buf, ALT_SCREEN_EXIT, 0).unwrap();
        assert!(exit_pos > enter_pos);
    }

    #[test]
    fn idle_prompt_detects_divider_prompt_cursor() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"some prior content\n");
        for _ in 0..40 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF \x1B[?25h");
        assert!(detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn idle_prompt_rejects_short_divider() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"text\n");
        for _ in 0..10 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF \x1B[?25h");
        assert!(!detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn idle_prompt_requires_cursor_show_after_prompt() {
        let mut buf = Vec::new();
        for _ in 0..40 {
            buf.extend_from_slice("─".as_bytes());
        }
        buf.extend_from_slice(b"\n\xE2\x9D\xAF no cursor follows");
        assert!(!detect_idle_prompt(&buf, 0));
    }

    #[test]
    fn prune_keeps_n_most_recent_logs() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cubilot-prune-test-{}-{}", epoch_ms(), n));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            let p = dir.join(format!("turn-{i}.log"));
            std::fs::write(&p, b"x").unwrap();
            // Sleep so SystemTime ordering is deterministic.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        prune_captures(&dir, 3);
        let remaining: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_ignores_partial_files() {
        let dir = std::env::temp_dir().join(format!("cubilot-prune-partial-{}", epoch_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("turn-1.log"), b"x").unwrap();
        std::fs::write(dir.join("turn-2.partial.log"), b"x").unwrap();
        std::fs::write(dir.join("turn-3.log"), b"x").unwrap();
        prune_captures(&dir, 1);
        let remaining: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod capture_transaction_tests {
    use super::{CaptureTransaction, TmuxRunner};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::PathBuf;
    use std::sync::Mutex;

    struct FakeTmux {
        calls: Mutex<Vec<Vec<String>>>,
        fail_on_call: Option<(usize, String)>,
    }
    impl FakeTmux {
        fn new() -> Self {
            Self { calls: Mutex::new(Vec::new()), fail_on_call: None }
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl TmuxRunner for FakeTmux {
        fn run(&self, args: &[&str]) -> Result<String, String> {
            let mut calls = self.calls.lock().unwrap();
            calls.push(args.iter().map(|s| s.to_string()).collect());
            let call_idx = calls.len();
            if let Some((n, msg)) = &self.fail_on_call {
                if *n == call_idx {
                    return Err(msg.clone());
                }
            }
            Ok(String::new())
        }
    }

    fn args_match(call: &[String], expected: &[&str]) -> bool {
        if call.len() != expected.len() {
            return false;
        }
        call.iter().zip(expected.iter()).all(|(a, b)| a == b)
    }

    fn count_calls_starting_with(calls: &[Vec<String>], prefix: &str) -> usize {
        calls.iter().filter(|c| c.first().map(String::as_str) == Some(prefix)).count()
    }

    #[test]
    fn set_geometry_records_window_size_manual_and_resize() {
        let fake = FakeTmux::new();
        {
            let mut tx = CaptureTransaction::new("alice", &fake);
            tx.set_geometry(240, 100).unwrap();
        }
        let calls = fake.calls();
        // set-option window-size manual
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-t", "=alice:", "window-size", "manual"])));
        // resize-window -x 240 -y 100
        assert!(calls.iter().any(|c| args_match(c, &["resize-window", "-t", "=alice:", "-x", "240", "-y", "100"])));
    }

    #[test]
    fn drop_restores_geometry_when_set() {
        let fake = FakeTmux::new();
        {
            let mut tx = CaptureTransaction::new("alice", &fake);
            tx.set_geometry(240, 100).unwrap();
        } // tx drops here
        let calls = fake.calls();
        // Cleanup sequence in declared order: resize -A, window-size unset, window-size latest, refresh-client
        assert!(calls.iter().any(|c| args_match(c, &["resize-window", "-t", "=alice:", "-A"])),
            "expected resize -A in cleanup; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-u", "-t", "=alice:", "window-size"])),
            "expected window-size unset; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-t", "=alice:", "window-size", "latest"])),
            "expected window-size latest; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["refresh-client", "-t", "alice", "-S"])),
            "expected refresh-client; got {calls:?}");
    }

    #[test]
    fn drop_disables_pipe_when_enabled() {
        let fake = FakeTmux::new();
        {
            let mut tx = CaptureTransaction::new("alice", &fake);
            tx.enable_pipe(&PathBuf::from("/tmp/test.log")).unwrap();
        }
        let calls = fake.calls();
        // pipe-pane -o -t =alice: 'cat >> /tmp/test.log'  (the enable)
        let enable = calls.iter().find(|c|
            c.len() >= 4
            && c[0] == "pipe-pane"
            && c[1] == "-o"
            && c[2] == "-t"
            && c[3] == "=alice:"
        );
        assert!(enable.is_some(), "expected pipe-pane enable; got {calls:?}");
        // pipe-pane -t =alice:   (the disable, 3 args)
        let disable = calls.iter().find(|c|
            args_match(c, &["pipe-pane", "-t", "=alice:"])
        );
        assert!(disable.is_some(), "expected pipe-pane disable; got {calls:?}");
    }

    #[test]
    fn drop_runs_cleanup_in_pipe_then_geometry_order() {
        let fake = FakeTmux::new();
        {
            let mut tx = CaptureTransaction::new("alice", &fake);
            tx.set_geometry(240, 100).unwrap();
            tx.enable_pipe(&PathBuf::from("/tmp/test.log")).unwrap();
        }
        let calls = fake.calls();
        let pipe_disable_pos = calls.iter().position(|c|
            args_match(c, &["pipe-pane", "-t", "=alice:"])
        ).expect("pipe disable should run");
        let geometry_restore_pos = calls.iter().position(|c|
            args_match(c, &["resize-window", "-t", "=alice:", "-A"])
        ).expect("geometry restore should run");
        assert!(pipe_disable_pos < geometry_restore_pos,
            "pipe disable must run BEFORE geometry restore (avoids resize redraw landing in capture file); \
            pipe@{pipe_disable_pos} vs geometry@{geometry_restore_pos}: {calls:?}");
    }

    #[test]
    fn drop_skips_cleanup_when_state_was_never_set() {
        let fake = FakeTmux::new();
        {
            let _tx = CaptureTransaction::new("alice", &fake);
            // Never called set_geometry or enable_pipe.
        }
        let calls = fake.calls();
        assert_eq!(calls.len(), 0, "Drop must be a no-op when nothing was enabled; got {calls:?}");
    }

    #[test]
    fn drop_runs_on_panic_unwind() {
        // The panic-path test the audit explicitly called out. Uses catch_unwind +
        // AssertUnwindSafe (FakeTmux contains Mutex which is !UnwindSafe).
        // Standard panic-hook suppression is NOT needed because we're inside a `#[test]`
        // and the catch_unwind absorbs the panic before the test runner sees it.

        let fake = FakeTmux::new();
        let fake_ref = &fake; // borrow that lives across the closure

        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut tx = CaptureTransaction::new("alice", fake_ref);
            tx.set_geometry(240, 100).unwrap();
            tx.enable_pipe(&PathBuf::from("/tmp/panic.log")).unwrap();
            panic!("INTENTIONAL PANIC FROM TEST");
        }));

        // The closure panicked.
        assert!(result.is_err(), "closure should have panicked");

        // BUT — Drop ran during unwind. Both cleanup arms recorded their tmux calls.
        let calls = fake.calls();
        assert!(count_calls_starting_with(&calls, "pipe-pane") >= 2,
            "expected pipe-pane enable + disable on panic-unwind; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["resize-window", "-t", "=alice:", "-A"])),
            "expected geometry restore on panic-unwind; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-t", "=alice:", "window-size", "latest"])),
            "expected window-size latest on panic-unwind; got {calls:?}");
    }

    #[test]
    fn drop_continues_when_one_cleanup_arm_fails() {
        // Critical invariant: a panic-safe cleanup arm. If `resize-window -A` returns Err,
        // the SUBSEQUENT cleanup arms must still run. Drop uses if-let-Err + eprintln rather
        // than `?` propagation specifically so a single tmux failure doesn't strand the
        // session in window-size=manual.
        let fake = FakeTmux {
            calls: Mutex::new(Vec::new()),
            // Fail call #3 (set_geometry uses calls 1+2; pipe-disable in Drop is call #3 OR
            // resize-window -A is call #3 depending on what we set). Sequence with both
            // pipe+geometry enabled: 1=set-option manual, 2=resize 240×100, 3=pipe-pane on,
            // 4=pipe-pane off (Drop), 5=resize -A (Drop). Fail #5 to test geometry mid-cleanup.
            fail_on_call: Some((5, "synthetic tmux failure".to_string())),
        };
        {
            let mut tx = CaptureTransaction::new("alice", &fake);
            tx.set_geometry(240, 100).unwrap();
            tx.enable_pipe(&PathBuf::from("/tmp/x.log")).unwrap();
        }
        let calls = fake.calls();
        // Despite the failure at call #5, calls #6 and #7 (window-size unset/latest) and #8
        // (refresh-client) MUST have been attempted.
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-u", "-t", "=alice:", "window-size"])),
            "expected window-size unset AFTER a failed cleanup arm; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["set-option", "-w", "-t", "=alice:", "window-size", "latest"])),
            "expected window-size latest AFTER a failed cleanup arm; got {calls:?}");
        assert!(calls.iter().any(|c| args_match(c, &["refresh-client", "-t", "alice", "-S"])),
            "expected refresh-client AFTER a failed cleanup arm; got {calls:?}");
    }
}

#[cfg(test)]
mod spawn_argv_tests {
    //! Pure-function tests for `build_spawn_argv`. No tmux required.

    use super::{
        build_spawn_argv, check_claude_version, claude_command_using, claude_resource_flags,
        command_executable, ensure_claude_version, format_claude_command, parse_claude_version,
        read_claude_version, read_claude_version_with_timeout, harness_from_command, harness_from_option,
        parse_global_mcp_servers, write_global_mcp_config, Harness,
    };

    #[test]
    fn argv_starts_with_new_session_form() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude --resume");
        assert_eq!(&argv[0..4], &["new-session", "-d", "-s", "alice"]);
    }

    #[test]
    fn argv_includes_terminal_env_vars() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude");
        let joined = argv.join(" ");
        assert!(joined.contains("TERM=xterm-256color"), "missing TERM env: {joined}");
        assert!(joined.contains("COLORTERM=truecolor"), "missing COLORTERM env: {joined}");
        assert!(joined.contains("LANG=en_US.UTF-8"), "missing LANG env: {joined}");
        assert!(joined.contains("LC_ALL=en_US.UTF-8"), "missing LC_ALL env: {joined}");
        assert!(joined.contains("CUBILOT_DATA_DIR="), "missing CUBILOT_DATA_DIR env: {joined}");
    }

    #[test]
    fn argv_includes_anthropic_api_key_when_provided() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", Some("sk-test-123"), "claude");
        let joined = argv.join(" ");
        assert!(joined.contains("ANTHROPIC_API_KEY=sk-test-123"), "missing API key env: {joined}");
    }

    #[test]
    fn argv_omits_anthropic_api_key_when_none() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude");
        let joined = argv.join(" ");
        assert!(!joined.contains("ANTHROPIC_API_KEY"), "should omit API key env when None: {joined}");
    }

    #[test]
    fn argv_includes_xy_dimensions_and_cwd() {
        let argv = build_spawn_argv("alice", "/some/cwd", "en_US.UTF-8", None, "claude");
        // -x 80 -y 24 is load-bearing: tmux probes TIOCGWINSZ without these dims.
        assert!(argv.iter().any(|s| s == "-x"));
        assert!(argv.iter().any(|s| s == "80"));
        assert!(argv.iter().any(|s| s == "-y"));
        assert!(argv.iter().any(|s| s == "24"));
        assert!(argv.iter().any(|s| s == "/some/cwd"));
    }

    #[test]
    fn argv_passes_spawn_cmd_as_single_element() {
        // The v0.6 regression: a spawn cmd containing quoted paths-with-spaces was being
        // tokenized by /bin/sh's argv-join. The fix is to pass spawn_cmd as a SINGLE
        // tmux argv element so tmux sees it as one shell-quoted command-string argument.
        let spawn_cmd = "CHATBRIDGE_AGENT='alice' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/claude' --plugin-dir '/Users/me/Application Support/Cubilot/chatbridge-mod' --allowed-tools 'mcp__chatbridge__post'";
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, spawn_cmd);
        let last = argv.last().unwrap();
        // The spawn_cmd appears verbatim as a SINGLE argv element — quotes, spaces, and all.
        assert_eq!(last, spawn_cmd);
        // Sanity: no element of argv splits the spawn_cmd into multiple tokens.
        let occurrences = argv.iter().filter(|s| s.contains("--plugin-dir")).count();
        assert_eq!(occurrences, 1, "spawn_cmd appears multiple times — got split: {argv:?}");
    }

    #[test]
    fn claude_command_uses_plugin_dir_and_env_identity_only() {
        use std::path::Path;
        let cmd = format_claude_command(
            "Dev 1", "EU Space", Some("resume"),
            Path::new("/Users/me/bin/claude"),
            Path::new("/Users/me/Library/Application Support/Cubilot/chatbridge-mod"),
            None,
            None,
        ).unwrap();
        assert!(cmd.starts_with("CHATBRIDGE_AGENT='Dev 1' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/claude' --resume --plugin-dir '"), "{cmd}");
        assert!(cmd.contains("--plugin-dir '/Users/me/Library/Application Support/Cubilot/chatbridge-mod'"), "{cmd}");
        assert!(cmd.contains("--allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'"), "{cmd}");
        assert!(!cmd.contains(concat!("--mcp", "-config")), "{cmd}");
        assert!(!cmd.contains(concat!("dangerously", "-load-development-channels")), "{cmd}");
        assert!(!cmd.contains("CHATBRIDGE_HUB"), "{cmd}");
        // Still one tmux argv element.
        let argv = build_spawn_argv("Dev 1", "/tmp", "en_US.UTF-8", None, &cmd);
        assert_eq!(argv.last().unwrap(), &cmd);
    }

    #[test]
    fn claude_command_with_global_servers_has_one_mcp_config_after_plugin_dir() {
        use std::path::Path;
        let cmd = format_claude_command(
            "alice", "r", None, Path::new("/c"), Path::new("/m"),
            Some(Path::new("/Users/me/Application Support/Cubilot/mcp-configs/global.json")),
            None,
        ).unwrap();
        let flag = concat!("--mcp", "-config");
        assert_eq!(cmd.matches(flag).count(), 1, "{cmd}");
        assert!(
            cmd.contains(&format!("--plugin-dir '/m' {flag} '/Users/me/Application Support/Cubilot/mcp-configs/global.json' --allowed-tools")),
            "{cmd}"
        );
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, &cmd);
        assert_eq!(argv.last().unwrap(), &cmd);
        assert_eq!(argv.iter().filter(|s| s.contains(flag)).count(), 1, "{argv:?}");
    }

    #[test]
    fn global_mcp_file_is_filtered_private_and_atomic() {
        use std::os::unix::fs::PermissionsExt;
        let raw = r#"{"_comment":"x","mcpServers":{"chatbridge":{"command":"evil"},"context7":{"command":"c7","prompts":["p"]},"serena":{"command":"s"}}}"#;
        let servers = parse_global_mcp_servers(raw, "test");
        let root = std::env::temp_dir().join(format!("cubilot-gmcp-{}", std::process::id()));
        let dir = root.join("mcp-configs");
        let _ = std::fs::remove_dir_all(&root);
        let path = write_global_mcp_config(&dir, servers).unwrap().expect("file written");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("chatbridge"), "{text}");
        assert!(!text.contains("_comment"), "{text}");
        assert!(!text.contains("prompts"), "{text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let names: Vec<_> = v["mcpServers"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(names, vec!["context7", "serena"]);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let leftovers = std::fs::read_dir(&dir).unwrap()
            .filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".tmp-")).count();
        assert_eq!(leftovers, 0);
        // Empty map: no flag source, and a stale file is removed.
        assert!(write_global_mcp_config(&dir, Default::default()).unwrap().is_none());
        assert!(!path.exists());
        // Only the reserved name configured -> empty after filtering -> no file.
        let only = parse_global_mcp_servers(r#"{"mcpServers":{"chatbridge":{}}}"#, "test");
        assert!(write_global_mcp_config(&dir, only).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn global_mcp_write_fails_only_when_the_dir_cannot_be_created() {
        let root = std::env::temp_dir().join(format!("cubilot-gmcp-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let servers = || parse_global_mcp_servers(r#"{"mcpServers":{"context7":{"command":"c7"}}}"#, "test");
        // The directory is a file: the write of global.json fails, and it says so.
        let not_a_dir = root.join("file-not-dir");
        std::fs::write(&not_a_dir, "x").unwrap();
        let err = write_global_mcp_config(&not_a_dir, servers()).unwrap_err();
        assert!(err.contains("create") && err.contains("file-not-dir"), "{err}");
        // Nothing to write: no error.
        assert!(write_global_mcp_config(&not_a_dir, Default::default()).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_command_escapes_single_quotes_and_rejects_bad_session_mode() {
        use std::path::Path;
        let cmd = format_claude_command("o'neil", "r'm", None, Path::new("/c"), Path::new("/m"), None, None).unwrap();
        assert!(cmd.contains(r"CHATBRIDGE_AGENT='o'\''neil'"), "{cmd}");
        assert!(cmd.contains(r"CHATBRIDGE_ROOM='r'\''m'"), "{cmd}");
        assert!(format_claude_command("a", "r", Some("bogus"), Path::new("/c"), Path::new("/m"), None, None).is_err());
    }

    // A real staged tree: the repo's factory/ staged into a temp app-data dir, plus a settings file for the agent.
    fn staged_role(role: &str, agent: &str) -> (std::path::PathBuf, crate::factory::RoleLaunch) {
        use crate::factory::*;
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("cubilot-pty-role-{role}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let version = dest.join(&v);
        let home = root.join("home/.claude");
        std::fs::create_dir_all(&home).unwrap();
        let settings = write_agent_settings(agent, role, &root, &home, &root.join("settings")).unwrap();
        let spec = load_role_spec(role, &src, &version).unwrap();
        let settings = if spec.harness == "claude" { Some(settings) } else { None };
        (root, role_launch(&spec, &version, settings))
    }

    #[test]
    fn claude_command_without_a_role_is_byte_for_byte_the_old_command() {
        use std::path::Path;
        let none = format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, None).unwrap();
        assert_eq!(
            none,
            "CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/c' --plugin-dir '/m' --allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'"
        );
        assert!(!none.contains("CHATBRIDGE_ROLE") && !none.contains("factory"));
    }

    #[test]
    fn role_worker_command_loads_the_role_and_shared_plugin_prompt_file_settings_and_model() {
        use std::path::Path;
        let (root, launch) = staged_role("worker", "worker-1");
        let cmd = format_claude_command("worker-1", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&launch)).unwrap();
        let v = launch.plugin_dir.parent().unwrap().display().to_string();
        assert!(cmd.contains("CHATBRIDGE_ROLE='worker' '/c'"), "{cmd}");
        assert!(cmd.contains(&format!("--plugin-dir '{v}/worker'")), "test 2: role plugin: {cmd}");
        assert!(cmd.contains(&format!("--plugin-dir '{v}/shared'")), "test 11: shared plugin: {cmd}");
        assert!(cmd.contains(&format!("--append-system-prompt-file '{v}/worker/role.md'")), "test 2: prompt file: {cmd}");
        assert!(cmd.contains("--model 'sonnet'"), "test 2: {cmd}");
        assert!(cmd.contains("--settings '") && cmd.contains("/settings/worker-1.json'"), "{cmd}");
        // the chatbridge mod, and the allow rule 4.1 will change, stay as they were
        assert!(cmd.contains("--plugin-dir '/m' --plugin-dir '"), "{cmd}");
        assert!(cmd.contains("--allowed-tools 'mcp__chatbridge__post,mcp__chatbridge__post_file,mcp__chatbridge__send_handoff,"), "{cmd}");
        // still one tmux argv element
        let argv = build_spawn_argv("worker-1", "/tmp", "en_US.UTF-8", None, &cmd);
        assert_eq!(argv.last().unwrap(), &cmd);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn role_editor_command_has_model_sonnet_and_blocks_task_and_agent() {
        use std::path::Path;
        let (root, launch) = staged_role("editor", "editor-1");
        let cmd = format_claude_command("editor-1", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&launch)).unwrap();
        assert!(cmd.contains("--model 'sonnet'"), "test 3: {cmd}");
        assert!(cmd.contains("--disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission'"), "test 3 and 4.1: {cmd}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shared_plugin_holds_asd_ste100_and_no_role_plugin_does() {
        let (root, launch) = staged_role("worker", "worker-1");
        let v = launch.plugin_dir.parent().unwrap().to_path_buf();
        assert!(launch.shared_dir.join("skills/asd-ste100/SKILL.md").is_file());
        for e in std::fs::read_dir(&v).unwrap().flatten() {
            if e.file_name() != "shared" {
                assert!(!e.path().join("skills/asd-ste100").exists(), "test 11: {:?}", e.file_name());
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_with_a_bad_role_name_is_refused() {
        use std::path::Path;
        let (root, mut launch) = staged_role("worker", "worker-1");
        for bad in ["wor'ker", "../x", "a b", "", "Worker"] {
            launch.name = bad.to_string();
            assert!(
                format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&launch)).is_err(),
                "{bad:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pi_role_does_not_launch_on_claude_and_a_claude_role_not_on_pi() {
        use std::path::Path;
        let (root, pi) = staged_role("validator", "v");
        let err = format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&pi)).unwrap_err();
        assert!(err.contains("runs on pi, not claude"), "{err}");
        let (root2, claude) = staged_role("worker", "w");
        let err = pi_role_flags_for_test(&claude).unwrap_err();
        assert!(err.contains("not pi"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    // pi_command needs the pi extension and pi binary on disk; the role part is what these tests are about.
    fn pi_role_flags_for_test(r: &crate::factory::RoleLaunch) -> Result<String, String> {
        if r.harness != "pi" {
            return Err(format!("role '{}' runs on {}, not pi", r.name, r.harness));
        }
        let (env, flags) = super::pi_role_flags(r)?;
        Ok(format!("{env}{flags}"))
    }

    #[test]
    fn role_validator_pi_flags_have_provider_model_thinking_prompt_skills_and_exclude_tools() {
        let (root, launch) = staged_role("validator", "v");
        let f = pi_role_flags_for_test(&launch).unwrap();
        let v = launch.plugin_dir.parent().unwrap().display().to_string();
        assert!(f.starts_with("CHATBRIDGE_ROLE='validator' --no-skills "), "{f}");
        assert!(f.contains("--provider 'openai-codex'"), "test 6: {f}");
        assert!(f.contains("--model 'gpt-5.6-sol'"), "test 6: {f}");
        assert!(f.contains("--thinking 'high'"), "test 6: {f}");
        assert!(f.contains(&format!("--append-system-prompt '{v}/validator/role.md'")), "test 6: {f}");
        assert!(f.contains("--exclude-tools 'edit,write,ack_permission'"), "test 6 and 4.1: {f}");
        assert!(!f.contains("--tools"), "test 6: no allowlist: {f}");
        // test 11: role skills first, then shared; both from the staged version, not ~/.claude/skills
        let role_at = f.find(&format!("--skill '{v}/validator/skills'")).expect("role skills");
        let shared_at = f.find(&format!("--skill '{v}/shared/skills'")).expect("shared skills");
        assert!(role_at < shared_at, "{f}");
        assert!(launch.shared_dir.join("skills/asd-ste100/SKILL.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pi_role_command_has_exactly_two_skill_folders_and_none_inherited() {
        // the real pi_command needs pi-extension.js; the test says so loudly if it is missing
        if crate::resolve_pi_extension().is_err() {
            eprintln!("SKIPPED pi_command role test: pi-extension.js not found from the test binary");
            return;
        }
        // a project that WOULD give claude_resource_flags a --skill and a --prompt-template folder
        let proj = std::env::temp_dir().join(format!("cubilot-pi-proj-{}", std::process::id()));
        std::fs::create_dir_all(proj.join(".claude/skills")).unwrap();
        std::fs::create_dir_all(proj.join(".claude/commands")).unwrap();
        let (root, launch) = staged_role("validator", "v");
        let cwd = proj.to_string_lossy().into_owned();
        let plain = super::pi_command("v", "r", &cwd, None, None).unwrap();
        assert!(plain.contains("--prompt-template"), "setup: the plain command inherits folders: {plain}");
        let cmd = super::pi_command("v", "r", &cwd, None, Some(&launch)).unwrap();
        assert_eq!(cmd.matches("--skill '").count(), 2, "test 6: {cmd}");
        assert!(!cmd.contains("--prompt-template"), "test 6: {cmd}");
        assert!(!cmd.contains(&proj.to_string_lossy().to_string()), "test 6: no inherited project folder: {cmd}");
        assert!(cmd.contains("--no-approve --no-skills "), "test 11: {cmd}");
        assert!(cmd.find("/validator/skills'").unwrap() < cmd.find("/shared/skills'").unwrap(), "{cmd}");
        assert!(cmd.contains(" -e '"), "extension kept: {cmd}");
        assert!(!cmd.contains("--tools"), "{cmd}");
        let none = super::pi_command("v", "r", &cwd, None, None).unwrap();
        assert_eq!(none, plain);
        assert!(!none.contains("CHATBRIDGE_ROLE") && !none.contains("--no-skills"), "{none}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&proj);
    }

    #[test]
    fn spawn_role_accepts_blank_and_a_valid_role_and_refuses_unknown_and_council() {
        use crate::factory::*;
        let root = std::env::temp_dir().join(format!("cubilot-spawn-role-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let check = |r: &str| load_role_spec(r, &src, &version).map(|_| ());
        assert_eq!(super::spawn_role_with(None, &check), Ok(None));
        assert_eq!(super::spawn_role_with(Some("".into()), &check), Ok(None), "empty");
        assert_eq!(super::spawn_role_with(Some("  ".into()), &check), Ok(None), "blank");
        assert_eq!(super::spawn_role_with(Some(" worker ".into()), &check), Ok(Some("worker".into())), "valid, trimmed");
        assert!(super::spawn_role_with(Some("nope".into()), &check).unwrap_err().contains("unknown role"));
        assert!(super::spawn_role_with(Some("a11y".into()), &check).unwrap_err().contains("council"));
        assert!(super::spawn_role_with(Some("../worker".into()), &check).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_role_harness_replaces_the_requested_harness() {
        use crate::factory::*;
        let root = std::env::temp_dir().join(format!("cubilot-harness-role-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let of = |r: &str| load_role_spec(r, &src, &version).map(|s| s.harness);
        // test 6: validator with the modal on Claude builds the Pi command
        assert_eq!(super::harness_for_role_with(Harness::Claude, Some("validator"), &of), Ok(Harness::Pi));
        // a Claude role with the modal on Pi builds the Claude command
        assert_eq!(super::harness_for_role_with(Harness::Pi, Some("worker"), &of), Ok(Harness::Claude));
        // no role: the argument is used as before
        assert_eq!(super::harness_for_role_with(Harness::Pi, None, &of), Ok(Harness::Pi));
        assert_eq!(super::harness_for_role_with(Harness::Claude, None, &of), Ok(Harness::Claude));
        // an unknown role is still an error
        assert!(super::harness_for_role_with(Harness::Claude, Some("nope"), &of).is_err());
        // and the command builders follow: the validator launch builds with pi, not claude
        let launch = {
            let spec = load_role_spec("validator", &src, &version).unwrap();
            role_launch(&spec, &version, None)
        };
        assert!(super::format_claude_command("a", "r", None, std::path::Path::new("/c"), std::path::Path::new("/m"), None, Some(&launch)).is_err());
        let (env, flags) = super::pi_role_flags(&launch).unwrap();
        assert!(env.contains("validator") && flags.contains("--provider 'openai-codex'"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn choice(model: Option<&str>, provider: Option<&str>, effort: Option<&str>) -> crate::factory::LaunchChoice {
        crate::factory::LaunchChoice {
            model: model.map(str::to_string),
            provider: provider.map(str::to_string),
            effort: effort.map(str::to_string),
        }
    }

    #[test]
    fn a_chosen_cell_gives_model_and_effort_for_claude_and_a_default_cell_adds_nothing() {
        use crate::factory::*;
        use std::path::Path;
        let (root, launch) = staged_role("worker", "worker-2");
        let cmd = |l: &RoleLaunch| format_claude_command("worker-2", "r", None, Path::new("/c"), Path::new("/m"), None, Some(l)).unwrap();
        // the default cell (nothing sent): the role's own model, and no --effort at all
        let d = cmd(&launch);
        assert!(d.contains("--model 'sonnet'") && !d.contains("--effort"), "{d}");
        // a chosen cell: --model and --effort, each once, the role default model replaced
        let c = cmd(&with_choice(role_launch(&load_role_spec("worker", &Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory"), launch.plugin_dir.parent().unwrap()).unwrap(), launch.plugin_dir.parent().unwrap(), launch.settings.clone()), &choice(Some("opus"), None, Some("high"))));
        assert!(c.contains("--model 'opus'") && c.contains("--effort 'high'"), "{c}");
        assert!(!c.contains("--model 'sonnet'") && c.matches("--model").count() == 1 && c.matches("--effort").count() == 1, "{c}");
        // effort only (same model as the default): no --model change
        let e = cmd(&with_choice(role_launch(&load_role_spec("worker", &Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory"), launch.plugin_dir.parent().unwrap()).unwrap(), launch.plugin_dir.parent().unwrap(), launch.settings.clone()), &choice(None, None, Some("max"))));
        assert!(e.contains("--model 'sonnet'") && e.contains("--effort 'max'"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_chosen_cell_gives_provider_model_and_thinking_for_pi() {
        use crate::factory::*;
        let (root, pi) = staged_role("validator", "v");
        let (_, d) = super::pi_role_flags(&pi).unwrap();
        // default cell: the role's own values
        assert!(d.contains("--model 'gpt-5.6-sol'") && d.contains("--thinking 'high'") && d.contains("--provider 'openai-codex'"), "{d}");
        // a chosen cell: model, provider and the thinking level replace them, each once
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let vd = pi.plugin_dir.parent().unwrap().to_path_buf();
        let fresh = || role_launch(&load_role_spec("validator", &src, &vd).unwrap(), &vd, None);
        let (_, c) = super::pi_role_flags(&with_choice(fresh(), &choice(Some("claude-fable-5"), Some("anthropic"), Some("xhigh")))).unwrap();
        assert!(c.contains("--provider 'anthropic'") && c.contains("--model 'claude-fable-5'") && c.contains("--thinking 'xhigh'"), "{c}");
        assert!(!c.contains("gpt-5.6-sol") && !c.contains("'high'") && c.matches("--model").count() == 1, "{c}");
        // thinking only: the role's model and provider stay
        let (_, t) = super::pi_role_flags(&with_choice(fresh(), &choice(None, None, Some("off")))).unwrap();
        assert!(t.contains("--model 'gpt-5.6-sol'") && t.contains("--thinking 'off'") && !t.contains("--effort"), "{t}");
        // only this launch: a fresh launch from the role file has the default again
        assert!(super::pi_role_flags(&fresh()).unwrap().1.contains("--thinking 'high'"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn without_a_role_a_choice_is_appended_and_an_empty_choice_changes_nothing() {
        use crate::factory::LaunchChoice;
        assert_eq!(super::choice_flags(false, &LaunchChoice::default()), "");
        assert_eq!(super::choice_flags(true, &LaunchChoice::default()), "");
        assert_eq!(super::choice_flags(false, &choice(Some("opus"), None, Some("high"))), " --model 'opus' --effort 'high'");
        assert_eq!(
            super::choice_flags(true, &choice(Some("gpt-5.6-sol"), Some("openai-codex"), Some("high"))),
            " --provider 'openai-codex' --model 'gpt-5.6-sol' --thinking 'high'"
        );
    }

    #[test]
    fn the_choice_is_checked_for_the_harness_and_a_bad_value_is_refused() {
        use crate::factory::launch_choice;
        // blank is "not set"
        assert_eq!(launch_choice(false, Some(" "), Some(""), None).unwrap(), crate::factory::LaunchChoice::default());
        // Claude effort levels; "off" and "minimal" are Pi only
        for e in ["low", "medium", "high", "xhigh", "max"] {
            assert!(launch_choice(false, Some("opus"), None, Some(e)).is_ok(), "{e}");
        }
        for e in ["off", "minimal", "HIGH", "ultra", "high;ls"] {
            assert!(launch_choice(false, None, None, Some(e)).unwrap_err().contains("invalid effort"), "{e}");
        }
        // Pi thinking levels
        for e in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
            assert!(launch_choice(true, Some("gpt-5.6-sol"), Some("openai-codex"), Some(e)).is_ok(), "{e}");
        }
        assert!(launch_choice(true, None, None, Some("ultra")).unwrap_err().contains("invalid thinking level"));
        // a provider is Pi only, and the model and provider are shell-safe
        assert!(launch_choice(false, None, Some("openai-codex"), None).unwrap_err().contains("only applies to a Pi launch"));
        for bad in ["o'pus", "a b", "$(x)", "x;y"] {
            assert!(launch_choice(true, Some(bad), None, None).is_err(), "model {bad:?}");
            assert!(launch_choice(true, None, Some(bad), None).is_err(), "provider {bad:?}");
        }
    }

    #[test]
    fn a_bad_model_id_is_refused_and_a_real_one_is_not() {
        use crate::factory::{launch_choice, valid_model};
        // the real bad cases: a space, a quote, ";", "$(x)", a newline, a backtick, "|", "&", ">", a tab, a NUL, non-ASCII
        for bad in ["a b", "o'pus", "x;y", "$(x)", "a\nb", "a\r\nb", "`x`", "a|b", "a&b", "a>b", "a\tb", "a\0b", "mod\u{e9}l", "\"x\""] {
            assert!(!valid_model(bad), "valid_model {bad:?}");
            for is_pi in [false, true] {
                assert!(launch_choice(is_pi, Some(bad), None, None).is_err(), "launch_choice(pi={is_pi}) {bad:?}");
            }
        }
        // a newline at the very end or start is whitespace and is trimmed before the check: the value that is kept
        // has no newline in it (valid_model itself still refuses the raw string)
        assert!(!valid_model("a\n") && !valid_model("\na"));
        assert_eq!(launch_choice(true, Some("a\n"), None, None).unwrap().model.as_deref(), Some("a"));
        assert_eq!(launch_choice(true, Some("\tgpt-5.6-sol \n"), None, None).unwrap().model.as_deref(), Some("gpt-5.6-sol"));
        // empty is "not set", not an error: the UI never sends one, and pty_spawn treats blank as no override
        assert!(!valid_model(""));
        assert_eq!(launch_choice(true, Some(""), None, None).unwrap().model, None);
        assert_eq!(launch_choice(true, Some("  "), None, None).unwrap().model, None);
        // the length limit is 80: 80 passes, 81 is refused (and so is a very long value)
        assert!(valid_model(&"a".repeat(80)));
        assert!(!valid_model(&"a".repeat(81)));
        assert!(launch_choice(true, Some(&"a".repeat(81)), None, None).is_err());
        assert!(launch_choice(true, Some(&"a".repeat(10_000)), None, None).is_err());
        // real ids stay valid: uppercase, provider/id, the :thinking shorthand, dots, dashes, underscores
        for good in ["opus", "claude-fable-5-1", "gpt-5.6-sol", "GPT-4o", "openai-codex/gpt-5.6-sol", "gpt-5.6-sol:high", "a_b.c-d"] {
            assert!(valid_model(good), "valid_model {good:?}");
            assert_eq!(launch_choice(true, Some(good), None, None).unwrap().model.as_deref(), Some(good));
        }
        // a refused model never reaches a command: the error comes before any flag is built
        let e = launch_choice(false, Some("x;y"), None, Some("high")).unwrap_err();
        assert!(e.contains("invalid model"), "{e}");
    }

    #[test]
    fn the_chosen_provider_is_the_one_that_gets_the_sign_in_check() {
        use crate::factory::LaunchChoice;
        let none = LaunchChoice::default();
        // no role, no choice: nothing to check; a Claude launch never checks
        assert_eq!(super::pi_provider_to_check(super::Harness::Pi, None, &none), Ok(None));
        assert_eq!(super::pi_provider_to_check(super::Harness::Claude, Some("worker"), &none), Ok(None));
        assert_eq!(super::pi_provider_to_check(super::Harness::Claude, None, &choice(Some("opus"), None, None)), Ok(None));
        // a chosen model of another provider is checked, with or without a role
        let c = choice(Some("claude-fable-5"), Some("anthropic"), None);
        assert_eq!(super::pi_provider_to_check(super::Harness::Pi, None, &c), Ok(Some("anthropic".to_string())));
        assert_eq!(super::pi_provider_to_check(super::Harness::Pi, Some("validator"), &c), Ok(Some("anthropic".to_string())), "the chosen provider, not the role's");
    }

    #[test]
    fn pill_options_and_parser_show_role_model_and_pi_provider() {
        use crate::factory::*;
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let spec = |r: &str| {
            parse_role_spec(r, &std::fs::read_to_string(src.join(r).join(format!("{r}.md"))).unwrap()).unwrap()
        };
        let w = super::role_options(&spec("worker"), &Default::default());
        assert_eq!(w, vec![("@cubilot_role", "worker".into()), ("@cubilot_model", "sonnet".into()), ("@cubilot_provider", "".into())]);
        let w2 = super::role_options(&spec("worker"), &choice(Some("opus"), None, None));
        assert_eq!(w2[1], ("@cubilot_model", "opus".to_string()), "the override is what runs");
        let v = super::role_options(&spec("validator"), &Default::default());
        assert_eq!((v[1].1.as_str(), v[2].1.as_str()), ("gpt-5.6-sol", "openai-codex"), "a Pi role shows its provider");
        // what tmux prints for three sessions: a Claude role, a Pi role, a plain agent
        let out = "worker-1\tworker\topus\t\nvalidator\tvalidator\tgpt-5.6-sol\topenai-codex\nplain\t\t\t\nbad name!\tworker\tx\t\n";
        let m = super::parse_role_pills(out);
        assert_eq!(m.len(), 2, "{m:?}");
        assert_eq!(m["worker-1"], super::PillInfo { role: "worker".into(), model: "opus".into(), provider: "".into() });
        assert_eq!(m["validator"].provider, "openai-codex");
        assert!(!m.contains_key("plain"));
        assert!(super::parse_role_pills("").is_empty() && super::parse_role_pills("garbage").is_empty());
    }

    #[test]
    fn a_role_allows_the_handoff_interrupt_and_ticket_tools_and_blocks_ack_permission() {
        use std::path::Path;
        let (root, claude) = staged_role("worker", "worker-1");
        let cmd = format_claude_command("worker-1", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&claude)).unwrap();
        let allowed = cmd.split("--allowed-tools '").nth(1).unwrap().split('\'').next().unwrap();
        let allowed: Vec<&str> = allowed.split(',').collect();
        for t in [
            "post", "post_file", "send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff",
            "send_interrupt", "ack_interrupt", "create_ticket", "claim_ticket", "transition_ticket",
            "assign_ticket", "attach_ticket_file", "list_tickets",
        ] {
            assert!(allowed.contains(&format!("mcp__chatbridge__{t}").as_str()), "{t} allowed: {allowed:?}");
        }
        assert!(!allowed.contains(&"mcp__chatbridge__ack_permission"), "not allowed: {allowed:?}");
        let disallowed = cmd.split("--disallowed-tools '").nth(1).unwrap().split('\'').next().unwrap();
        assert!(disallowed.split(',').any(|t| t == "mcp__chatbridge__ack_permission"), "blocked: {disallowed}");
        assert!(disallowed.starts_with("Task,Agent,"), "next to the role's own list: {disallowed}");
        assert_eq!(disallowed.matches("ack_permission").count(), 1);
        // a role whose list already has it does not get a duplicate
        let mut twice = claude;
        twice.disallowed_tools.push("mcp__chatbridge__ack_permission".to_string());
        let cmd2 = format_claude_command("worker-1", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&twice)).unwrap();
        assert_eq!(cmd2.matches("--disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission'").count(), 1, "{cmd2}");
        // a Pi role: ack_permission goes into --exclude-tools, still no --tools
        let (root2, pi) = staged_role("validator", "v");
        let (_, flags) = super::pi_role_flags(&pi).unwrap();
        assert!(flags.contains("--exclude-tools 'edit,write,ack_permission'") && !flags.contains("--tools"), "{flags}");
        let (root3, rev) = staged_role("reviewer", "r1");
        assert!(super::pi_role_flags(&rev).unwrap().1.contains("ack_permission"));
        // no role: the old allow rule, no disallow flag (the pinned test above also checks the full string)
        let none = format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, None).unwrap();
        assert!(none.contains("--allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'"));
        assert!(!none.contains("--disallowed-tools"), "{none}");
        for r in [root, root2, root3] { let _ = std::fs::remove_dir_all(&r); }
    }

    #[test]
    fn the_auth_check_answer_is_read_and_a_failure_names_the_fix() {
        let ok = r#"{"status":"ready","provider":"openai-codex","authType":"oauth"}"#;
        assert_eq!(super::auth_check_result("openai-codex", true, ok), Ok(()));
        // the real shapes of a failure (seen with an empty PI_CODING_AGENT_DIR): exit 1 + not_ready
        let no_cred = r#"{"status":"not_ready","provider":"openai-codex","reason":"credentials_not_configured"}"#;
        assert_eq!(
            super::auth_check_result("openai-codex", false, no_cred).unwrap_err(),
            "Pi is not signed in to openai-codex. Run `pi` and /login openai-codex. Nothing was started."
        );
        let unknown = r#"{"status":"not_ready","provider":"x","reason":"provider_not_found"}"#;
        assert!(super::auth_check_result("x", false, unknown).unwrap_err().contains("does not know the provider x"));
        let other = r#"{"status":"not_ready","provider":"p","reason":"token_expired"}"#;
        let e = super::auth_check_result("p", false, other).unwrap_err();
        assert!(e.contains("token_expired") && e.contains("/login p"), "{e}");
        // a "ready" body with a failing exit code, an empty body, garbage and an odd status are all failures
        assert!(super::auth_check_result("p", false, ok).is_err());
        assert!(super::auth_check_result("p", true, "").unwrap_err().contains("no usable answer"));
        assert!(super::auth_check_result("p", true, "not json").is_err());
        assert!(super::auth_check_result("p", true, r#"{"status":"weird"}"#).is_err());
        // the answer's other fields (a credential, if pi ever sent one) never reach the error text
        let leaky = r#"{"status":"not_ready","reason":"x","apiKey":"SECRET-123"}"#;
        assert!(!super::auth_check_result("p", false, leaky).unwrap_err().contains("SECRET"));
    }

    #[test]
    fn pi_auth_check_runs_the_real_command_with_a_fake_pi() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cubilot-fake-pi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        // exactly `auth check --provider openai-codex --json` (no --no-refresh: pi may refresh an expired token itself,
        // and no --credentials), nothing else
        let ready = fake(
            "pi-ready",
            r#"[ "$*" = "auth check --provider openai-codex --json" ] && echo '{"status":"ready"}' && exit 0; exit 3"#,
        );
        assert_eq!(super::pi_auth_check(&ready, "openai-codex"), Ok(()));
        let out = fake("pi-out", r#"echo '{"status":"not_ready","reason":"credentials_not_configured"}'; exit 1"#);
        assert!(super::pi_auth_check(&out, "openai-codex").unwrap_err().contains("is not signed in to openai-codex"));
        assert!(super::pi_auth_check(&dir.join("missing"), "p").unwrap_err().contains("Could not run"));
        // a check that hangs is killed at the limit, and the message says so
        let hang = fake("pi-hang", "sleep 30");
        let t0 = std::time::Instant::now();
        let e = super::pi_auth_check_with(&hang, "p", std::time::Duration::from_millis(300)).unwrap_err();
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "killed at the limit, not after 30 s");
        assert!(e.contains("took more than") && e.contains("Nothing was started"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_pi_role_has_a_provider_to_check() {
        // no role, or a Claude launch: nothing to check, whatever the harness argument said
        assert_eq!(super::pi_provider_to_check(super::Harness::Pi, None, &Default::default()), Ok(None));
        assert_eq!(super::pi_provider_to_check(super::Harness::Claude, Some("worker"), &Default::default()), Ok(None));
        assert_eq!(super::pi_provider_to_check(super::Harness::Claude, None, &Default::default()), Ok(None));
    }

    #[test]
    fn harness_fallback_reads_the_executable_not_substrings() {
        let claude = "CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/bin/claude' --plugin-dir '/m' --allowed-tools 'x'";
        let pi = "CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/bin/pi' --no-approve -e '/e.js'";
        // Hostile room value containing the claude flag: still pi.
        let pi_evil = "CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='x --plugin-dir y' '/Users/me/My Tools/pi' --no-approve -e '/e.js'";
        // Hostile value containing pi-looking text in a claude command: still claude.
        let claude_evil = "CHATBRIDGE_AGENT='pi' CHATBRIDGE_ROOM='a'\\''b -e c' '/bin/claude' --plugin-dir '/m'";
        // Legacy MCP-spawned claude: no env prefix.
        let legacy = concat!("'/bin/claude' --mcp", "-config '/c.json' --dangerously", "-load-development-channels server:chatbridge");
        assert_eq!(harness_from_command(claude), Harness::Claude);
        assert_eq!(harness_from_command(pi), Harness::Pi);
        assert_eq!(harness_from_command(pi_evil), Harness::Pi);
        assert_eq!(harness_from_command(claude_evil), Harness::Claude);
        assert_eq!(harness_from_command(legacy), Harness::Claude);
        assert_eq!(command_executable(pi_evil).as_deref(), Some("pi"));
        assert_eq!(command_executable("   "), None);
    }

    #[test]
    fn harness_fallback_detects_real_tmux_quoted_pi_command() {
        // Captured from bundled tmux 3.5a: list-panes -F "#{pane_start_command}".
        let tmux_output = "\"CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/tmp/cubilot-r1.Yv1ksV/pi' --no-approve -e '/ext.js'\"\n";
        assert_eq!(harness_from_command(tmux_output), Harness::Pi);
    }

    #[test]
    fn harness_option_is_authoritative_over_command_text() {
        assert_eq!(harness_from_option("pi\n"), Some(Harness::Pi));
        assert_eq!(harness_from_option("claude"), Some(Harness::Claude));
        assert_eq!(harness_from_option(""), None);
        assert_eq!(harness_from_option("gpt"), None);
        // pane_harness consults the option first and only falls back when it yields None;
        // here the command says claude but the option says pi.
        let cmd = "CHATBRIDGE_AGENT='a' '/bin/claude' --plugin-dir '/m'";
        let resolved = harness_from_option("pi").unwrap_or_else(|| harness_from_command(cmd));
        assert_eq!(resolved, Harness::Pi);
        assert_eq!(Harness::Pi.as_str(), "pi");
        assert_eq!(Harness::Claude.as_str(), "claude");
    }

    #[test]
    fn claude_version_parse_and_compare() {
        use std::path::Path;
        let path = Path::new("/tmp/claude");
        assert_eq!(parse_claude_version("2.1.296 (Claude Code)\n"), Some((2, 1, 296)));
        assert_eq!(parse_claude_version("2.1.300-beta.1"), Some((2, 1, 300)));
        assert_eq!(parse_claude_version("2.1.300+abc"), Some((2, 1, 300)));
        assert_eq!(parse_claude_version("Claude Code version:\n2.1.300-beta.1 (Claude Code)\n"), Some((2, 1, 300)));
        assert_eq!(parse_claude_version("garbage"), None);
        assert_eq!(parse_claude_version(""), None);
        assert_eq!(parse_claude_version("2.1 (x)"), None);
        assert!(check_claude_version(path, (2, 1, 296)).is_ok());
        assert!(check_claude_version(path, (2, 1, 400)).is_ok());
        assert!(check_claude_version(path, (2, 2, 0)).is_ok());
        assert!(check_claude_version(path, (3, 0, 0)).is_ok());
        let old = check_claude_version(path, (2, 1, 287)).unwrap_err();
        assert!(old.contains("2.1.287") && old.contains("/tmp/claude"), "{old}");
        assert!(check_claude_version(path, (2, 1, 30)).is_err());
        assert!(check_claude_version(path, (2, 0, 999)).is_err());
    }

    #[test]
    fn claude_version_errors_include_path_and_output() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("cubilot-claude-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let old = fake("old", "echo '2.1.287 (Claude Code)'");
        let new = fake("new", "echo '2.1.296 (Claude Code)'");
        let bad = fake("bad", "echo unrecognized-version-output");
        let nonzero = fake("nonzero", "echo stdout-error; echo stderr-error >&2; exit 7");
        // Prints, then stops itself, so only the timeout can end the probe. The first run of a freshly
        // written script can take a few hundred ms on macOS (the system scans it), which would eat a short
        // timeout before the script prints: run it once with another argument first, outside the timed call.
        let slow = fake("slow", "if [ \"$1\" = --version ]; then echo timeout-output; kill -STOP $$; fi");
        assert!(std::process::Command::new(&slow).arg("--warm-up").status().unwrap().success());

        let old_error = ensure_claude_version(&old).unwrap_err();
        assert!(old_error.contains(&old.display().to_string()) && old_error.contains("2.1.287"), "{old_error}");
        let parse_error = ensure_claude_version(&bad).unwrap_err();
        assert!(parse_error.contains(&bad.display().to_string()) && parse_error.contains("unrecognized-version-output"), "{parse_error}");
        let missing = dir.join("missing");
        let spawn_error = ensure_claude_version(&missing).unwrap_err();
        assert!(spawn_error.contains(&missing.display().to_string()) && spawn_error.contains("start"), "{spawn_error}");
        let exit_error = read_claude_version(&nonzero).unwrap_err();
        assert!(exit_error.contains(&nonzero.display().to_string()) && exit_error.contains("stdout-error") && exit_error.contains("stderr-error"), "{exit_error}");
        let timeout_error = read_claude_version_with_timeout(&slow, Duration::from_millis(500)).unwrap_err();
        assert!(timeout_error.contains(&slow.display().to_string()) && timeout_error.contains("timed out") && timeout_error.contains("timeout-output"), "{timeout_error}");

        assert!(ensure_claude_version(&new).is_ok());
        // Upgrade in place: no result is cached, so the next probe sees the new binary.
        std::fs::copy(&new, &old).unwrap();
        assert!(ensure_claude_version(&old).is_ok());
        // Downgrade in place at the same path: a prior pass must not mask it.
        std::fs::write(&old, "#!/bin/sh\necho '2.1.287 (Claude Code)'\n").unwrap();
        assert!(ensure_claude_version(&old).unwrap_err().contains("2.1.287"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_command_errors_when_staging_fails() {
        let err = claude_command_using(
            "a",
            "r",
            None,
            std::path::Path::new("/bin/claude"),
            None,
            &|| Err("chatbridge mod staging failed: disk full".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("disk full"), "{err}");
    }

    #[test]
    fn claude_resource_flags_only_emits_paths_that_exist() {
        // A blank project has no .claude/ at all — pi must not be handed paths
        // that aren't there, or it emits a diagnostic on every launch.
        let empty = std::env::temp_dir().join("cubilot-res-flags-empty");
        std::fs::create_dir_all(&empty).unwrap();
        let flags = claude_resource_flags(empty.to_str().unwrap());
        assert!(
            !flags.contains(&empty.to_string_lossy().to_string()),
            "emitted a project path that does not exist: {flags}"
        );

        // With .claude/skills present, it is passed as --skill.
        let proj = std::env::temp_dir().join("cubilot-res-flags-proj");
        std::fs::create_dir_all(proj.join(".claude/skills")).unwrap();
        let flags = claude_resource_flags(proj.to_str().unwrap());
        assert!(
            flags.contains("--skill") && flags.contains(".claude/skills"),
            "project skills dir not picked up: {flags}"
        );
        assert!(
            !flags.contains("--prompt-template ") || !flags.contains("cubilot-res-flags-proj/.claude/commands"),
            "emitted a commands dir that does not exist: {flags}"
        );

        let _ = std::fs::remove_dir_all(&empty);
        let _ = std::fs::remove_dir_all(&proj);
    }

    #[test]
    fn harness_parse_accepts_known_values_and_rejects_typos() {
        assert_eq!(Harness::parse(None).unwrap(), Harness::Claude);
        assert_eq!(Harness::parse(Some("")).unwrap(), Harness::Claude);
        assert_eq!(Harness::parse(Some("claude")).unwrap(), Harness::Claude);
        assert_eq!(Harness::parse(Some(" pi ")).unwrap(), Harness::Pi);
        // A UI typo must surface, not silently launch the default harness.
        assert!(Harness::parse(Some("pi.dev")).is_err());
        assert!(Harness::parse(Some("gpt")).is_err());
    }

    #[test]
    fn pi_spawn_cmd_survives_argv_join_like_claude_does() {
        // Same v0.6 regression guard as the claude path: the pi command carries
        // quoted paths (extension, binary) AND env prefixes, so it must reach
        // tmux as ONE argv element or /bin/sh's argv-join splits it.
        let spawn_cmd = "CHATBRIDGE_AGENT='alice' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/pi' --no-approve -e '/Users/me/Some Path/pi-extension.js'";
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, spawn_cmd);
        assert_eq!(argv.last().unwrap(), spawn_cmd);
        let occurrences = argv.iter().filter(|s| s.contains("--no-approve")).count();
        assert_eq!(occurrences, 1, "spawn_cmd got split: {argv:?}");
    }

    #[test]
    fn argv_cwd_with_spaces_preserved_as_single_element() {
        let argv = build_spawn_argv("alice", "/Users/me/Path With Spaces", "en_US.UTF-8", None, "claude");
        // The -c flag's value MUST be one element; -c then its arg.
        let cwd_idx = argv.iter().position(|s| s == "-c").expect("missing -c");
        assert_eq!(argv[cwd_idx + 1], "/Users/me/Path With Spaces");
    }
}

#[cfg(test)]
mod tmux_target_tests {
    use super::*;

    #[test]
    fn exact_targets_have_the_equals_prefix_and_the_pane_colon() {
        assert_eq!(tmux_session("Dev"), "=Dev");
        assert_eq!(tmux_pane("Dev"), "=Dev:");
    }

    // Every `-t` that names an agent's session in pty.rs must go through tmux_session / tmux_pane.
    // `refresh-client -t` takes a client, not a session, and is the one exception.
    #[test]
    fn no_bare_session_target_remains() {
        let src = include_str!("pty.rs");
        let body = src.split("#[cfg(test)]").next().unwrap_or(src);
        // A `-t` is fine when the same line or the next one builds the target with a helper.
        let lines: Vec<&str> = body.lines().collect();
        let bad: Vec<&str> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.contains("\"-t\"") || l.contains("-t \""))
            .filter(|(_, l)| !l.contains("refresh-client"))
            .filter(|(i, l)| {
                let next = lines.get(i + 1).copied().unwrap_or("");
                let ok = |s: &str| s.contains("tmux_session(") || s.contains("tmux_pane(");
                !ok(l) && !ok(next)
            })
            .map(|(_, l)| *l)
            .collect();
        assert!(bad.is_empty(), "bare tmux -t target(s): {bad:#?}");
    }
}
