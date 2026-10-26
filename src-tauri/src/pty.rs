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
    resolve_tmux_bin as real_tmux_bin,
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

// tmux rewrites a '.' in a session name to '_' and then cannot find the session by the agent's name (found with the
// event-name fix), so a terminal agent cannot have a dot. Hub names are unchanged: external agents may use dots.
// The same text is in ui/terminal/factory-room.js (terminalNameError).
const DOT_IN_TERMINAL_NAME: &str = "a dot is not allowed in a terminal agent name: tmux changes it";

fn terminal_name_error(name: &str) -> Option<&'static str> {
    name.contains('.').then_some(DOT_IN_TERMINAL_NAME)
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

#[cfg(test)]
thread_local! {
    // (tmux binary, socket) of an isolated test server; unset: the real ones.
    static TEST_TMUX: std::cell::RefCell<Option<(PathBuf, PathBuf)>> = const { std::cell::RefCell::new(None) };
}

fn resolve_tmux_bin() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some((bin, _)) = TEST_TMUX.with(|t| t.borrow().clone()) {
        return Ok(bin);
    }
    real_tmux_bin()
}

fn tmux_socket_path() -> PathBuf {
    #[cfg(test)]
    if let Some((_, sock)) = TEST_TMUX.with(|t| t.borrow().clone()) {
        return sock;
    }
    app_data_dir().join("tmux.sock")
}

// tmux resolves a bare `-t Dev` by PREFIX: with only "Dev1" alive it matches Dev1. `=name` names the
// session exactly. A target for a session alone (has-session, attach, kill, set-environment) is
// `=name`; one for a pane, window or option (set-option, list-panes, resize-window, capture-pane,
// display-message, pipe-pane) needs the colon, `=name:` (`=name` alone is rejected there).
// Not for `refresh-client -t`, which takes a client, not a session.
// Tauri event names allow only alphanumerics, `-`, `/`, `:` and `_`, but an agent name may hold spaces and dots.
// The name part of an event is the lowercase hex of the agent name's UTF-8 bytes: injective, and in the allowed
// set. The JS side builds the same string (ptyEventName in ui/terminal/pty.js); both sides use ONE helper.
fn pty_event(kind: &str, agent: &str) -> String {
    format!("pty://{kind}/{}", crate::factory::agent_key(agent))
}

fn tmux_session(name: &str) -> String {
    format!("={name}")
}
fn tmux_pane(name: &str) -> String {
    format!("={name}:")
}

/// A tmux client on the Cubilot socket. It gets the UTF-8 locale the sessions get: a tmux client without one prints a
/// tab (or any control character) of a -F / -p format as "_", which left pty_roles with no fields when the app was
/// started from the Dock (launchd sets no LANG). Every direct tmux Command that reads output starts here.
fn tmux_cmd(tmux: impl AsRef<std::ffi::OsStr>) -> Command {
    let lang = resolve_utf8_locale();
    let mut c = Command::new(tmux);
    c.arg("-S").arg(tmux_socket_path()).env("LANG", &lang).env("LC_ALL", &lang);
    c
}

fn tmux_run(args: &[&str]) -> Result<String, String> {
    let tmux = resolve_tmux_bin()?;
    let out = tmux_cmd(&tmux)
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
    tmux_cmd(tmux)
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
    // A new session: drop any link and .applied of an earlier agent of this name. Re-attach never gets here.
    crate::factory::clear_agent_records(&crate::factory::factory_dir(), agent)?;
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
                Some(r) => Some(crate::factory::resolve_role_launch(agent, r, std::path::Path::new(cwd), "pi", choice)?),
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
    pub role: String,     // empty: a launch without a role
    pub model: String,
    pub provider: String, // Pi only, else empty
    pub effort: String,   // Claude effort or Pi thinking level; empty when none was set
    pub harness: String,  // "claude" or "pi"; empty for a session this app did not launch
}

// The pill shows what the launch runs, so it follows the LAUNCH harness (task 9.4): on the role's own harness the
// role default applies unless the choice changes it; on the other harness only the choice counts (the role's model
// and provider are not used there). A Claude launch has no provider.
fn role_options(spec: &crate::factory::RoleSpec, harness: Harness, choice: &crate::factory::LaunchChoice) -> Vec<(&'static str, String)> {
    let is_pi = harness == Harness::Pi;
    let own = (spec.harness == "pi") == is_pi;
    // "default" is written only here, when the launch carries no model or effort flag: the pill card shows what was recorded.
    let model = choice.model.clone().or_else(|| spec.model.clone().filter(|_| own)).unwrap_or_else(|| DEFAULT_RECORD.to_string());
    let provider = if is_pi { choice.provider.clone().or_else(|| spec.provider.clone().filter(|_| own)).unwrap_or_default() } else { String::new() };
    // Claude roles have no default effort; a Pi role's thinking level is its effort on its own harness.
    let effort = choice.effort.clone().or_else(|| spec.thinking.clone().filter(|_| own && is_pi)).unwrap_or_else(|| DEFAULT_RECORD.to_string());
    vec![("@cubilot_role", spec.name.clone()), ("@cubilot_model", model), ("@cubilot_provider", provider), ("@cubilot_effort", effort)]
}

const DEFAULT_RECORD: &str = "default";

// A launch without a role records what its flags carry: the chosen model, provider (Pi) and effort.
fn plain_options(harness: Harness, choice: &crate::factory::LaunchChoice) -> Vec<(&'static str, String)> {
    let provider = if harness == Harness::Pi { choice.provider.clone().unwrap_or_default() } else { String::new() };
    vec![
        ("@cubilot_model", choice.model.clone().unwrap_or_else(|| DEFAULT_RECORD.to_string())),
        ("@cubilot_provider", provider),
        ("@cubilot_effort", choice.effort.clone().unwrap_or_else(|| DEFAULT_RECORD.to_string())),
    ]
}

const PILL_FORMAT: &str = "#{session_name}\t#{@cubilot_role}\t#{@cubilot_model}\t#{@cubilot_provider}\t#{@cubilot_effort}\t#{@cubilot_harness}";

// A session is listed when it has a role or a harness record, so a launch without a role has its details too.
// Sessions with neither (not launched by this app) are left out: the card shows "-" for them.
fn parse_role_pills(out: &str) -> std::collections::HashMap<String, PillInfo> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        let mut f = line.split('\t');
        let (Some(name), Some(role), Some(model), Some(provider)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        let (effort, harness) = (f.next().unwrap_or(""), f.next().unwrap_or(""));
        if (role.is_empty() && harness.is_empty()) || !valid_agent_name(name) {
            continue;
        }
        map.insert(
            name.to_string(),
            PillInfo { role: role.to_string(), model: model.to_string(), provider: provider.to_string(), effort: effort.to_string(), harness: harness.to_string() },
        );
    }
    map
}

