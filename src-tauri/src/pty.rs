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

// Per-agent MCP configs written by builds that ran the chatbridge as an MCP server
// (`A2A_MODE=channel`). Housekeeping, so it never fails a spawn: every error is logged and the
// entry skipped. `remove` is a parameter so a test can make removal fail.
fn remove_legacy_mcp_configs(dir: &std::path::Path, remove: &dyn Fn(&std::path::Path) -> std::io::Result<()>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            eprintln!("[mcp] legacy cleanup: cannot read {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                eprintln!("[mcp] legacy cleanup: bad entry in {}: {e}", dir.display());
                continue;
            }
        };
        let path = entry.path();
        let is_file = match entry.file_type() {
            Ok(t) => t.is_file(),
            Err(e) => {
                eprintln!("[mcp] legacy cleanup: cannot inspect {}: {e}", path.display());
                continue;
            }
        };
        let name = entry.file_name();
        let is_legacy = name != "global.json"
            && name.to_string_lossy().ends_with(".json")
            && is_file
            && match std::fs::read_to_string(&path) {
                Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .is_some_and(|config| {
                        let Some(servers) = config.get("mcpServers").and_then(|v| v.as_object()) else {
                            return false;
                        };
                        servers.len() == 1
                            && servers
                                .get(RESERVED_MCP_SERVER)
                                .and_then(|server| server.get("env"))
                                .and_then(|env| env.get("A2A_MODE"))
                                .and_then(|mode| mode.as_str())
                                == Some("channel")
                    }),
                Err(e) => {
                    eprintln!("[mcp] legacy cleanup: cannot read {}: {e}", path.display());
                    false
                }
            };
        if is_legacy {
            if let Err(e) = remove(&path) {
                eprintln!("[mcp] could not remove legacy MCP config {}: {e}", path.display());
            }
        }
    }
}

// Global MCP servers for claude agents, as a standalone --mcp-config file. Atomic (tmpfile +
// rename) because concurrent spawns rewrite it. `prompts` is A2AChannel's own slash-picker key,
// not part of the MCP schema, so it is stripped. Empty map: no file, no flag. Only writing
// global.json can fail the call; the legacy cleanup cannot.
fn write_global_mcp_config(
    dir: &std::path::Path,
    servers: serde_json::Map<String, serde_json::Value>,
) -> Result<Option<PathBuf>, String> {
    write_global_mcp_config_with(dir, servers, &|p| std::fs::remove_file(p))
}

fn write_global_mcp_config_with(
    dir: &std::path::Path,
    mut servers: serde_json::Map<String, serde_json::Value>,
    remove: &dyn Fn(&std::path::Path) -> std::io::Result<()>,
) -> Result<Option<PathBuf>, String> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = dir.join("global.json");
    remove_legacy_mcp_configs(dir, remove);
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
) -> Result<String, String> {
    match harness {
        Harness::Claude => claude_command(
            agent,
            room,
            session_mode,
            claude_path.ok_or_else(|| "Claude path is required for a Claude spawn".to_string())?,
        ),
        Harness::Pi => pi_command(agent, room, cwd, session_mode),
    }
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
/// `@a2a_harness`; that is authoritative. Sessions from older builds have no option, so
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
    if let Some(h) = tmux_run(&["show-options", "-v", "-t", &tmux_pane(agent), "@a2a_harness"])
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
    let shared = claude_resource_flags(cwd);
    Ok(format!(
        "CHATBRIDGE_AGENT='{agent_escaped}' CHATBRIDGE_ROOM='{room_escaped}' '{pi_escaped}' {mode_part}--no-approve {shared}-e '{ext_str}'"
    ))
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
) -> Result<String, String> {
    claude_command_using(
        agent,
        room,
        session_mode,
        claude_path,
        &crate::ensure_chatbridge_mod_staged,
    )
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
    stage: &dyn Fn() -> Result<PathBuf, String>,
) -> Result<String, String> {
    let mod_dir = stage()?;
    let mcp_config = write_global_mcp_config(&mcp_configs_dir(), read_global_mcp_servers())?;
    format_claude_command(
        agent, room, session_mode, claude_path, &mod_dir, mcp_config.as_deref(),
    )
}