// The role and the start command of a running agent's pane, for the skills commands. None: no session or no role.
pub(crate) fn agent_role_and_command(agent: &str) -> (Option<String>, Option<String>) {
    if !valid_agent_name(agent) {
        return (None, None);
    }
    let role = pty_roles().get(agent).map(|p| p.role.clone()).filter(|r| !r.is_empty());
    let command = tmux_run(&["list-panes", "-t", &tmux_pane(agent), "-F", "#{pane_start_command}"]).ok();
    (role, command)
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
    // `--no-extensions` (task: Pi role isolation): without it Pi also loads the user's pi packages (their skills and
    // extension tools such as filler). It also drops Pi's built-in MCP, so the two builtins are loaded again by name,
    // for parity with Claude roles (user MCP servers through --mcp-config). Probe 2 (Pi 1.3.0, live): with both
    // builtins `/mcp` shows serena connected and a tool_search + mcp__serena__ call reaches the server; with
    // builtin:mcp alone the tools are connected but not callable. Skills stay the role's own plus asd-ste100, and no
    // filler tool. Explicit `-e` paths still load, so pi_command's chatbridge extension follows these flags.
    let mut f = format!(
        "--no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt '{}' ",
        psq(&r.prompt_file)
    );
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
        Some(r) => Some(crate::factory::resolve_role_launch(agent, r, std::path::Path::new(cwd), "claude", choice)?),
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
        // The launch harness comes from the modal and resolve_role_launch builds the role for it, so this only guards a wrong call.
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
                        &pty_event("output", &name_clone),
                        OutputPayload {
                            agent: name_clone.clone(),
                            b64,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&pty_event("exit", &name_clone), &name_clone);
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
    stage_id: Option<&str>,
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
    // A hub-launched session: the bridge reports the end of each turn for this stage.
    if let Some(id) = stage_id {
        argv.push("-e".to_string());
        argv.push(format!("CUBILOT_STAGE_ID={id}"));
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

/// Puts `PATH='<path>'` in front of a Pi spawn command, the same way pi_command puts CHATBRIDGE_AGENT there: the app's
/// own PATH (launchd's) lacks the tools a Pi shim needs. It is NOT `new-session -e PATH=...`: tmux 3.5a keeps the
/// session value for FOO but starts the pane command with the server's PATH (tests/integration/pty-plumbing.test.ts
/// shows it). A Claude launch, or no resolved PATH, returns the command unchanged.
fn with_pi_path(cmd: String, harness: Harness, path: Option<&str>) -> String {
    let (Harness::Pi, Some(path)) = (harness, path) else { return cmd };
    format!("PATH='{}' {cmd}", path.replace('\'', r"'\''"))
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
    pi_auth_check_in(pi, provider, crate::login_path::login_path())
}

// `path` is the PATH of the pi child (None keeps the inherited one).
pub(crate) fn pi_auth_check_in(pi: &std::path::Path, provider: &str, path: Option<&str>) -> Result<(), String> {
    pi_auth_check_with(pi, provider, std::time::Duration::from_secs(PI_AUTH_CHECK_SECS), path)
}

fn pi_auth_check_with(pi: &std::path::Path, provider: &str, limit: std::time::Duration, path: Option<&str>) -> Result<(), String> {
    use std::io::Read as _;
    let mut cmd = Command::new(pi);
    crate::login_path::apply(&mut cmd, path);
    let mut child = cmd
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
        Some(r) => Ok(role_default_pi_provider(&crate::factory::resolve_role_spec(r)?)),
        None => Ok(None),
    }
}

// The role's provider counts only when the role runs on Pi by default; a Claude role launched on Pi has none.
fn role_default_pi_provider(spec: &crate::factory::RoleSpec) -> Option<String> {
    spec.provider.clone().filter(|_| spec.harness == "pi")
}

const SESSION_NOT_FOUND: &str = "session not found";

// attach_only with no tmux session of that name: refuse, create nothing.
fn attach_only_error(attach_only: bool, session_exists: bool) -> Option<&'static str> {
    (attach_only && !session_exists).then_some(SESSION_NOT_FOUND)
}

// A role was requested and the session already exists: it must run that role. A session with no role does not.
fn role_mismatch_error(agent: &str, requested: Option<&str>, session_role: Option<&str>) -> Option<String> {
    let want = requested?;
    let have = session_role.map(str::trim).filter(|r| !r.is_empty());
    if have == Some(want) {
        return None;
    }
    let running = have.map_or_else(|| "no role".to_string(), |h| format!("role {h}"));
    Some(format!("session {agent} already runs with {running}: close it first"))
}

// Everything pty_spawn decides about a session that may already exist, before anything is created:
// - attach_only and no session: refused;
// - a role was requested and the session runs another one (or none): refused;
// - attach_only and the session is gone by the time it is configured (it can exit after the first checks):
//   refused too, so the caller's "create" branch is never reached.
// Ok(true): the session exists and is configured. Ok(false): none exists and the caller may create it.
// `between` runs after the role check and before the configuration (the test kills the session there).
fn existing_session_state(agent: &str, role: Option<&str>, attach_only: bool, lang: &str, between: impl FnOnce()) -> Result<bool, String> {
    if let Some(e) = attach_only_error(attach_only, session_exists(agent)) {
        return Err(e.to_string());
    }
    // An existing session keeps the role it was launched with: a launch that asks for another one is refused.
    if role.is_some() && session_exists(agent) {
        let have = tmux_run(&["show-options", "-v", "-t", &tmux_pane(agent), "@cubilot_role"]).ok();
        if let Some(e) = role_mismatch_error(agent, role, have.as_deref()) {
            return Err(e);
        }
    }
    between();
    let existed = ensure_session_configured(agent, lang)?;
    if !existed && attach_only {
        return Err(SESSION_NOT_FOUND.to_string());
    }
    Ok(existed)
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
    attach_only: Option<bool>,
    stage_id: Option<String>,
    first_message: Option<String>,
) -> Result<(), String> {
    if let Some(id) = stage_id.as_deref() {
        if !valid_stage_id(id) {
            return Err(format!("invalid stage id: {id}"));
        }
    }
    // An unknown or council role fails here, before any tmux session exists. No role: nothing changes.
    let role = spawn_role(role)?;
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    if let Some(e) = terminal_name_error(&agent) {
        return Err(e.to_string());
    }
    let harness = Harness::parse(harness.as_deref())?;
    // The harness from the modal decides the launch (task 9.4); a role's own harness is only its default. The
    // model x effort grid (task 5.5): only what the human changed arrives here. Checked against the launch harness,
    // so a Claude effort level on a Pi launch (or the reverse) is refused, not guessed.
    let choice = crate::factory::launch_choice(harness == Harness::Pi, model.as_deref(), provider.as_deref(), effort.as_deref())?;
    // A role on the other harness than its own needs a chosen model: refused here, before any tmux session exists.
    if let Some(r) = role.as_deref() {
        crate::factory::check_role_harness(&crate::factory::resolve_role_spec(r)?, if harness == Harness::Pi { "pi" } else { "claude" }, &choice)?;
    }

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

    let lang = resolve_utf8_locale();
    let api_key = resolve_anthropic_api_key();
    let existed = existing_session_state(&agent, role.as_deref(), attach_only.unwrap_or(false), &lang, || {})?;
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
        let spawn_cmd = if harness == Harness::Pi {
            // Blocking on the first call (up to 5 s): off the async runtime. None keeps the inherited PATH.
            let login = tauri::async_runtime::spawn_blocking(crate::login_path::login_path)
                .await
                .map_err(|e| format!("login PATH worker failed: {e}"))?;
            with_pi_path(spawn_cmd, harness, login)
        } else {
            spawn_cmd
        };
        // A hub launch carries the ticket part of the first message: written to a file, read by the command.
        let spawn_cmd = match first_message.as_deref().filter(|m| !m.is_empty()) {
            Some(text) => with_first_message(&spawn_cmd, &write_first_message(&sessions_dir(), &agent, text)?),
            None => spawn_cmd,
        };
        let argv = build_spawn_argv(&agent, &cwd, &lang, api_key.as_deref(), &spawn_cmd, stage_id.as_deref());
        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        tmux_run(&argv_refs)?;
        // Authoritative harness record; pane_harness falls back to the command only without it.
        if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), "@cubilot_harness", harness.as_str()]) {
            eprintln!("[pty] pty_spawn/@cubilot_harness (falls back to command inspection): {e}");
        }
        // The skills mode of a role launch (a record only: skills::mode_from_command reads the real flags).
        if role.is_some() {
            let mode = if spawn_cmd.contains(".view/") { "view" } else { "plain" };
            if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), "@cubilot_skills", mode]) {
                eprintln!("[pty] pty_spawn/@cubilot_skills (record only): {e}");
            }
        }
        // Best effort, like the harness record: a missing pill must not fail a launch that already runs.
        // A role launch records the role's details, a launch without a role records its chosen ones.
        let options = match &role {
            Some(r) => crate::factory::resolve_role_spec(r).ok().map(|spec| role_options(&spec, harness, &choice)),
            None => Some(plain_options(harness, &choice)),
        };
        for (k, v) in options.into_iter().flatten() {
            if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), k, &v]) {
                eprintln!("[pty] pty_spawn/{k} (pill only): {e}");
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

// The hub's stage ids: `s_` and 16 lower-case hex digits (hub/kinds/stage.ts STAGE_ID_RE).
pub fn valid_stage_id(id: &str) -> bool {
    id.len() == 18 && id.starts_with("s_") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Closes one session by its exact name (`=name`), never by prefix and never any other session. `Ok(true)`: it was
/// killed. `Ok(false)`: no such session, so there is nothing to close. The hub's `close` request uses this.
/// Where the first message of a hub-launched session is kept: `<app data>/sessions/<session>/first-message.md`.
fn sessions_dir() -> PathBuf {
    app_data_dir().join("sessions")
}

/// Writes the first message (stage-sessions 4.3) to `<dir>/<session>/first-message.md`, mode 0600, through a temp file
/// and a rename. The launch command reads it back with `$(cat ...)`, so the text is never part of the command line.
fn write_first_message(dir: &std::path::Path, session: &str, text: &str) -> Result<PathBuf, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if !valid_agent_name(session) || session.contains('.') {
        return Err(format!("invalid session name: {session}"));
    }
    let folder = dir.join(session);
    std::fs::create_dir_all(&folder).map_err(|e| format!("create {}: {e}", folder.display()))?;
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("chmod {}: {e}", folder.display()))?;
    let target = folder.join("first-message.md");
    let tmp = folder.join(format!(".first-message.{}.tmp", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("open {}: {e}", tmp.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    f.sync_all().map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename {}: {e}", target.display()))?;
    Ok(target)
}

/// The launch command plus the first message as ONE quoted argument, read by the shell from the file. `--` ends the
/// options first: a variadic option such as `--allowed-tools` would otherwise take the message as one more value.
fn with_first_message(cmd: &str, file: &std::path::Path) -> String {
    format!("{cmd} -- \"$(cat '{}')\"", file.to_string_lossy().replace('\'', r"'\''"))
}

/// What tmux says about one session: `Ok(true)` it exists, `Ok(false)` tmux answered that it does not (no such session,
/// no server, no socket), `Err` tmux could not answer (cannot start, other failure). A failure is not absence.
fn session_state(name: &str) -> Result<bool, String> {
    let tmux = resolve_tmux_bin()?;
    let out = tmux_cmd(tmux)
        .args(["has-session", "-t"])
        .arg(tmux_session(name))
        .output()
        .map_err(|e| format!("tmux spawn: {e}"))?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("can't find session") || err.contains("no server running") || (err.contains("error connecting to") && err.contains("No such file")) {
        return Ok(false);
    }
    Err(format!("tmux has-session failed: {}", err.trim()))
}

/// Closes one session by its exact name (`=name`), never by prefix and never any other session. `Ok(true)`: it was
/// killed. `Ok(false)`: tmux says there is no such session, so there is nothing to close. `Err`: tmux failed, so the
/// session may still live and the hub must keep the name reserved. The hub's `close` request uses this.
pub fn close_session(name: &str) -> Result<bool, String> {
    if !valid_agent_name(name) {
        return Err(format!("invalid session name: {name}"));
    }
    if !session_state(name)? {
        return Ok(false);
    }
    match tmux_run(&["kill-session", "-t", &tmux_session(name)]) {
        Ok(_) => Ok(true),
        // It may have ended between the check and the kill: ask again, and trust only a clear answer.
        Err(e) => match session_state(name) {
            Ok(false) => Ok(false),
            _ => Err(e),
        },
    }
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

// Live sessions and the start command of every live pane, for the factory cleanup. No tmux server means nothing is
// live, and that is known only when the socket file does not exist. Any other failure (a stale or non-socket file,
// a refused connection) is an error, so the cleanup deletes nothing.
pub(crate) fn live_tmux_state() -> Result<(Vec<String>, String), String> {
    let ask = |args: &[&str]| match tmux_run(args) {
        Err(_) if !tmux_socket_path().exists() => Ok(String::new()),
        other => other,
    };
    let sessions = ask(&["list-sessions", "-F", "#S"])?.lines().map(|l| l.trim().to_string()).collect();
    Ok((sessions, ask(&["list-panes", "-a", "-F", "#{pane_start_command}"])?))
}

#[tauri::command]
pub fn pty_list() -> Result<Vec<String>, String> {
    let tmux = resolve_tmux_bin()?;
    let out = tmux_cmd(tmux)
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
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude --resume", None);
        assert_eq!(&argv[0..4], &["new-session", "-d", "-s", "alice"]);
    }

    #[test]
    fn argv_includes_terminal_env_vars() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude", None);
        let joined = argv.join(" ");
        assert!(joined.contains("TERM=xterm-256color"), "missing TERM env: {joined}");
        assert!(joined.contains("COLORTERM=truecolor"), "missing COLORTERM env: {joined}");
        assert!(joined.contains("LANG=en_US.UTF-8"), "missing LANG env: {joined}");
        assert!(joined.contains("LC_ALL=en_US.UTF-8"), "missing LC_ALL env: {joined}");
        assert!(joined.contains("CUBILOT_DATA_DIR="), "missing CUBILOT_DATA_DIR env: {joined}");
    }

    #[test]
    fn pi_path_is_an_env_prefix_on_the_command_for_pi_only() {
        let cmd = "CHATBRIDGE_AGENT='a' 'pi' --no-approve".to_string();
        let got = super::with_pi_path(cmd.clone(), Harness::Pi, Some("/opt/a:/usr/bin"));
        assert_eq!(got, "PATH='/opt/a:/usr/bin' CHATBRIDGE_AGENT='a' 'pi' --no-approve");
        assert_eq!(super::with_pi_path(cmd.clone(), Harness::Pi, Some("/o'x")), "PATH='/o'\\''x' CHATBRIDGE_AGENT='a' 'pi' --no-approve");
        // the Claude launch and a Pi launch with no resolved PATH do not change, and the argv still has no PATH pair
        assert_eq!(super::with_pi_path(cmd.clone(), Harness::Claude, Some("/opt/a")), cmd);
        assert_eq!(super::with_pi_path(cmd.clone(), Harness::Pi, None), cmd);
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, &got, None);
        assert!(!argv[..argv.len() - 1].iter().any(|a| a.starts_with("PATH=")), "no -e PATH pair: {argv:?}");
        assert_eq!(argv.last(), Some(&got), "the command stays one last argv element");
    }

    #[test]
    fn argv_includes_anthropic_api_key_when_provided() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", Some("sk-test-123"), "claude", None);
        let joined = argv.join(" ");
        assert!(joined.contains("ANTHROPIC_API_KEY=sk-test-123"), "missing API key env: {joined}");
    }

    #[test]
    fn argv_omits_anthropic_api_key_when_none() {
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, "claude", None);
        let joined = argv.join(" ");
        assert!(!joined.contains("ANTHROPIC_API_KEY"), "should omit API key env when None: {joined}");
    }

    #[test]
    fn argv_includes_xy_dimensions_and_cwd() {
        let argv = build_spawn_argv("alice", "/some/cwd", "en_US.UTF-8", None, "claude", None);
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
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, spawn_cmd, None);
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
        let argv = build_spawn_argv("Dev 1", "/tmp", "en_US.UTF-8", None, &cmd, None);
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
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, &cmd, None);
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
    // The role on its own harness (what the role file says).
    fn role_launch(spec: &crate::factory::RoleSpec, version_dir: &std::path::Path, settings: Option<std::path::PathBuf>) -> crate::factory::RoleLaunch {
        crate::factory::role_launch_on(spec, &spec.harness, version_dir, settings)
    }

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
        let argv = build_spawn_argv("worker-1", "/tmp", "en_US.UTF-8", None, &cmd, None);
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

    // 6.1, brief test 7: a session the hub starts is a role launch (launches.rs passes the role to pty_spawn), so its
    // command carries the role's blocks: no sub-agents (Task, Agent) and no ack_permission, with the first message
    // appended after them.
    #[test]
    fn a_hub_started_session_command_blocks_task_agent_and_ack_permission_for_every_stage_role() {
        use std::path::Path;
        for role in ["worker", "tester", "validator", "writer", "editor", "reviewer"] {
            let (root, launch) = staged_role(role, &format!("{role}-1"));
            if launch.harness != "claude" {
                let _ = std::fs::remove_dir_all(&root);
                continue; // the Pi side of a role is checked by its own tests
            }
            let base = format_claude_command(&format!("{role}-1"), "r", None, Path::new("/c"), Path::new("/m"), None, Some(&launch)).unwrap();
            let cmd = super::with_first_message(&base, &super::write_first_message(&root, &format!("{role}-1"), "TICKET").unwrap());
            let blocked = cmd.split("--disallowed-tools '").nth(1).unwrap().split('\'').next().unwrap();
            let list: Vec<&str> = blocked.split(',').collect();
            assert!(list.contains(&"Task") && list.contains(&"Agent"), "{role}: sub-agents blocked: {blocked}");
            assert!(list.contains(&"mcp__chatbridge__ack_permission"), "{role}: {blocked}");
            // the blocks come before the `--` that starts the message
            assert!(cmd.find("--disallowed-tools").unwrap() < cmd.find(" -- \"$(cat").unwrap(), "{role}: {cmd}");
            let _ = std::fs::remove_dir_all(&root);
        }
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
        assert!(
            f.starts_with("CHATBRIDGE_ROLE='validator' --no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt "),
            "{f}"
        );
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
        assert!(cmd.contains("--no-approve --no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt "), "test 11: {cmd}");
        // the chatbridge extension is the LAST -e, after the two builtins
        assert!(cmd.find("-e builtin:tool-search").unwrap() < cmd.find(" -e '").unwrap(), "{cmd}");
        assert_eq!(cmd.matches(" -e ").count(), 3, "two builtins + the chatbridge extension: {cmd}");
        assert!(cmd.find("/validator/skills'").unwrap() < cmd.find("/shared/skills'").unwrap(), "{cmd}");
        assert!(cmd.contains(" -e '"), "extension kept: {cmd}");
        assert!(!cmd.contains("--tools"), "{cmd}");
        let none = super::pi_command("v", "r", &cwd, None, None).unwrap();
        assert_eq!(none, plain);
        assert!(!none.contains("CHATBRIDGE_ROLE") && !none.contains("--no-skills") && !none.contains("--no-extensions") && !none.contains("builtin:"), "{none}");
        assert_eq!(none.matches(" -e ").count(), 1, "a no-role Pi command only has the chatbridge extension: {none}");
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

    // Hot reload (8.3a): a launch built on the agent link names it, never a v-<hash> folder, on both harnesses.
    #[test]
    fn role_commands_name_the_agent_link_not_a_version_folder() {
        use crate::factory::*;
        use std::path::Path;
        let root = std::env::temp_dir().join(format!("cubilot-active-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let v = version.file_name().unwrap().to_string_lossy().into_owned();
        let active = link_agent(&dest, "my agent", &v).unwrap();
        assert!(active.ends_with("agents/6d79206167656e74"));
        let spec = load_role_spec("worker", &src, &version).unwrap();
        let claude = role_launch_on(&spec, "claude", &active, Some(root.join("s.json")));
        let cmd = super::format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&claude)).unwrap();
        let pi = role_launch_on(&spec, "pi", &active, None);
        let (e, f) = super::pi_role_flags(&pi).unwrap();
        let a = active.display().to_string();
        for (name, text) in [("claude", cmd), ("pi", format!("{e}{f}"))] {
            assert!(text.contains(&format!("{a}/worker")) && text.contains(&format!("{a}/shared")), "{name}: {text}");
            assert!(!text.contains("/v-"), "{name} names a version folder: {text}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // C6b: a launch with one skill off names `<key>.view/...` on both harnesses and the view lacks the skill; a launch
    // with no skill off names the agent link as before (the pinned tests above), and the parser reads both back.
    #[test]
    fn a_role_launch_with_one_skill_off_names_the_view_on_both_harnesses_and_an_empty_choice_names_the_link() {
        use crate::factory::*;
        use std::path::Path;
        let root = std::env::temp_dir().join(format!("cubilot-view-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let v = version.file_name().unwrap().to_string_lossy().into_owned();
        let active = link_agent(&dest, "w one", &v).unwrap();
        let key = agent_key("w one");
        let a = active.display().to_string();
        let spec = load_role_spec("worker", &src, &version).unwrap();
        let first = std::fs::read_dir(version.join("worker/skills")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).min().unwrap();
        let build = |off: &[String]| {
            crate::skills::set_off_in(&dest, &version, "w one", "worker", off).unwrap();
            let root_dir = crate::skills::launch_in(&dest, &version, "w one", "worker", &v).unwrap().unwrap_or_else(|| active.clone());
            let claude = role_launch_on(&spec, "claude", &root_dir, Some(root.join("s.json")));
            let c = super::format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, Some(&claude)).unwrap();
            let (e, f) = super::pi_role_flags(&role_launch_on(&spec, "pi", &root_dir, None)).unwrap();
            (root_dir, c, format!("{e}{f}"))
        };
        // empty choice: the link, byte for byte the old flags
        let (r0, c0, p0) = build(&[]);
        assert_eq!(r0, active);
        assert!(c0.contains(&format!("--plugin-dir '{a}/worker' --plugin-dir '{a}/shared'")) && p0.contains(&format!("--skill '{a}/worker/skills' --skill '{a}/shared/skills'")), "{c0} {p0}");
        assert_eq!(crate::skills::mode_from_command(&c0, &dest, "w one"), "plain");
        assert_eq!(crate::skills::mode_from_command(&p0, &dest, "w one"), "plain");
        // one skill off: both harnesses name the view, and the view lacks the skill
        let (r1, c1, p1) = build(&[format!("worker/{first}")]);
        let view = format!("{}/agents/{key}.view", dest.display());
        assert_eq!(r1.display().to_string(), view);
        assert!(c1.contains(&format!("--plugin-dir '{view}/worker' --plugin-dir '{view}/shared'")), "{c1}");
        assert!(c1.contains(&format!("--append-system-prompt-file '{view}/worker/role.md'")), "{c1}");
        assert!(p1.contains(&format!("--skill '{view}/worker/skills' --skill '{view}/shared/skills'")), "{p1}");
        assert!(!r1.join("worker/skills").join(&first).exists() && version.join("worker/skills").join(&first).is_dir());
        assert_eq!(crate::skills::mode_from_command(&c1, &dest, "w one"), "view");
        assert_eq!(crate::skills::mode_from_command(&p1, &dest, "w one"), "view");
        let _ = std::fs::remove_dir_all(&root);
    }

    // Brief test 15 (task 9.4): the modal's harness decides; the role's model, provider and thinking apply only on
    // the role's own harness; the tool limits for the launch harness come from the role file; ack_permission is
    // blocked on both; a launch on the other harness without a chosen model is refused.
    #[test]
    fn launch_choice_the_modal_harness_decides_and_the_role_defaults_apply_only_on_its_own() {
        use crate::factory::*;
        use std::path::Path;
        let root = std::env::temp_dir().join(format!("cubilot-launch-choice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let settings = Some(root.join("s.json"));
        let on = |role: &str, harness: &str, ch: &LaunchChoice| -> Result<RoleLaunch, String> {
            let spec = load_role_spec(role, &src, &version)?;
            check_role_harness(&spec, harness, ch)?;
            Ok(with_choice(role_launch_on(&spec, harness, &version, settings.clone()), ch))
        };
        let claude_cmd = |l: &RoleLaunch| super::format_claude_command("a", "r", None, Path::new("/c"), Path::new("/m"), None, Some(l)).unwrap();
        let pi_flags = |l: &RoleLaunch| { let (e, f) = super::pi_role_flags(l).unwrap(); format!("{e}{f}") };
        let none = LaunchChoice::default();

        // each role on its own harness with no choice: the role file's defaults
        let w = claude_cmd(&on("worker", "claude", &none).unwrap());
        assert!(w.contains("--model 'sonnet'") && w.contains("--disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission'"), "{w}");
        let o = claude_cmd(&on("orchestrator", "claude", &none).unwrap());
        assert!(o.contains("--model 'opus'") && o.contains("--disallowed-tools 'Edit,Write,NotebookEdit,Task,Agent,mcp__chatbridge__ack_permission'"), "{o}");
        for r in ["validator", "reviewer"] {
            let f = pi_flags(&on(r, "pi", &none).unwrap());
            assert!(f.contains("--provider 'openai-codex'") && f.contains("--model 'gpt-5.6-sol'") && f.contains("--thinking 'high'"), "{r}: {f}");
            assert!(f.contains("--exclude-tools 'edit,write,ack_permission'"), "{r}: {f}");
        }

        // the other harness without a chosen model: an error, nothing is built
        for (r, h) in [("worker", "pi"), ("orchestrator", "pi"), ("validator", "claude"), ("reviewer", "claude")] {
            let e = on(r, h, &none).unwrap_err();
            assert!(e.contains("choose a model") && e.contains("Nothing was started"), "{r} on {h}: {e}");
            assert!(on(r, h, &choice(None, None, Some("high"))).is_err(), "an effort alone is not a model: {r} on {h}");
        }

        // a Claude role on Pi: the human's model and provider, no role default, the role file's Pi limits
        let f = pi_flags(&on("worker", "pi", &choice(Some("gpt-5.6-sol"), Some("openai-codex"), Some("high"))).unwrap());
        assert!(f.contains("--provider 'openai-codex' --model 'gpt-5.6-sol' --thinking 'high'"), "{f}");
        assert!(!f.contains("sonnet"), "{f}");
        assert!(f.contains("--exclude-tools 'ack_permission'"), "worker has no Pi file limits: {f}");
        let f = pi_flags(&on("orchestrator", "pi", &choice(Some("gpt-5.6-terra"), Some("openai-codex"), None)).unwrap());
        assert!(f.contains("--exclude-tools 'edit,write,ack_permission'") && !f.contains("--thinking"), "{f}");

        // a Pi role on Claude: the human's model, no provider or thinking, the role file's Claude limits
        for r in ["validator", "reviewer"] {
            let c = claude_cmd(&on(r, "claude", &choice(Some("opus"), None, Some("max"))).unwrap());
            assert!(c.contains("--model 'opus'") && c.contains("--effort 'max'"), "{r}: {c}");
            assert!(c.contains("--disallowed-tools 'Edit,Write,NotebookEdit,Task,Agent,mcp__chatbridge__ack_permission'"), "{r}: {c}");
            assert!(!c.contains("openai-codex") && !c.contains("--thinking") && !c.contains("gpt-5"), "{r}: {c}");
        }

        // the same role file is read again for the next launch; an unknown role is still an error
        assert_eq!(on("validator", "pi", &none).unwrap().model.as_deref(), Some("gpt-5.6-sol"));
        assert!(on("nope", "claude", &none).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pi_sign_in_check_ignores_the_provider_of_a_claude_role_and_uses_the_chosen_one() {
        use crate::factory::*;
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let spec = |r: &str| parse_role_spec(r, &std::fs::read_to_string(src.join(r).join(format!("{r}.md"))).unwrap()).unwrap();
        // a Claude role on Pi has no default provider; a Pi role keeps its own
        assert_eq!(super::role_default_pi_provider(&spec("worker")), None);
        assert_eq!(super::role_default_pi_provider(&spec("orchestrator")), None);
        assert_eq!(super::role_default_pi_provider(&spec("validator")).as_deref(), Some("openai-codex"));
        // the chosen provider wins and needs no role lookup; a Claude launch checks nothing
        let c = choice(Some("m"), Some("openai-codex"), None);
        assert_eq!(super::pi_provider_to_check(super::Harness::Pi, Some("worker"), &c), Ok(Some("openai-codex".to_string())));
        assert_eq!(super::pi_provider_to_check(super::Harness::Claude, Some("validator"), &LaunchChoice::default()), Ok(None));
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
    fn an_existing_session_attaches_only_for_the_role_it_runs() {
        use crate::pty::role_mismatch_error as e;
        assert_eq!(e("t", Some("worker"), Some("worker\n")), None);
        assert_eq!(e("t", Some("worker"), Some("tester")), Some("session t already runs with role tester: close it first".into()));
        assert_eq!(e("t", Some("worker"), Some("")), Some("session t already runs with no role: close it first".into()));
        assert_eq!(e("t", Some("worker"), None), Some("session t already runs with no role: close it first".into()));
        assert_eq!(e("t", None, Some("tester")), None);
    }

    #[test]
    fn attach_only_refuses_a_missing_session_and_nothing_else() {
        assert_eq!(crate::pty::attach_only_error(true, false), Some("session not found"));
        assert_eq!(crate::pty::attach_only_error(true, true), None);
        assert_eq!(crate::pty::attach_only_error(false, false), None);
        assert_eq!(crate::pty::attach_only_error(false, true), None);
    }

    // The event name an agent's pane listens on (task: names with a space or a dot). The same vectors are asserted
    // against the JS helper in tests/unit/pty-event-name.test.ts: both sides must give the same string.
    #[test]
    fn a_terminal_agent_name_with_a_dot_is_refused_and_a_space_or_dash_is_not() {
        assert_eq!(
            super::terminal_name_error("t a.b"),
            Some("a dot is not allowed in a terminal agent name: tmux changes it")
        );
        assert!(super::terminal_name_error(".x").is_some() && super::terminal_name_error("x.").is_some());
        for ok in ["t a-b", "orchestrator-Test room", "alice", "a_b", "A 1"] {
            assert_eq!(super::terminal_name_error(ok), None, "{ok}");
        }
        // the name stays valid for the hub rules (valid_agent_name still allows dots): only the terminal refuses it
        assert!(super::valid_agent_name("t a.b"));
    }

    #[test]
    fn pty_event_names_are_hex_of_the_agent_name_and_only_use_allowed_characters() {
        assert_eq!(super::pty_event("output", "alice"), "pty://output/616c696365");
        assert_eq!(super::pty_event("exit", "orchestrator-Test room"), "pty://exit/6f7263686573747261746f722d5465737420726f6f6d");
        assert_eq!(super::pty_event("output", "t a.b"), "pty://output/7420612e62");
        assert_eq!(super::pty_event("output", "é"), "pty://output/c3a9");
        let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_');
        for n in ["a b", "a.b", "a  b", "a-b_c", "orchestrator-Test room", "Z.z 9"] {
            let e = super::pty_event("output", n);
            assert!(e.chars().all(allowed), "{n}: {e}");
        }
        // injective: names that differ only by a space, a dot or a case never collide
        let names = ["a b", "a.b", "a_b", "a-b", "A b", "a  b"];
        let set: std::collections::HashSet<_> = names.iter().map(|n| super::pty_event("output", n)).collect();
        assert_eq!(set.len(), names.len());
        assert_ne!(super::pty_event("output", "a"), super::pty_event("exit", "a"));
    }

    #[test]
    fn every_launch_records_model_provider_and_effort() {
        let (cl, pi) = (super::Harness::Claude, super::Harness::Pi);
        let rec = |h, c: &crate::factory::LaunchChoice| super::plain_options(h, c).into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>();
        assert_eq!(rec(cl, &choice(Some("opus"), Some("ignored"), Some("max"))), ["@cubilot_model=opus", "@cubilot_provider=", "@cubilot_effort=max"], "Claude has no provider");
        assert_eq!(rec(pi, &choice(Some("gpt-5.6-sol"), Some("openai-codex"), Some("high"))), ["@cubilot_model=gpt-5.6-sol", "@cubilot_provider=openai-codex", "@cubilot_effort=high"]);
        assert_eq!(rec(cl, &Default::default()), ["@cubilot_model=default", "@cubilot_provider=", "@cubilot_effort=default"], "no flag: the launch records \"default\"");
        // a role: effort is the choice, or on its own Pi harness the role's thinking level
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let spec = crate::factory::parse_role_spec("validator", &std::fs::read_to_string(src.join("validator/validator.md")).unwrap()).unwrap();
        let o = super::role_options(&spec, pi, &Default::default());
        assert_eq!(o[3].1, spec.thinking.clone().unwrap_or_else(|| "default".into()));
        assert_eq!(super::role_options(&spec, pi, &choice(None, None, Some("low")))[3].1, "low", "the choice wins");
        assert_eq!(super::role_options(&spec, cl, &Default::default())[3].1, "default", "a Claude role without an effort flag records \"default\"");
    }

    #[test]
    fn pill_options_and_parser_show_role_model_and_pi_provider() {
        use crate::factory::*;
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let spec = |r: &str| {
            parse_role_spec(r, &std::fs::read_to_string(src.join(r).join(format!("{r}.md"))).unwrap()).unwrap()
        };
        let (cl, pi) = (super::Harness::Claude, super::Harness::Pi);
        let w = super::role_options(&spec("worker"), cl, &Default::default());
        assert_eq!(w, vec![("@cubilot_role", "worker".into()), ("@cubilot_model", "sonnet".into()), ("@cubilot_provider", "".into()), ("@cubilot_effort", "default".into())]);
        let w2 = super::role_options(&spec("worker"), cl, &choice(Some("opus"), None, None));
        assert_eq!(w2[1], ("@cubilot_model", "opus".to_string()), "the override is what runs");
        let v = super::role_options(&spec("validator"), pi, &Default::default());
        assert_eq!((v[1].1.as_str(), v[2].1.as_str()), ("gpt-5.6-sol", "openai-codex"), "a Pi role shows its provider");
        // the other harness (task 9.4): only the choice counts, never the role's default model or provider
        let v_cl = super::role_options(&spec("validator"), cl, &choice(Some("opus"), None, Some("max")));
        assert_eq!((v_cl[1].1.as_str(), v_cl[2].1.as_str()), ("opus", ""), "a Pi role on Claude: chosen model, no provider");
        let o_pi = super::role_options(&spec("orchestrator"), pi, &choice(Some("gpt-5.6-terra"), Some("openai-codex"), None));
        assert_eq!((o_pi[1].1.as_str(), o_pi[2].1.as_str()), ("gpt-5.6-terra", "openai-codex"), "a Claude role on Pi: chosen model and provider");
        let o_pi_m = super::role_options(&spec("orchestrator"), pi, &choice(Some("gpt-5.6-terra"), None, None));
        assert_eq!((o_pi_m[1].1.as_str(), o_pi_m[2].1.as_str()), ("gpt-5.6-terra", ""), "no chosen provider: empty, not the role's");
        // a launch on the other harness always has a chosen model (9.4), so the role default is never shown there
        let o = super::role_options(&spec("orchestrator"), cl, &Default::default());
        assert_eq!(o[1].1, "opus");
        // what tmux prints for three sessions: a Claude role, a Pi role, a plain agent
        let out = "worker-1\tworker\topus\t\thigh\tclaude\nvalidator\tvalidator\tgpt-5.6-sol\topenai-codex\t\tpi\nplain\t\t\t\t\t\nnorole\t\tgpt-5.6-sol\topenai-codex\txhigh\tpi\nbad name!\tworker\tx\t\t\t\n";
        let m = super::parse_role_pills(out);
        assert_eq!(m.len(), 3, "{m:?}");
        assert_eq!(m["worker-1"], super::PillInfo { role: "worker".into(), model: "opus".into(), provider: "".into(), effort: "high".into(), harness: "claude".into() });
        assert_eq!(m["validator"].provider, "openai-codex");
        assert_eq!((m["norole"].role.as_str(), m["norole"].harness.as_str(), m["norole"].effort.as_str()), ("", "pi", "xhigh"), "a launch without a role is listed");
        assert!(!m.contains_key("plain"), "not launched by this app: no record, no details");
        // old sessions (4 columns, no harness record) still parse
        assert_eq!(super::parse_role_pills("old\tworker\topus\t")["old"].harness, "");
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
        assert_eq!(super::pi_auth_check_in(&ready, "openai-codex", None), Ok(()));
        let out = fake("pi-out", r#"echo '{"status":"not_ready","reason":"credentials_not_configured"}'; exit 1"#);
        assert!(super::pi_auth_check_in(&out, "openai-codex", None).unwrap_err().contains("is not signed in to openai-codex"));
        assert!(super::pi_auth_check_in(&dir.join("missing"), "p", None).unwrap_err().contains("Could not run"));
        // a check that hangs is killed at the limit, and the message says so
        let hang = fake("pi-hang", "sleep 30");
        let t0 = std::time::Instant::now();
        let e = super::pi_auth_check_with(&hang, "p", std::time::Duration::from_millis(300), None).unwrap_err();
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "killed at the limit, not after 30 s");
        assert!(e.contains("took more than") && e.contains("Nothing was started"), "{e}");
        // The shim needs a tool that only the resolved PATH has: without it exit 127, with it ready (the Dock case).
        let tools = dir.join("tools");
        std::fs::create_dir_all(&tools).unwrap();
        let tool = tools.join("cubilot-fake-node");
        std::fs::write(&tool, "#!/bin/sh\necho '{\"status\":\"ready\"}'\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shim = fake("pi-shim", "exec cubilot-fake-node");
        let minimal = "/usr/bin:/bin";
        let resolved = format!("{}:{minimal}", tools.display());
        assert!(super::pi_auth_check_in(&shim, "p", Some(minimal)).is_err(), "tool missing: not ready");
        assert_eq!(super::pi_auth_check_in(&shim, "p", Some(&resolved)), Ok(()));
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
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, spawn_cmd, None);
        assert_eq!(argv.last().unwrap(), spawn_cmd);
        let occurrences = argv.iter().filter(|s| s.contains("--no-approve")).count();
        assert_eq!(occurrences, 1, "spawn_cmd got split: {argv:?}");
    }

    #[test]
    fn argv_cwd_with_spaces_preserved_as_single_element() {
        let argv = build_spawn_argv("alice", "/Users/me/Path With Spaces", "en_US.UTF-8", None, "claude", None);
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

// The decisions pty_spawn makes about an existing session, run against a real tmux on an isolated socket (never
// the Cubilot one): TEST_TMUX points tmux_run / session_exists at it for the current test thread.
#[cfg(test)]
mod existing_session_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Isolated {
        bin: PathBuf,
        sock: PathBuf,
    }

    impl Isolated {
        fn new() -> Self {
            let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/tmux");
            let bin = if bundled.exists() { bundled } else { PathBuf::from("tmux") };
            let sock = PathBuf::from(format!("/tmp/cubilot-rs-{}-{}.sock", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            let t = Isolated { bin: bin.clone(), sock: sock.clone() };
            TEST_TMUX.with(|c| *c.borrow_mut() = Some((bin, sock)));
            t
        }
        fn raw(&self, args: &[&str]) -> bool {
            Command::new(&self.bin).arg("-S").arg(&self.sock).args(args).status().map(|s| s.success()).unwrap_or(false)
        }
        // A detached session that stays alive, with the role option a role launch sets.
        fn session(&self, name: &str, role: Option<&str>) {
            assert!(self.raw(&["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 300"]), "new-session");
            if let Some(r) = role {
                assert!(self.raw(&["set-option", "-t", &tmux_pane(name), "@cubilot_role", r]), "set @cubilot_role");
            }
        }
    }

    impl Drop for Isolated {
        fn drop(&mut self) {
            self.raw(&["kill-server"]);
            TEST_TMUX.with(|c| *c.borrow_mut() = None);
            let _ = std::fs::remove_file(&self.sock);
        }
    }

    const LANG: &str = "en_US.UTF-8";

    #[test]
    fn live_tmux_state_reads_sessions_and_fails_unless_there_is_no_socket() {
        let t = Isolated::new();
        // No socket file: no server, nothing live.
        assert_eq!(live_tmux_state(), Ok((vec![], String::new())));
        // A live session and its start command.
        t.session("test agent", None);
        let (sessions, panes) = live_tmux_state().unwrap();
        assert_eq!(sessions, vec!["test agent".to_string()]);
        assert!(panes.contains("sleep 300"), "{panes}");
        // A socket path that is a regular file is a failure, not "no sessions".
        t.raw(&["kill-server"]);
        let _ = std::fs::remove_file(&t.sock);
        std::fs::write(&t.sock, "regular file").unwrap();
        assert!(live_tmux_state().is_err());
    }

    // The child environment of `c` and nothing else: what a tmux client sees when the app has no locale (launchd).
    fn bare_env(c: &Command) -> Command {
        let mut b = Command::new(c.get_program());
        b.env_clear().args(c.get_args());
        for (k, v) in c.get_envs() {
            if let Some(v) = v {
                b.env(k, v);
            }
        }
        b
    }

    fn pill_session(t: &Isolated) {
        t.session("worker-1", Some("worker"));
        for (k, v) in [("@cubilot_model", "opus"), ("@cubilot_provider", "anthropic"), ("@cubilot_effort", "high"), ("@cubilot_harness", "claude")] {
            assert!(t.raw(&["set-option", "-t", &tmux_pane("worker-1"), k, v]), "set {k}");
        }
    }

    // C6b: the mode of an agent is proven from the start command tmux prints for the pane. tmux prints a one-argument
    // command as ONE double-quoted word; a parser tested on the raw spawn text missed it (live check a, install 23).
    // This spawns through build_spawn_argv on an isolated tmux, reads the command back through agent_role_and_command
    // (the production reader) and checks the mode for both harnesses.
    #[test]
    fn the_mode_is_read_back_from_a_real_pane_for_both_harnesses() {
        use crate::factory::*;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        let t = Isolated::new();
        let root = std::env::temp_dir().join(format!("cubilot-mode-pane-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("factory");
        let version = dest.join(stage_factory(&src, &dest, &root.join("user")).unwrap());
        let v = version.file_name().unwrap().to_string_lossy().into_owned();
        let stub = root.join("stub.sh");
        std::fs::write(&stub, "#!/bin/sh\nsleep 300\n").unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let first = std::fs::read_dir(version.join("worker/skills")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).min().unwrap();
        let spec = load_role_spec("worker", &src, &version).unwrap();
        let mut seen = vec![];
        for harness in ["claude", "pi"] {
            for (case, off) in [("plain", vec![]), ("view", vec![format!("worker/{first}")])] {
                let agent = format!("mode-{harness}-{case}");
                let active = link_agent(&dest, &agent, &v).unwrap();
                crate::skills::set_off_in(&dest, &version, &agent, "worker", &off).unwrap();
                let launch_root = crate::skills::launch_in(&dest, &version, &agent, "worker", &v).unwrap().unwrap_or(active);
                let cmd = if harness == "claude" {
                    let r = role_launch_on(&spec, "claude", &launch_root, Some(root.join("s.json")));
                    format_claude_command(&agent, "r", None, &stub, Path::new("/m"), None, Some(&r)).unwrap()
                } else {
                    let (e, f) = pi_role_flags(&role_launch_on(&spec, "pi", &launch_root, None)).unwrap();
                    let cmd = format!("CHATBRIDGE_AGENT='{agent}' CHATBRIDGE_ROOM='r' {e}'{}' --no-approve {f}-e '/x.js'", stub.display());
                    with_pi_path(cmd, Harness::Pi, Some("/usr/bin:/bin"))
                };
                let argv = build_spawn_argv(&agent, "/tmp", LANG, None, &cmd, None);
                assert!(t.raw(&argv.iter().map(String::as_str).collect::<Vec<_>>()), "{harness} {case}: new-session");
                let read = agent_role_and_command(&agent).1.expect("the pane start command");
                let read = read.trim().to_string();
                assert!(read.starts_with('"') && read.ends_with('"'), "{harness} {case}: tmux form changed: {read}");
                assert_eq!(crate::skills::mode_from_command(&read, &dest, &agent), case, "{harness}: {read}");
                assert_eq!(crate::skills::mode_from_command(&read, &dest, "someone-else"), "legacy", "{harness} {case}: the path of another agent");
                seen.push(read);
            }
        }
        assert_eq!(seen.len(), 4);
        // Misleading text in a real pane stays legacy: the agent's own view path inside one quoted argument, and as the
        // value of another flag.
        let agent = "mode-misleading";
        let active = link_agent(&dest, agent, &v).unwrap();
        let view = active.display().to_string() + ".view";
        for (i, cmd) in [
            format!("'{}' 'a --skill {view}/worker/skills'", stub.display()),
            format!("'{}' --append-system-prompt-file '{view}/worker/role.md' --model x", stub.display()),
        ]
        .iter()
        .enumerate()
        {
            let name = format!("{agent}-{i}");
            let argv = build_spawn_argv(&name, "/tmp", LANG, None, cmd, None);
            assert!(t.raw(&argv.iter().map(String::as_str).collect::<Vec<_>>()), "new-session");
            let read = agent_role_and_command(&name).1.expect("the pane start command");
            assert_eq!(crate::skills::mode_from_command(&read, &dest, agent), "legacy", "{read}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tmux_client_without_a_locale_prints_a_tab_as_an_underscore() {
        // The cause of the empty agent rows (documents it): no LANG / LC_ALL, no tab in the -F output.
        let t = Isolated::new();
        pill_session(&t);
        let out = Command::new(&t.bin).env_clear().arg("-S").arg(&t.sock).args(["list-sessions", "-F", PILL_FORMAT]).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let version = String::from_utf8_lossy(&Command::new(&t.bin).arg("-V").output().unwrap().stdout).trim().to_string();
        assert!(text.starts_with("worker-1_worker_"), "{version}: {text:?}");
        assert!(!text.contains('\t'), "{version}");
        assert!(parse_role_pills(&text).is_empty(), "{version}: no fields, no pills");
        // The same server, read by the production client (tmux_cmd): the tab bytes are there and the fields parse.
        let mut fixed = tmux_cmd(&t.bin);
        let fixed_out = bare_env(fixed.args(["list-sessions", "-F", PILL_FORMAT])).output().unwrap();
        let fixed_text = String::from_utf8_lossy(&fixed_out.stdout);
        assert!(fixed_text.starts_with("worker-1\tworker\topus\t"), "{version}: {fixed_text:?}");
        assert_eq!(parse_role_pills(&fixed_text)["worker-1"].harness, "claude", "{version}");
    }

    #[test]
    fn tmux_cmd_gives_the_client_the_session_locale_so_the_pill_fields_parse() {
        let t = Isolated::new();
        pill_session(&t);
        let mut c = tmux_cmd(&t.bin);
        c.args(["list-sessions", "-F", PILL_FORMAT]);
        let env: std::collections::HashMap<_, _> = c.get_envs().filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string()))).collect();
        assert_eq!(env.get("LANG"), Some(&resolve_utf8_locale()));
        assert_eq!(env.get("LC_ALL"), Some(&resolve_utf8_locale()));
        // Run it with no other environment at all, as the app started from the Dock does.
        let out = bare_env(&c).output().unwrap();
        let pills = parse_role_pills(&String::from_utf8_lossy(&out.stdout));
        assert_eq!(
            pills["worker-1"],
            PillInfo { role: "worker".into(), model: "opus".into(), provider: "anthropic".into(), effort: "high".into(), harness: "claude".into() }
        );
    }

    #[test]
    fn pty_roles_reads_the_pills_from_the_isolated_server() {
        let t = Isolated::new();
        pill_session(&t);
        assert_eq!(pty_roles()["worker-1"].harness, "claude");
    }

    #[test]
    fn the_same_role_attaches() {
        let t = Isolated::new();
        t.session("a", Some("worker"));
        assert_eq!(existing_session_state("a", Some("worker"), false, LANG, || {}), Ok(true));
        assert_eq!(existing_session_state("a", Some("worker"), true, LANG, || {}), Ok(true));
        assert_eq!(existing_session_state("a", None, true, LANG, || {}), Ok(true));
    }

    #[test]
    fn a_different_role_is_refused_and_the_session_is_left_alone() {
        let t = Isolated::new();
        t.session("a", Some("tester"));
        assert_eq!(
            existing_session_state("a", Some("worker"), false, LANG, || {}),
            Err("session a already runs with role tester: close it first".to_string())
        );
        assert!(session_exists("a"));
    }

    #[test]
    fn a_session_without_a_role_is_refused_for_a_role_launch() {
        let t = Isolated::new();
        t.session("a", None);
        assert_eq!(
            existing_session_state("a", Some("worker"), false, LANG, || {}),
            Err("session a already runs with no role: close it first".to_string())
        );
        assert!(session_exists("a"));
    }

    #[test]
    fn attach_only_without_a_session_creates_nothing() {
        let t = Isolated::new();
        t.session("other", None); // a live server, but no session "a"
        assert_eq!(existing_session_state("a", Some("worker"), true, LANG, || {}), Err("session not found".to_string()));
        assert!(!session_exists("a"));
        assert!(!t.raw(&["has-session", "-t", "=a"]));
    }

    // The session passes the first checks and exits before it is configured: attach_only must not fall into the
    // create branch (existed == false there); a normal launch still may.
    #[test]
    fn a_session_that_exits_between_the_checks_is_not_recreated_under_attach_only() {
        let t = Isolated::new();
        t.session("keep", None);
        t.session("a", Some("worker"));
        let killer = || assert!(Isolated::raw_kill("a"));
        assert_eq!(existing_session_state("a", Some("worker"), true, LANG, killer), Err("session not found".to_string()));
        assert!(!session_exists("a"));

        t.session("b", Some("worker"));
        assert_eq!(existing_session_state("b", Some("worker"), false, LANG, || assert!(Isolated::raw_kill("b"))), Ok(false));
    }

    impl Isolated {
        fn raw_kill(name: &str) -> bool {
            tmux_run(&["kill-session", "-t", &tmux_session(name)]).is_ok()
        }
    }

    // 4.2: a close names one session exactly. It never touches another session, not even one whose name starts the same.
    #[test]
    fn close_kills_only_the_named_session() {
        let t = Isolated::new();
        t.session("worker-1", None);
        t.session("worker-10", None);
        t.session("tester-1", None);
        assert_eq!(close_session("worker-1"), Ok(true));
        assert!(!session_exists("worker-1"));
        assert!(session_exists("worker-10"), "prefix match must not kill worker-10");
        assert!(session_exists("tester-1"));
    }

    #[test]
    fn close_of_a_missing_session_is_absent_and_a_repeat_is_accepted() {
        let t = Isolated::new();
        t.session("keep", None);
        assert_eq!(close_session("gone"), Ok(false));
        t.session("worker-1", None);
        assert_eq!(close_session("worker-1"), Ok(true));
        assert_eq!(close_session("worker-1"), Ok(false));
        assert!(session_exists("keep"));
    }

    // A tmux that cannot answer is a failure, not "no such session": the hub must not free the name.
    #[test]
    fn close_reports_a_tmux_failure_as_an_error_not_as_absent() {
        let _t = Isolated::new();
        // A socket path that is a regular file makes has-session fail with an error that is not "no such session".
        let sock = tmux_socket_path();
        let _ = std::fs::remove_file(&sock);
        std::fs::write(&sock, "regular file").unwrap();
        assert!(close_session("worker-1").is_err());
        // A tmux binary that cannot start.
        TEST_TMUX.with(|c| *c.borrow_mut() = Some((PathBuf::from("/nonexistent/tmux"), sock)));
        assert!(close_session("worker-1").is_err());
    }

    #[test]
    fn close_refuses_an_invalid_name() {
        assert!(close_session("a;b").is_err());
        assert!(close_session("shell").is_err());
    }

    #[test]
    fn stage_ids_and_the_session_env() {
        assert!(valid_stage_id("s_0123456789abcdef"));
        assert!(!valid_stage_id("s_0123456789abcdeg"));
        assert!(!valid_stage_id("s_0123"));
        let argv = build_spawn_argv("worker-1", "/tmp", "en_US.UTF-8", None, "claude", Some("s_0123456789abcdef"));
        assert!(argv.windows(2).any(|w| w[0] == "-e" && w[1] == "CUBILOT_STAGE_ID=s_0123456789abcdef"));
        let plain = build_spawn_argv("worker-1", "/tmp", "en_US.UTF-8", None, "claude", None);
        assert!(!plain.iter().any(|a| a.starts_with("CUBILOT_STAGE_ID")));
    }
}

// 4.3: the first message reaches the session through a file, as one quoted argument.
#[cfg(test)]
mod first_message_tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("cubilot-fm-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // Quotes, a command substitution, backticks and newlines must come through as text, never be run.
    const NASTY: &str = "it's \"quoted\" $(touch /tmp/cubilot-fm-pwned) `touch /tmp/cubilot-fm-pwned2`\nline two \\ end";

    #[test]
    fn the_file_is_private_and_holds_the_text() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        let f = write_first_message(&d, "worker-1", NASTY).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), NASTY);
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(f.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(f, d.join("worker-1").join("first-message.md"));
        // a second write replaces it
        write_first_message(&d, "worker-1", "second").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "second");
        assert!(write_first_message(&d, "..", "x").is_err());
        assert!(write_first_message(&d, "a/b", "x").is_err());
    }

    // The shell expands $(cat file) into ONE argument; the text is not parsed again.
    fn run_through_sh(prompt_bytes: &str) -> Vec<u8> {
        let d = dir();
        let f = write_first_message(&d, "worker-1", prompt_bytes).unwrap();
        let cmd = with_first_message("sh -c 'printf \"%s\" \"$2\"' _", &f);
        let out = Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    #[test]
    fn the_command_passes_the_text_as_one_argument_without_running_it() {
        let _ = std::fs::remove_file("/tmp/cubilot-fm-pwned");
        let _ = std::fs::remove_file("/tmp/cubilot-fm-pwned2");
        assert_eq!(String::from_utf8(run_through_sh(NASTY)).unwrap(), NASTY);
        assert!(!std::path::Path::new("/tmp/cubilot-fm-pwned").exists() && !std::path::Path::new("/tmp/cubilot-fm-pwned2").exists(), "the text was run");
    }

    // The largest ticket part: the hub reads a ticket body of up to 256 KiB; macOS allows 1 MiB for the whole exec.
    #[test]
    fn a_100_kb_and_a_600_kb_message_launch() {
        for n in [100_000usize, 600_000] {
            let text = "x'\"$a\n".repeat(n / 6);
            // $(cat) drops trailing newlines; nothing else changes.
            assert_eq!(run_through_sh(&text), text.trim_end_matches('\n').as_bytes(), "{n} bytes");
        }
    }

    #[test]
    fn a_worker_command_has_the_role_prompt_file_and_the_message_argument_but_no_role_text() {
        let tmp = dir();
        let role_prompt = tmp.join("worker.md");
        std::fs::write(&role_prompt, "ROLE-PROMPT-TEXT-MUST-NOT-APPEAR").unwrap();
        let launch = crate::factory::RoleLaunch {
            name: "worker".into(),
            harness: "claude".into(),
            plugin_dir: tmp.join("plugin"),
            shared_dir: tmp.join("shared"),
            prompt_file: role_prompt.clone(),
            settings: Some(tmp.join("settings.json")),
            disallowed_tools: vec![],
            exclude_tools: vec![],
            model: None,
            effort: None,
            provider: None,
            thinking: None,
        };
        let base = format_claude_command("worker-1", "r", None, std::path::Path::new("/bin/claude"), std::path::Path::new("/mod"), None, Some(&launch)).unwrap();
        let first = with_first_message(&base, &write_first_message(&tmp, "worker-1", "TICKET ONE").unwrap());
        let second = with_first_message(&base.replace("worker-1", "worker-2"), &write_first_message(&tmp, "worker-2", "TICKET TWO").unwrap());
        let flag = format!("--append-system-prompt-file '{}'", role_prompt.display());
        assert!(first.contains(&flag) && second.contains(&flag), "both sessions share the role prompt file");
        assert!(first.contains(" -- \"$(cat '") && first.ends_with("first-message.md')\""));
        assert!(!first.contains("TICKET ONE") && !first.contains("ROLE-PROMPT-TEXT"), "no text in the command line");
        // they differ only in the session name and the message file
        let strip = |c: &str, n: &str| c.replace(n, "SESSION");
        assert_eq!(strip(&first, "worker-1"), strip(&second, "worker-2"));
    }
}