fn format_claude_command(
    agent: &str,
    room: &str,
    session_mode: Option<&str>,
    claude_path: &std::path::Path,
    mod_dir: &std::path::Path,
    mcp_config: Option<&std::path::Path>,
) -> Result<String, String> {
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
    Ok(format!(
        "CHATBRIDGE_AGENT='{agent_escaped}' CHATBRIDGE_ROOM='{room_escaped}' '{claude_escaped}' {mode_part}--plugin-dir '{mod_escaped}' {mcp_part}--allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'"
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

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    agent: String,
    cwd: String,
    session_mode: Option<String>,
    room: Option<String>,
    harness: Option<String>,
) -> Result<(), String> {
    if !valid_agent_name(&agent) {
        return Err(format!("invalid agent name: {agent}"));
    }
    let harness = Harness::parse(harness.as_deref())?;

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
        )?;
        let argv = build_spawn_argv(&agent, &cwd, &lang, api_key.as_deref(), &spawn_cmd);
        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        tmux_run(&argv_refs)?;
        // Authoritative harness record; pane_harness falls back to the command only without it.
        if let Err(e) = tmux_run(&["set-option", "-t", &tmux_pane(&agent), "@a2a_harness", harness.as_str()]) {
            eprintln!("[pty] pty_spawn/@a2a_harness (falls back to command inspection): {e}");
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

    // .zshrc checks $A2ACHANNEL_SHELL to scope A2AChannel-only theming.
    let a2a_marker_env = "A2ACHANNEL_SHELL=1";

    let existed_shell = ensure_session_configured(name, &lang)?;
    if existed_shell {
        // allow-passthrough lets yazi's DA1/DSR probes reach xterm.js (silences "response timeout").
        let _ = tmux_run(&["set-option", "-t", &tmux_pane(name), "allow-passthrough", "on"]);
        let _ = tmux_run(&["set-environment", "-t", &tmux_session(name), "A2ACHANNEL_SHELL", "1"]);
    } else {
        let args: Vec<&str> = vec![
            "new-session", "-d", "-s", name,
            "-e", "TERM=xterm-256color",
            "-e", "COLORTERM=truecolor",
            "-e", &lang_env,
            "-e", &lc_all_env,
            "-e", a2a_marker_env,
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
    PathBuf::from("/tmp/a2a").join(agent).join("captures")
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

// /tmp/a2a/ path-prefix guard prevents arbitrary file read via JS misuse.
#[tauri::command]
pub fn pty_read_capture(log_path: String, max_bytes: Option<u32>) -> Result<String, String> {
    let cap = max_bytes.map(|n| n as usize).unwrap_or(CAPTURE_READ_MAX_BYTES);
    let path = std::path::Path::new(&log_path);
    if !path.starts_with("/tmp/a2a/") {
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
        let dir = std::env::temp_dir().join(format!("a2a-prune-test-{}-{}", epoch_ms(), n));
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
        let dir = std::env::temp_dir().join(format!("a2a-prune-partial-{}", epoch_ms()));
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
        parse_global_mcp_servers, write_global_mcp_config, write_global_mcp_config_with, Harness,
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
        let spawn_cmd = "CHATBRIDGE_AGENT='alice' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/claude' --plugin-dir '/Users/me/Application Support/A2AChannel/chatbridge-mod' --allowed-tools 'mcp__chatbridge__post'";
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
            Path::new("/Users/me/Library/Application Support/A2AChannel/chatbridge-mod"),
            None,
        ).unwrap();
        assert!(cmd.starts_with("CHATBRIDGE_AGENT='Dev 1' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/claude' --resume --plugin-dir '"), "{cmd}");
        assert!(cmd.contains("--plugin-dir '/Users/me/Library/Application Support/A2AChannel/chatbridge-mod'"), "{cmd}");
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
            Some(Path::new("/Users/me/Application Support/A2AChannel/mcp-configs/global.json")),
        ).unwrap();
        let flag = concat!("--mcp", "-config");
        assert_eq!(cmd.matches(flag).count(), 1, "{cmd}");
        assert!(
            cmd.contains(&format!("--plugin-dir '/m' {flag} '/Users/me/Application Support/A2AChannel/mcp-configs/global.json' --allowed-tools")),
            "{cmd}"
        );
        let argv = build_spawn_argv("alice", "/tmp", "en_US.UTF-8", None, &cmd);
        assert_eq!(argv.last().unwrap(), &cmd);
        assert_eq!(argv.iter().filter(|s| s.contains(flag)).count(), 1, "{argv:?}");
    }

    #[test]
    fn global_mcp_file_is_filtered_private_atomic_and_removes_legacy_configs() {
        use std::os::unix::fs::PermissionsExt;
        let raw = r#"{"_comment":"x","mcpServers":{"chatbridge":{"command":"evil"},"context7":{"command":"c7","prompts":["p"]},"serena":{"command":"s"}}}"#;
        let servers = parse_global_mcp_servers(raw, "test");
        let root = std::env::temp_dir().join(format!("a2a-gmcp-{}", std::process::id()));
        let dir = root.join("mcp-configs");
        let outside = root.join("outside.json");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"mcpServers":{"chatbridge":{"env":{"A2A_MODE":"channel"}}}}"#;
        let other_mode = r#"{"mcpServers":{"chatbridge":{"env":{"A2A_MODE":"hub"}}}}"#;
        let unrelated = r#"{"mcpServers":{"context7":{"command":"c7"}}}"#;
        let mixed = r#"{"mcpServers":{"chatbridge":{"env":{"A2A_MODE":"channel"}},"context7":{"command":"c7"}}}"#;
        std::fs::write(dir.join("alice.json"), legacy).unwrap();
        std::fs::write(dir.join("mixed.json"), mixed).unwrap();
        std::fs::write(dir.join("bob.json"), other_mode).unwrap();
        std::fs::write(dir.join("keep.json"), unrelated).unwrap();
        std::fs::write(dir.join("notes.txt"), "keep").unwrap();
        std::fs::write(&outside, "keep").unwrap();
        let path = write_global_mcp_config(&dir, servers).unwrap().expect("file written");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("chatbridge"), "{text}");
        assert!(!text.contains("_comment"), "{text}");
        assert!(!text.contains("prompts"), "{text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let names: Vec<_> = v["mcpServers"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(names, vec!["context7", "serena"]);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!dir.join("alice.json").exists());
        assert!(dir.join("mixed.json").exists(), "mixed MCP config must be preserved");
        assert!(dir.join("bob.json").exists());
        assert!(dir.join("keep.json").exists());
        assert!(dir.join("notes.txt").exists());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
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
    fn legacy_cleanup_failures_are_logged_and_never_fail_the_write() {
        use std::cell::RefCell;
        let root = std::env::temp_dir().join(format!("a2a-gmcp-fail-{}", std::process::id()));
        let dir = root.join("mcp-configs");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"mcpServers":{"chatbridge":{"env":{"A2A_MODE":"channel"}}}}"#;
        for name in ["alice.json", "bob.json", "carol.json"] {
            std::fs::write(dir.join(name), legacy).unwrap();
        }
        let servers = || parse_global_mcp_servers(r#"{"mcpServers":{"context7":{"command":"c7"}}}"#, "test");

        // One file cannot be removed: the others still go, and global.json is still written.
        let tried = RefCell::new(Vec::<String>::new());
        let flaky = |p: &std::path::Path| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            tried.borrow_mut().push(name.clone());
            if name == "alice.json" {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"))
            } else {
                std::fs::remove_file(p)
            }
        };
        let path = write_global_mcp_config_with(&dir, servers(), &flaky).unwrap().expect("global.json is written");
        assert!(path.exists());
        assert!(dir.join("alice.json").exists(), "the file that could not be removed stays");
        assert!(!dir.join("bob.json").exists() && !dir.join("carol.json").exists());
        assert_eq!(tried.borrow().len(), 3, "every legacy file was tried");

        // Nothing can be removed at all: still Ok, and still writes.
        let never = |_: &std::path::Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"));
        assert!(write_global_mcp_config_with(&dir, servers(), &never).unwrap().is_some());

        // Nothing to write: a failed cleanup is still not an error.
        assert!(write_global_mcp_config_with(&dir, Default::default(), &never).unwrap().is_none());

        // The directory cannot even be listed (it is a file): the cleanup is skipped. Only the
        // write of global.json fails, and it says so.
        let not_a_dir = root.join("file-not-dir");
        std::fs::write(&not_a_dir, "x").unwrap();
        let err = write_global_mcp_config_with(&not_a_dir, servers(), &never).unwrap_err();
        assert!(err.contains("create") && err.contains("file-not-dir"), "{err}");
        assert!(write_global_mcp_config_with(&not_a_dir, Default::default(), &never).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_command_escapes_single_quotes_and_rejects_bad_session_mode() {
        use std::path::Path;
        let cmd = format_claude_command("o'neil", "r'm", None, Path::new("/c"), Path::new("/m"), None).unwrap();
        assert!(cmd.contains(r"CHATBRIDGE_AGENT='o'\''neil'"), "{cmd}");
        assert!(cmd.contains(r"CHATBRIDGE_ROOM='r'\''m'"), "{cmd}");
        assert!(format_claude_command("a", "r", Some("bogus"), Path::new("/c"), Path::new("/m"), None).is_err());
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
        let tmux_output = "\"CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/tmp/a2a-r1.Yv1ksV/pi' --no-approve -e '/ext.js'\"\n";
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
        let dir = std::env::temp_dir().join(format!("a2a-claude-ver-{}", std::process::id()));
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
            &|| Err("chatbridge mod staging failed: disk full".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("disk full"), "{err}");
    }

    #[test]
    fn claude_resource_flags_only_emits_paths_that_exist() {
        // A blank project has no .claude/ at all — pi must not be handed paths
        // that aren't there, or it emits a diagnostic on every launch.
        let empty = std::env::temp_dir().join("a2a-res-flags-empty");
        std::fs::create_dir_all(&empty).unwrap();
        let flags = claude_resource_flags(empty.to_str().unwrap());
        assert!(
            !flags.contains(&empty.to_string_lossy().to_string()),
            "emitted a project path that does not exist: {flags}"
        );

        // With .claude/skills present, it is passed as --skill.
        let proj = std::env::temp_dir().join("a2a-res-flags-proj");
        std::fs::create_dir_all(proj.join(".claude/skills")).unwrap();
        let flags = claude_resource_flags(proj.to_str().unwrap());
        assert!(
            flags.contains("--skill") && flags.contains(".claude/skills"),
            "project skills dir not picked up: {flags}"
        );
        assert!(
            !flags.contains("--prompt-template ") || !flags.contains("a2a-res-flags-proj/.claude/commands"),
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
