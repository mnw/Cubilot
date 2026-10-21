mod factory;
mod models;
mod pty;

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write as _},
    net::TcpListener,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::{
    process::{Command, CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
const TOKEN_BYTES: usize = 32;

struct HubState {
    child: Mutex<Option<CommandChild>>,
    info: Mutex<Option<HubInfo>>,
    human_name: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct HubInfo {
    url: String,
    token: String,
}

#[derive(Deserialize, Serialize, Default, Clone)]
struct FontsConfig {
    // Sans/proportional: body, chat, modals.
    #[serde(default)]
    ui: Option<String>,
    // Monospace: UI labels + terminal panes; user value sits before protected Nerd/Symbol fallback chain.
    #[serde(default)]
    mono: Option<String>,
}

#[derive(Deserialize, Serialize, Default, Clone)]
struct AppConfig {
    #[serde(default)]
    attachments_dir: Option<String>,
    // Legacy key for configs from ≤ v0.4.x; read only when `attachments_dir` is absent.
    #[serde(default)]
    images_dir: Option<String>,
    #[serde(default)]
    human_name: Option<String>,
    #[serde(default)]
    attachment_extensions: Option<Vec<String>>,
    #[serde(default)]
    claude_path: Option<String>,
    #[serde(default)]
    pi_path: Option<String>,
    #[serde(default)]
    anthropic_api_key: Option<String>,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    font_scale: Option<f32>,
    #[serde(default)]
    fonts: Option<FontsConfig>,
    #[serde(default)]
    editor: Option<String>,
    // In-memory chat history ring-buffer cap. Also bounds how many entries get
    // hydrated from a persisted JSONL transcript on hub restart, so it doubles
    // as the per-agent context-replay budget.
    #[serde(default)]
    chat_history_limit: Option<u32>,
    // Phase 3: room-summary adapter selection. Forwarded to the hub sidecar
    // as CUBILOT_SUMMARISER + adapter-specific env vars.
    #[serde(default)]
    summariser: Option<SummariserConfig>,
}

#[derive(Deserialize, Serialize, Default, Clone)]
struct SummariserConfig {
    // One of: "disabled" (default), "claude", "ollama", "llama-cpp".
    #[serde(default)]
    adapter: Option<String>,
    // Override the auto-discovered claude binary path (only used when adapter=claude).
    #[serde(default)]
    claude_bin: Option<String>,
    #[serde(default)]
    claude_timeout_ms: Option<u64>,
    // Claude Code --model flag value: alias ("haiku", "sonnet", "opus") or
    // full name ("claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7").
    // Unset → Claude Code's session default (typically Sonnet).
    #[serde(default)]
    claude_model: Option<String>,
    // Ollama HTTP base URL (default: http://127.0.0.1:11434).
    #[serde(default)]
    ollama_url: Option<String>,
    // Ollama model tag (default: gemma4:e2b).
    #[serde(default)]
    ollama_model: Option<String>,
    #[serde(default)]
    ollama_timeout_ms: Option<u64>,
}

#[derive(Serialize, Clone, Default)]
struct UiFonts {
    ui: String,
    mono: String,
}

#[derive(Serialize, Clone)]
struct UiSettings {
    theme: String,
    font_scale: f32,
    fonts: UiFonts,
}

const VALID_THEMES: &[&str] = &["default", "rose-pine-dawn", "rose-pine-moon"];
const FONT_SCALE_MIN: f32 = 0.85;
const FONT_SCALE_MAX: f32 = 1.25;
const FONT_NAME_MAX: usize = 64;

const RESERVED_NAMES: &[&str] = &["you", "all", "system"];

fn default_attachment_extensions() -> Vec<String> {
    vec!["jpg", "jpeg", "png", "pdf", "md", "txt"]
        .into_iter()
        .map(String::from)
        .collect()
}

fn valid_extension(ext: &str) -> bool {
    let n = ext.chars().count();
    if !(1..=10).contains(&n) {
        return false;
    }
    ext.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn resolve_attachment_extensions() -> Vec<String> {
    let cfg = load_config();
    let raw = cfg
        .attachment_extensions
        .unwrap_or_else(default_attachment_extensions);
    let mut clean: Vec<String> = raw
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| valid_extension(e))
        .collect();
    clean.sort();
    clean.dedup();
    if clean.is_empty() {
        eprintln!(
            "[setup] attachment_extensions is empty after validation; falling back to defaults"
        );
        return default_attachment_extensions();
    }
    clean
}

// Default 1000 entries; clamped to [10, 100_000] so a misconfig can't crash the
// hub or starve agents on reconnect.
const CHAT_HISTORY_LIMIT_DEFAULT: u32 = 1000;
const CHAT_HISTORY_LIMIT_MIN: u32 = 10;
const CHAT_HISTORY_LIMIT_MAX: u32 = 100_000;

fn resolve_chat_history_limit() -> u32 {
    let raw = load_config()
        .chat_history_limit
        .unwrap_or(CHAT_HISTORY_LIMIT_DEFAULT);
    raw.clamp(CHAT_HISTORY_LIMIT_MIN, CHAT_HISTORY_LIMIT_MAX)
}

// Validates the adapter name to one of the four accepted values; falls back
// to "disabled" silently for unknown values so a misconfig doesn't break
// hub start. Empty string also maps to "disabled".
const VALID_SUMMARISER_ADAPTERS: &[&str] = &["disabled", "claude", "ollama", "llama-cpp"];

fn resolve_summariser_config() -> SummariserConfig {
    let cfg = load_config().summariser.unwrap_or_default();
    let mut out = cfg;
    if let Some(a) = out.adapter.as_ref() {
        let trimmed = a.trim().to_ascii_lowercase();
        if !VALID_SUMMARISER_ADAPTERS.iter().any(|v| *v == trimmed.as_str()) {
            eprintln!(
                "[setup] summariser.adapter \"{}\" not recognised; falling back to \"disabled\"",
                a
            );
            out.adapter = Some("disabled".to_string());
        } else {
            out.adapter = Some(trimmed);
        }
    }
    out
}

// Translates the SummariserConfig from config.yml into env vars that the hub
// sidecar's `readSummariserConfigFromEnv()` (hub/core/summariser/index.ts)
// reads at startup. Each field is conditional — unset fields stay unset so
// the hub falls back to its own defaults. Used at both spawn sites
// (initial boot in setup() and reload via reload_settings).
fn apply_summariser_env(mut cmd: Command) -> Command {
    let cfg = resolve_summariser_config();
    if let Some(adapter) = cfg.adapter.as_deref() {
        cmd = cmd.env("CUBILOT_SUMMARISER", adapter);
    }
    if let Some(bin) = cfg.claude_bin.as_deref() {
        if !bin.trim().is_empty() {
            cmd = cmd.env("CUBILOT_SUMMARISER_CLAUDE_BIN", bin.trim());
        }
    }
    if let Some(t) = cfg.claude_timeout_ms {
        cmd = cmd.env("CUBILOT_SUMMARISER_CLAUDE_TIMEOUT_MS", t.to_string());
    }
    if let Some(model) = cfg.claude_model.as_deref() {
        if !model.trim().is_empty() {
            cmd = cmd.env("CUBILOT_SUMMARISER_CLAUDE_MODEL", model.trim());
        }
    }
    if let Some(url) = cfg.ollama_url.as_deref() {
        if !url.trim().is_empty() {
            cmd = cmd.env("CUBILOT_SUMMARISER_OLLAMA_URL", url.trim());
        }
    }
    if let Some(model) = cfg.ollama_model.as_deref() {
        if !model.trim().is_empty() {
            cmd = cmd.env("CUBILOT_SUMMARISER_OLLAMA_MODEL", model.trim());
        }
    }
    if let Some(t) = cfg.ollama_timeout_ms {
        cmd = cmd.env("CUBILOT_SUMMARISER_OLLAMA_TIMEOUT_MS", t.to_string());
    }
    cmd
}

pub(crate) fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Cubilot")
}

fn config_file() -> PathBuf {
    app_data_dir().join("config.yml")
}

fn legacy_config_file() -> PathBuf {
    app_data_dir().join("config.json")
}

fn ledger_file() -> PathBuf {
    app_data_dir().join("ledger.db")
}

fn default_human_name() -> String {
    "human".to_string()
}

// Mirrors hub.ts AGENT_NAME_RE plus reserved-word check.
fn validate_human_name(name: &str) -> Result<(), String> {
    if RESERVED_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(name))
    {
        return Err(format!(
            "human_name '{name}' collides with a reserved word ({}). \
             Choose a different name in config.yml.",
            RESERVED_NAMES.join(", ")
        ));
    }
    let n = name.chars().count();
    if !(1..=64).contains(&n) {
        return Err(format!("human_name '{name}' must be 1..=64 characters"));
    }
    let allowed = |c: char| {
        c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == ' '
    };
    if !name.chars().all(allowed) {
        return Err(format!(
            "human_name '{name}' contains characters outside [A-Za-z0-9 _.-]"
        ));
    }
    let first = name.chars().next().unwrap();
    let last = name.chars().last().unwrap();
    if first == ' ' || last == ' ' {
        return Err(format!(
            "human_name '{name}' must not start or end with a space"
        ));
    }
    Ok(())
}

fn default_attachments_dir() -> PathBuf {
    // Top-level ~/ avoids macOS TCC — ~/Documents etc. block the agent's Read tool.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("cubilot-attachments")
}

fn default_claude_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".claude/local/claude")
}

fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(trimmed)
}

fn default_pi_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/pnpm/bin/pi")
}

pub fn resolve_claude_path() -> PathBuf {
    let cfg = load_config();
    let raw = cfg
        .claude_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match raw {
        Some(s) => expand_tilde(&s),
        None => default_claude_path(),
    }
}

pub fn resolve_pi_path() -> PathBuf {
    let cfg = load_config();
    let raw = cfg
        .pi_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match raw {
        Some(s) => expand_tilde(&s),
        None => default_pi_path(),
    }
}

pub fn resolve_anthropic_api_key() -> Option<String> {
    let cfg = load_config();
    cfg.anthropic_api_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn load_config() -> AppConfig {
    let path = config_file();
    match fs::read_to_string(&path) {
        Ok(s) => match serde_yml::from_str::<AppConfig>(&s) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!(
                    "[setup] config.yml exists but failed to parse ({}), using defaults: {e}",
                    path.display()
                );
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

// Carry legacy config.json values forward into config.yml on first launch after upgrade.
fn load_legacy_json_config() -> Option<AppConfig> {
    let path = legacy_config_file();
    let s = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<AppConfig>(&s) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            eprintln!(
                "[setup] legacy config.json present but failed to parse ({}): {e}",
                path.display()
            );
            None
        }
    }
}

fn resolve_theme() -> String {
    let cfg = load_config();
    let raw = cfg
        .theme
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    if VALID_THEMES.iter().any(|t| *t == raw) {
        raw
    } else {
        eprintln!(
            "[setup] theme '{raw}' not in {VALID_THEMES:?}; falling back to default"
        );
        "default".to_string()
    }
}

fn resolve_font_scale() -> f32 {
    let cfg = load_config();
    let raw = cfg.font_scale.unwrap_or(1.0);
    if !raw.is_finite() {
        return 1.0;
    }
    raw.clamp(FONT_SCALE_MIN, FONT_SCALE_MAX)
}

// Whitelist prevents breaking out of the webview's CSS string composer.
fn sanitize_font_name(raw: Option<String>) -> String {
    let Some(s) = raw else { return String::new() };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() > FONT_NAME_MAX {
        eprintln!("[setup] font name '{trimmed}' exceeds {FONT_NAME_MAX} chars; ignored");
        return String::new();
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if !ok {
        eprintln!(
            "[setup] font name '{trimmed}' contains characters outside [A-Za-z0-9 ._-]; ignored"
        );
        return String::new();
    }
    trimmed.to_string()
}

fn resolve_fonts() -> UiFonts {
    let cfg = load_config();
    let f = cfg.fonts.unwrap_or_default();
    UiFonts {
        ui:   sanitize_font_name(f.ui),
        mono: sanitize_font_name(f.mono),
    }
}

fn resolve_human_name() -> Result<String, String> {
    let cfg = load_config();
    let name = cfg.human_name.clone().unwrap_or_else(default_human_name);
    validate_human_name(&name)?;
    Ok(name)
}

fn resolve_attachments_dir_and_seed(human_name: &str, extensions: &[String]) -> PathBuf {
    let cfg = load_config();
    let pick = |opt: Option<String>| -> Option<String> {
        opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let dir = pick(cfg.attachments_dir.clone())
        .or_else(|| pick(cfg.images_dir.clone()))
        .map(PathBuf::from)
        .unwrap_or_else(default_attachments_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[setup] create attachments dir {} failed: {e}", dir.display());
    }
    let cfg_path = config_file();
    if !cfg_path.exists() {
        // Carry forward legacy config.json values on first launch after upgrade.
        let legacy = load_legacy_json_config().unwrap_or_default();
        let seed_human_name = legacy
            .human_name
            .as_deref()
            .unwrap_or(human_name);
        let seed_attachments_dir = legacy
            .attachments_dir
            .or(legacy.images_dir)
            .unwrap_or_default();
        let seed_extensions: Vec<String> = legacy
            .attachment_extensions
            .unwrap_or_else(|| extensions.to_vec());
        let seed_claude_path = legacy
            .claude_path
            .unwrap_or_else(|| "~/.claude/local/claude".to_string());
        let seed_api_key = legacy.anthropic_api_key.unwrap_or_default();
        let seed_theme = legacy
            .theme
            .filter(|s| VALID_THEMES.iter().any(|t| *t == s.as_str()))
            .unwrap_or_else(|| "default".to_string());
        let seed_font_scale = legacy
            .font_scale
            .filter(|f| f.is_finite())
            .map(|f| f.clamp(FONT_SCALE_MIN, FONT_SCALE_MAX))
            .unwrap_or(1.0);
        let legacy_fonts = legacy.fonts.unwrap_or_default();
        let seed_fonts = UiFonts {
            ui:   sanitize_font_name(legacy_fonts.ui),
            mono: sanitize_font_name(legacy_fonts.mono),
        };
        let seed_editor = legacy
            .editor
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let seed_chat_history_limit = legacy
            .chat_history_limit
            .map(|n| n.clamp(CHAT_HISTORY_LIMIT_MIN, CHAT_HISTORY_LIMIT_MAX))
            .unwrap_or(CHAT_HISTORY_LIMIT_DEFAULT);

        let yaml = render_seed_yaml(
            seed_human_name,
            &seed_attachments_dir,
            &seed_extensions,
            &seed_claude_path,
            &seed_api_key,
            &seed_theme,
            seed_font_scale,
            &seed_fonts,
            &seed_editor,
            seed_chat_history_limit,
        );

        if let Err(e) = fs::create_dir_all(cfg_path.parent().unwrap_or(&PathBuf::from("/tmp"))) {
            eprintln!("[setup] create config dir failed: {e}");
        }
        if let Err(e) = fs::write(&cfg_path, yaml) {
            eprintln!("[setup] seed config.yml at {} failed: {e}", cfg_path.display());
        } else {
            println!("[setup] seeded config.yml at {}", cfg_path.display());
        }
    }
    dir
}

// Hand-rolled YAML to preserve comments; serde_yml::to_string drops them.
#[allow(clippy::too_many_arguments)]
fn render_seed_yaml(
    human_name: &str,
    attachments_dir: &str,
    extensions: &[String],
    claude_path: &str,
    api_key: &str,
    theme: &str,
    font_scale: f32,
    fonts: &UiFonts,
    editor: &str,
    chat_history_limit: u32,
) -> String {
    let attachments_line = if attachments_dir.is_empty() {
        "attachments_dir: null".to_string()
    } else {
        format!("attachments_dir: {}", yaml_string(attachments_dir))
    };
    let mut ext_block = String::from("attachment_extensions:\n");
    for e in extensions {
        ext_block.push_str(&format!("  - {e}\n"));
    }
    let api_line = if api_key.is_empty() {
        "anthropic_api_key: \"\"".to_string()
    } else {
        format!("anthropic_api_key: {}", yaml_string(api_key))
    };

    format!(
        "# Cubilot config. Applied on launch; click Reload to re-read.\n\
         \n\
         # Identity shown in the roster.\n\
         human_name: {human_name}\n\
         \n\
         # Path to the claude binary. ~ expands to your home dir.\n\
         claude_path: {claude_path}\n\
         \n\
         # Path to the pi binary, for agents spawned with the \"pi\" runtime.\n\
         # Default: ~/Library/pnpm/bin/pi\n\
         # pi_path: ~/Library/pnpm/bin/pi\n\
         \n\
         # Optional. Exported to spawned claude sessions if non-empty.\n\
         {api_line}\n\
         \n\
         # Where uploaded files persist. null → ~/cubilot-attachments.\n\
         {attachments_line}\n\
         \n\
         # Allowed upload extensions. Lowercase, no leading dot.\n\
         {ext_block}\
         \n\
         # Theme: default | rose-pine-dawn | rose-pine-moon.\n\
         theme: {theme}\n\
         \n\
         # Multiplier on every UI text size. 1 = default.\n\
         # 0.85 = smaller, 1.25 = larger. Values outside that range\n\
         # are clamped.\n\
         font_scale: {font_scale}\n\
         \n\
         # Override fonts. Name must match a font installed on this Mac\n\
         # (case-sensitive). Each value is PREPENDED to the built-in chain;\n\
         # Claude Code's required fonts (Nerd Font for box-drawing, Apple\n\
         # Symbols, Apple Color Emoji) are always retained as fallbacks and\n\
         # cannot be removed. Allowed chars: A-Z a-z 0-9 space . _ -\n\
         # Empty = use the built-in default.\n\
         #   ui   — chat / modals / proportional UI text\n\
         #   mono — code, labels, terminal panes\n\
         fonts:\n  \
         ui: \"{ui}\"\n  \
         mono: \"{mono}\"\n\
         \n\
         # Editor opened by the agent tab's editor button.\n\
         # Cwd of the agent's tmux pane is appended as the last arg.\n\
         # Examples:\n\
         #   editor: code           # VS Code CLI in PATH\n\
         #   editor: cursor         # Cursor CLI in PATH\n\
         #   editor: subl           # Sublime Text CLI in PATH\n\
         #   editor: open -a Cursor # macOS app bundle launcher\n\
         # Empty disables the button.\n\
         editor: \"{editor}\"\n\
         \n\
         # In-memory chat ring-buffer size. Doubles as the replay budget on hub\n\
         # restart: when a room has persistent transcripts on, this many entries\n\
         # are reloaded from JSONL into memory and replayed to reconnecting\n\
         # agents (token cost in their context window). Default 1000. Clamped\n\
         # to [10, 100000].\n\
         chat_history_limit: {chat_history_limit}\n\
         \n\
         # Phase 3 Room summary. Per-Room opt-in toggle is in the UI; this\n\
         # block selects which inference backend the summariser uses.\n\
         #\n\
         # adapter values:\n\
         #   disabled  — Phase 3 off entirely (default)\n\
         #   claude    — spawn `claude --print` per L1; uses your Pro/Max sub\n\
         #   ollama    — HTTP to a local ollama service (you run `ollama serve`)\n\
         #   llama-cpp — bundled local model (NOT YET IMPLEMENTED, planned default)\n\
         #\n\
         # claude_bin: override the auto-discovered claude binary path\n\
         # ollama_url: defaults to http://127.0.0.1:11434\n\
         # ollama_model: defaults to gemma4:e2b — must already be `ollama pull`ed\n\
         summariser:\n  \
         adapter: disabled\n  \
         # claude_bin: ~/.claude/local/node_modules/.bin/claude\n  \
         # ollama_url: http://127.0.0.1:11434\n  \
         # ollama_model: gemma4:e2b\n",
        ui                 = fonts.ui,
        mono               = fonts.mono,
        editor             = editor,
        chat_history_limit = chat_history_limit,
    )
}

fn yaml_string(v: &str) -> String {
    let needs_quote = v.is_empty()
        || v.starts_with(|c: char| c.is_whitespace() || "!&*?|>%@`".contains(c))
        || v.contains(':')
        || v.contains('#')
        || v.contains('"')
        || v.contains('\'')
        || v.contains('\n');
    if needs_quote {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

fn logs_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Library/Logs/Cubilot"))
        .unwrap_or_else(|| PathBuf::from("/tmp/Cubilot-logs"))
}

pub(crate) fn resolve_tmux_bin() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    // bundle.resources preserves source structure → tmux can land in two locations.
    let candidates = [
        exe_dir.join("../Resources/resources/tmux"),
        exe_dir.join("../Resources/tmux"),
        exe_dir.join("../../resources/tmux"),
    ];
    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(format!(
        "tmux not found near {} (checked {:?})",
        exe_dir.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    ))
}

// Mirrors resolve_tmux_bin: bundle.resources preserves source structure, so the
// extension can land in either layout depending on bundled vs `tauri dev`.
pub(crate) fn resolve_pi_extension() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    let candidates = [
        exe_dir.join("../Resources/resources/pi-extension.js"),
        exe_dir.join("../Resources/pi-extension.js"),
        exe_dir.join("../../resources/pi-extension.js"),
    ];
    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(format!(
        "pi-extension.js not found near {} (checked {:?}) — run ./scripts/build-sidecars.sh",
        exe_dir.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    ))
}

// Mirrors resolve_pi_extension: the bundled register.js, built by build-sidecars.sh.
pub(crate) fn resolve_chatbridge_mod_js() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no exe dir".to_string())?
        .to_path_buf();
    let candidates = [
        exe_dir.join("../Resources/resources/chatbridge-mod.js"),
        exe_dir.join("../Resources/chatbridge-mod.js"),
        exe_dir.join("../../resources/chatbridge-mod.js"),
    ];
    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(format!(
        "chatbridge-mod.js not found near {} (checked {:?}) — run ./scripts/build-sidecars.sh",
        exe_dir.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    ))
}

// Where the Claude Code mod is staged. A mod folder must be a real directory the claude
// process can read (--plugin-dir), not a path inside the signed .app bundle's resources.
pub(crate) fn chatbridge_mod_dir() -> PathBuf {
    app_data_dir().join("chatbridge-mod")
}

const MOD_PLUGIN_JSON: &str = include_str!("../../hub/channel/claude-mod/.claude-plugin/plugin.json");
const MOD_HOOKS_JSON: &str = include_str!("../../hub/channel/claude-mod/hooks/hooks.json");
const MOD_TYPES_DTS: &str = include_str!("../../hub/channel/claude-mod/types/index.d.ts");

// Temp dir of a staging run: `.chatbridge-mod.tmp-<pid>-<n>`; the counter keeps two runs of one process (startup
// staging and a spawn's retry) apart. `.chatbridge-mod.old-<pid>` dirs are only left by older builds, which moved
// the mod aside before installing; they are still swept.
const MOD_TMP_PREFIX: &str = ".chatbridge-mod.tmp-";
const MOD_OLD_PREFIX: &str = ".chatbridge-mod.old-";
static MOD_STAGE_RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// True when a process with this pid exists (kill with signal 0 only checks). EPERM means it exists but is
// not ours, which still counts as running: when unsure, a leftover dir is kept.
fn pid_is_running(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 delivers nothing; it only reports whether the pid can be signalled.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

// R6: remove the temp and backup dirs a staging run left behind when its process died. Only dirs named by
// the mod prefixes whose pid is not running; this process is running, so its own live runs are never touched.
fn sweep_stale_staging(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(MOD_TMP_PREFIX).or_else(|| name.strip_prefix(MOD_OLD_PREFIX)) else {
            continue;
        };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else { continue };
        if pid_is_running(pid) {
            continue;
        }
        if let Err(e) = fs::remove_dir_all(entry.path()) {
            eprintln!("[mod] could not remove stale staging dir {}: {e}", entry.path().display());
        }
    }
}

// R5: put `tmp` at `dest` without ever leaving `dest` missing. With an existing `dest`, renamex_np with
// RENAME_SWAP exchanges the two directories in one step (APFS and HFS+); the old mod is then at `tmp` for the
// caller to delete. With no `dest`, a plain rename is atomic. There is no other way in: where the swap is not
// supported, or another instance keeps winning the race, this FAILS and leaves the existing mod untouched. A
// "move dest aside, then move tmp in" fallback would bring back the moment where `dest` does not exist.
fn swap_dirs(a: &Path, b: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let to_c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e));
    let (a_c, b_c) = (to_c(a)?, to_c(b)?);
    // SAFETY: both pointers are valid NUL-terminated paths for the duration of the call.
    let rc = unsafe { libc::renamex_np(a_c.as_ptr(), b_c.as_ptr(), libc::RENAME_SWAP) };
    if rc == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

fn install_mod_dir(tmp: &Path, dest: &Path) -> Result<(), String> {
    install_mod_dir_with(tmp, dest, &swap_dirs)
}

fn install_mod_dir_with(
    tmp: &Path,
    dest: &Path,
    swap: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    for _ in 0..3 {
        if dest.exists() {
            match swap(tmp, dest) {
                Ok(()) => return Ok(()),
                // `dest` vanished between the check and the swap: a plain rename below.
                Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
                Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EINVAL)) => {
                    return Err(format!(
                        "this volume cannot swap directories atomically ({e}); the existing mod was left as it is"
                    ));
                }
                Err(e) => return Err(format!("swap into place: {e}; the existing mod was left as it is")),
            }
        }
        match fs::rename(tmp, dest) {
            Ok(()) => return Ok(()),
            // Another instance created `dest` between our check and the rename: swap with it next round.
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTEMPTY) | Some(libc::EEXIST)) => continue,
            Err(e) => return Err(format!("install: {e}")),
        }
    }
    Err("another instance kept replacing the mod; gave up after 3 tries and left the existing mod as it is".to_string())
}

// After a swap, `tmp` holds whatever was at the destination: a folder, or a stray regular file.
fn remove_path(p: &Path) {
    let _ = match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(_) => Ok(()),
    };
}

// Build the mod folder in a sibling temp dir, then put it into `dest`, so a spawn never sees a missing or
// half-written folder and a failed stage leaves the old one intact.
fn stage_chatbridge_mod(dest: &Path, register_js: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or_else(|| "mod dest has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    sweep_stale_staging(parent);
    let pid = std::process::id();
    let run = MOD_STAGE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = parent.join(format!("{MOD_TMP_PREFIX}{pid}-{run}"));
    let _ = remove_path(&tmp);

    let build = || -> Result<(), String> {
        fs::create_dir_all(tmp.join(".claude-plugin")).map_err(|e| e.to_string())?;
        fs::create_dir_all(tmp.join("hooks")).map_err(|e| e.to_string())?;
        fs::create_dir_all(tmp.join("types")).map_err(|e| e.to_string())?;
        fs::write(tmp.join("types/index.d.ts"), MOD_TYPES_DTS).map_err(|e| e.to_string())?;
        fs::write(tmp.join(".claude-plugin/plugin.json"), MOD_PLUGIN_JSON).map_err(|e| e.to_string())?;
        fs::write(tmp.join("hooks/hooks.json"), MOD_HOOKS_JSON).map_err(|e| e.to_string())?;
        fs::copy(register_js, tmp.join("hooks/register.js"))
            .map_err(|e| format!("copy {}: {e}", register_js.display()))?;
        Ok(())
    };
    if let Err(e) = build() {
        let _ = remove_path(&tmp);
        return Err(format!("stage chatbridge mod: {e}"));
    }

    if let Err(e) = install_mod_dir(&tmp, dest) {
        let _ = remove_path(&tmp);
        return Err(format!("install chatbridge mod: {e}"));
    }
    // After a swap the previous mod is at `tmp`; after a plain rename `tmp` no longer exists.
    let _ = remove_path(&tmp);
    Ok(())
}

// R7: the files Claude Code needs from a staged mod. A folder that lacks one (deleted or damaged after
// this process staged it) is not a usable mod.
fn mod_dir_is_complete(dir: &Path) -> bool {
    [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js"]
        .iter()
        .all(|f| dir.join(f).is_file())
}

// Set only when THIS process staged the mod successfully. A folder left by an older build
// does not count: spawning against it would run a stale register.js.
static CHATBRIDGE_MOD_STAGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn materialize_chatbridge_mod() -> Result<PathBuf, String> {
    let dest = chatbridge_mod_dir();
    let res = resolve_chatbridge_mod_js().and_then(|js| stage_chatbridge_mod(&dest, &js));
    CHATBRIDGE_MOD_STAGED.store(res.is_ok(), std::sync::atomic::Ordering::SeqCst);
    res.map(|_| dest)
}

// Staged dir for a claude spawn: already staged this process, else retry once, else error.
pub(crate) fn ensure_chatbridge_mod_staged() -> Result<PathBuf, String> {
    ensure_staged(&CHATBRIDGE_MOD_STAGED, chatbridge_mod_dir(), materialize_chatbridge_mod)
}

fn ensure_staged(
    staged: &std::sync::atomic::AtomicBool,
    dir: PathBuf,
    stage: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    // Staged by this process AND still on disk: the flag alone does not see a folder deleted afterwards.
    if staged.load(std::sync::atomic::Ordering::SeqCst) && mod_dir_is_complete(&dir) {
        return Ok(dir);
    }
    stage().map_err(|e| format!("chatbridge mod is not staged and retrying failed: {e}"))
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn mint_token() -> Result<String, String> {
    let mut buf = [0u8; TOKEN_BYTES];
    File::open("/dev/urandom")
        .map_err(|e| format!("open /dev/urandom: {e}"))?
        .read_exact(&mut buf)
        .map_err(|e| format!("read urandom: {e}"))?;
    let mut out = String::with_capacity(TOKEN_BYTES * 2);
    for b in &buf {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(out)
}

fn chmod_0600(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 0600 {}: {e}", path.display()))
}

fn atomic_write(dir: &Path, name: &str, contents: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let target = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    // O_EXCL + mode 0600 below closes the chmod-after-write race; discard any leftover tmp first.
    let _ = fs::remove_file(&tmp);
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("create_new {}: {e}", tmp.display()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &target)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), target.display()))?;
    Ok(())
}

fn write_discovery_file(url: &str) -> Result<(), String> {
    atomic_write(&app_data_dir(), "hub.url", url)
}

fn write_token_file(token: &str) -> Result<(), String> {
    atomic_write(&app_data_dir(), "hub.token", token)
}

fn rotate_log_if_oversized(log_path: &Path) {
    match fs::metadata(log_path) {
        Ok(m) if m.len() > LOG_ROTATE_BYTES => {
            let rotated = log_path.with_extension("log.1");
            if let Err(e) = fs::rename(log_path, &rotated) {
                eprintln!(
                    "[setup] log rotation failed ({} → {}): {e}",
                    log_path.display(),
                    rotated.display()
                );
            } else {
                // Rotated archive may still hold tokens (query-string auth).
                let _ = chmod_0600(&rotated);
            }
        }
        _ => {}
    }
}

async fn stream_to_log(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_path: PathBuf,
) {
    use tokio::fs::OpenOptions;
    let mut f = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[hub-log] open {}: {e}", log_path.display());
            return;
        }
    };
    // Tokens leak via SSE/image query strings; enforce 0600.
    if let Err(e) = chmod_0600(&log_path) {
        eprintln!("[hub-log] {e}");
    }
    while let Some(ev) = rx.recv().await {
        let line = match ev {
            CommandEvent::Stdout(b) => format!("{}\n", String::from_utf8_lossy(&b)),
            CommandEvent::Stderr(b) => format!("[err] {}\n", String::from_utf8_lossy(&b)),
            CommandEvent::Terminated(p) => format!("[terminated] code={:?}\n", p.code),
            CommandEvent::Error(e) => format!("[error] {e}\n"),
            _ => continue,
        };
        let _ = f.write_all(line.as_bytes()).await;
    }
}

#[tauri::command]
fn get_hub_url(state: State<HubState>) -> Result<HubInfo, String> {
    let guard = state.info.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .ok_or_else(|| "hub info not yet initialized".to_string())
}

#[tauri::command]
fn get_human_name(state: State<HubState>) -> Result<String, String> {
    let guard = state.human_name.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .clone()
        .ok_or_else(|| "human name not yet initialized".to_string())
}

#[tauri::command]
fn open_config_file() -> Result<(), String> {
    let path = config_file();
    if !path.exists() {
        return Err(format!("config file not found at {}", path.display()));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(())
}

// Opens the user skill layer folder (task 8.2). Created here when missing so a click before the first staging
// still lands in Finder; the staging creates the per-role skills/ folders below it.
// The roles the spawn modal offers: single-agent roles of the staged version `current` names.
#[tauri::command]
fn list_roles() -> Result<Vec<factory::RoleInfo>, String> {
    factory::list_roles()
}

#[tauri::command]
fn open_skills_folder() -> Result<(), String> {
    let path = app_data_dir().join("factory-user");
    fs::create_dir_all(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(())
}

// chatbridge omitted from template intentionally; it's force-injected per-agent and stripped from user configs.
#[tauri::command]
fn open_global_mcp_config() -> Result<(), String> {
    let path = pty::global_mcp_config_path();
    if !path.exists() {
        let template = serde_json::to_string_pretty(&json!({
            "_comment": "Global MCP servers shared by all Claude agents (pi agents have no MCP support). Standard .mcp.json schema. \
                         Each server may carry an optional non-standard `prompts: [\"name\", ...]` array \
                         which lets the slash picker show /mcp__<server>__<name> as a discoverable command. \
                         The `chatbridge` server is reserved by Cubilot; entries with that name are \
                         silently dropped on save.",
            "mcpServers": {}
        })).map_err(|e| e.to_string())?;
        std::fs::write(&path, template)
            .map_err(|e| format!("create {}: {e}", path.display()))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(())
}

// Returns new {url, token} so the UI can hot-swap without relaunching.
#[tauri::command]
fn reload_settings(
    handle: tauri::AppHandle,
    state: State<HubState>,
) -> Result<HubInfo, String> {
    let human_name = resolve_human_name()?;
    let extensions = resolve_attachment_extensions();
    let attachments_dir = resolve_attachments_dir_and_seed(&human_name, &extensions);
    let ledger_path = ledger_file();
    let chat_history_limit = resolve_chat_history_limit();

    let port = pick_free_port()?;
    let url = format!("http://127.0.0.1:{port}");
    let token = mint_token()?;

    // Kill first so two hub-bin processes never race for the same port.
    {
        let child_opt = state.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = child_opt {
            let _ = child.kill();
        }
    }

    if let Err(e) = write_discovery_file(&url) {
        return Err(format!("write discovery file: {e}"));
    }
    if let Err(e) = write_token_file(&token) {
        return Err(format!("write token file: {e}"));
    }

    let shell = handle.shell();
    let mut cmd = shell
        .sidecar("cubilot-bin")
        .map_err(|e| format!("sidecar builder: {e}"))?
        .env("PORT", port.to_string())
        .env("CUBILOT_MODE", "hub")
        .env("CUBILOT_DATA_DIR", app_data_dir().to_string_lossy().to_string())
        .env("CUBILOT_TOKEN", &token)
        .env("CUBILOT_ATTACHMENTS_DIR", attachments_dir.to_string_lossy().to_string())
        .env("CUBILOT_LEDGER_DB", ledger_path.to_string_lossy().to_string())
        .env("CUBILOT_HUMAN_NAME", &human_name)
        .env("CUBILOT_ALLOWED_EXTENSIONS", extensions.join(","))
        .env("CUBILOT_CHAT_HISTORY_LIMIT", chat_history_limit.to_string());
    cmd = apply_summariser_env(cmd);
    let (rx, child) = cmd.spawn().map_err(|e| format!("spawn cubilot-bin: {e}"))?;

    let new_info = HubInfo {
        url: url.clone(),
        token: token.clone(),
    };
    {
        *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        *state.info.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_info.clone());
        *state.human_name.lock().unwrap_or_else(|e| e.into_inner()) = Some(human_name);
    }

    let log_path = logs_dir().join("hub.log");
    tauri::async_runtime::spawn(async move {
        stream_to_log(rx, log_path).await;
    });

    println!("[settings] hub restarted on port {port}");
    Ok(new_info)
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// tokens.css multiplies every --fs-* by var(--ui-font-scale).
#[tauri::command]
fn get_ui_settings() -> UiSettings {
    UiSettings {
        theme: resolve_theme(),
        font_scale: resolve_font_scale(),
        fonts: resolve_fonts(),
    }
}

// Editor cmd from config.yml; cwd is the agent's live pane path (tracks `cd`), appended as last arg.
#[tauri::command]
fn open_in_editor(agent: String) -> Result<String, String> {
    let cfg = load_config();
    let raw_editor = cfg
        .editor
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "editor not configured — set `editor:` in config.yml".to_string()
        })?;

    let cwd = pty::pane_current_path(&agent)?;
    if !cwd.exists() {
        return Err(format!("cwd does not exist: {}", cwd.display()));
    }

    // Split on whitespace so "open -a Cursor" works as well as bare "code"; first token may use ~.
    let mut parts = raw_editor.split_whitespace();
    let cmd_token = parts
        .next()
        .ok_or_else(|| "editor value is empty after trimming".to_string())?;
    let cmd_path = expand_tilde(cmd_token);
    let leading_args: Vec<&str> = parts.collect();

    let mut command = std::process::Command::new(&cmd_path);
    for a in &leading_args {
        command.arg(a);
    }
    command.arg(&cwd);
    command
        .spawn()
        .map_err(|e| format!("spawn '{cmd_token}' failed: {e}"))?;
    Ok(cwd.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
struct SlashCommandEntry {
    name: String,
    description: String,
}

// Scans cwd + ~/.claude commands/skills + global MCP `prompts: []` annotations. Built-ins not included.
#[tauri::command]
fn slash_discover_for_agent(agent: String) -> Vec<SlashCommandEntry> {
    let mut out: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let cwd = pty::pane_current_path(&agent).ok();
    let home = dirs::home_dir();

    // pi addresses skills as `/skill:<name>` and has no MCP prompts; its prompt
    // templates are the same `~/.claude/commands` files the spawn passes through.
    if matches!(pty::pane_harness(&agent), pty::Harness::Pi) {
        let cwd_str = cwd.as_deref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let mut skills: std::collections::BTreeMap<String, String> = Default::default();
        for root in pty::pi_skill_roots(&cwd_str) {
            scan_skills_dir(&root, &mut skills);
        }
        for (name, desc) in skills {
            out.insert(format!("skill:{name}"), desc);
        }
        for root in [cwd.as_deref(), home.as_deref()].into_iter().flatten() {
            scan_commands_dir(&root.join(".claude/commands"), &mut out);
        }
        return out
            .into_iter()
            .map(|(name, description)| SlashCommandEntry { name, description })
            .collect();
    }

    let roots: Vec<PathBuf> = [cwd.as_deref(), home.as_deref()]
        .into_iter()
        .flatten()
        .map(|p| p.join(".claude"))
        .collect();
    for root in &roots {
        scan_commands_dir(&root.join("commands"), &mut out);
        scan_skills_dir(&root.join("skills"), &mut out);
    }
    let global_servers = pty::read_global_mcp_servers();
    for (server_name, server_cfg) in global_servers.iter() {
        let prompts = server_cfg.get("prompts").and_then(|v| v.as_array());
        let description = server_cfg
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(arr) = prompts {
            for p in arr {
                if let Some(prompt_name) = p.as_str() {
                    let full = format!("mcp__{server_name}__{prompt_name}");
                    out.entry(full).or_insert_with(|| description.clone());
                }
            }
        }
    }
    out.into_iter()
        .map(|(name, description)| SlashCommandEntry { name, description })
        .collect()
}

fn scan_commands_dir(dir: &Path, out: &mut std::collections::BTreeMap<String, String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let desc = read_frontmatter_description(&path).unwrap_or_default();
        out.entry(stem).or_insert(desc);
    }
}

fn scan_skills_dir(dir: &Path, out: &mut std::collections::BTreeMap<String, String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let desc = read_frontmatter_description(&skill_md).unwrap_or_default();
        out.entry(name).or_insert(desc);
    }
}

// Tolerant: handles Claude Code's single-line, optionally-quoted value shape only.
fn read_frontmatter_description(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let v = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !v.is_empty() {
                // ~120 char cap keeps the picker compact.
                let truncated: String = v.chars().take(120).collect();
                return Some(truncated);
            }
        }
    }
    None
}

// Launch line for sessions started outside Cubilot. No hub URL or token: the mod
// reads the discovery files itself.
#[tauri::command]
fn get_mcp_template() -> Result<String, String> {
    // Same guard as a spawn: never hand out a launch line for a stale or missing mod.
    let dir = ensure_chatbridge_mod_staged()?.to_string_lossy().replace('\'', r"'\''");
    Ok(format!(
        "CHATBRIDGE_AGENT='agent' CHATBRIDGE_ROOM='default' claude --plugin-dir '{dir}'"
    ))
}

pub fn run() {
    // Wipe WKWebView disk cache before webview creation; otherwise stale assets persist.
    if let Some(cache_root) = dirs::cache_dir() {
        let base = cache_root.join("com.mnw.cubilot/WebKit");
        let _ = fs::remove_dir_all(base.join("NetworkCache"));
        let _ = fs::remove_dir_all(base.join("CacheStorage"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(HubState {
            child: Mutex::new(None),
            info: Mutex::new(None),
            human_name: Mutex::new(None),
        })
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_hub_url,
            get_app_version,
            get_mcp_template,
            slash_discover_for_agent,
            get_human_name,
            get_ui_settings,
            open_config_file,
            open_skills_folder,
            list_roles,
            models::list_models,
            open_global_mcp_config,
            open_in_editor,
            reload_settings,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::pty_harness,
            pty::pty_roles,
            pty::resolve_default_room,
            pty::pty_spawn_shell,
            pty::pty_shell_exists,
            pty::pty_capture_turn,
            pty::pty_read_capture,
            pty::pty_heal_geometry,
            pty::pty_tap_read
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let _ = fs::create_dir_all(logs_dir());
            let log_path = logs_dir().join("hub.log");
            rotate_log_if_oversized(&log_path);

            // Stage before any spawn; a failure is not fatal (pi/shell still work) but
            // claude spawns will refuse with a clear error until it succeeds.
            match materialize_chatbridge_mod() {
                Ok(p) => println!("[setup] chatbridge mod staged: {}", p.display()),
                Err(e) => eprintln!("[setup] chatbridge mod staging failed: {e}"),
            }

            match factory::materialize_factory() {
                Ok(v) => println!("[setup] factory roles staged: {v}"),
                Err(e) => eprintln!("[setup] factory staging failed: {e}"),
            }

            let port = pick_free_port()?;
            let url = format!("http://127.0.0.1:{port}");
            let token = mint_token()?;
            println!("[setup] hub port: {port}");

            if let Err(e) = write_discovery_file(&url) {
                eprintln!("[setup] discovery file write failed: {e}");
            }
            if let Err(e) = write_token_file(&token) {
                eprintln!("[setup] token file write failed: {e}");
            }

            let human_name = match resolve_human_name() {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[setup] invalid human_name: {e}");
                    return Err(Box::<dyn std::error::Error>::from(e));
                }
            };
            println!("[setup] human name: {human_name}");

            let extensions = resolve_attachment_extensions();
            println!("[setup] attachment extensions: {}", extensions.join(","));

            let attachments_dir = resolve_attachments_dir_and_seed(&human_name, &extensions);
            println!("[setup] attachments dir: {}", attachments_dir.display());

            let chat_history_limit = resolve_chat_history_limit();
            println!("[setup] chat history limit: {chat_history_limit}");

            let ledger_path = ledger_file();
            println!("[setup] ledger: {}", ledger_path.display());

            let shell = handle.shell();
            let mut cmd = shell
                .sidecar("cubilot-bin")
                .map_err(|e| format!("sidecar builder: {e}"))?
                .env("PORT", port.to_string())
                .env("CUBILOT_MODE", "hub")
                .env("CUBILOT_DATA_DIR", app_data_dir().to_string_lossy().to_string())
                .env("CUBILOT_TOKEN", &token)
                .env("CUBILOT_ATTACHMENTS_DIR", attachments_dir.to_string_lossy().to_string())
                .env("CUBILOT_LEDGER_DB", ledger_path.to_string_lossy().to_string())
                .env("CUBILOT_HUMAN_NAME", &human_name)
                .env("CUBILOT_ALLOWED_EXTENSIONS", extensions.join(","))
                .env("CUBILOT_CHAT_HISTORY_LIMIT", chat_history_limit.to_string());
            cmd = apply_summariser_env(cmd);

            let (rx, child) = cmd.spawn().map_err(|e| format!("spawn cubilot-bin: {e}"))?;

            {
                let state = handle.state::<HubState>();
                *state
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(child);
                *state
                    .info
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(HubInfo { url, token });
                *state
                    .human_name
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(human_name);
            }

            tauri::async_runtime::spawn(async move {
                stream_to_log(rx, log_path).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Tauri app")
        .run(|handle, event| {
            let kill = || {
                let state = handle.state::<HubState>();
                let child_opt = state
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(child) = child_opt {
                    let _ = child.kill();
                }
                // PTY handles Drop → attach-session SIGHUP → detach cleanly. tmux sessions intentionally survive.
            };
            match event {
                RunEvent::ExitRequested { .. } => kill(),
                RunEvent::WindowEvent {
                    event: WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed,
                    ..
                } => kill(),
                RunEvent::Exit => kill(),
                _ => {}
            }
        });
}

#[cfg(test)]
mod attachment_default_tests {
    // The types a ticket or a chat may carry out of the box; config.yml can still override them.
    #[test]
    fn default_extensions_are_the_six_attachment_types() {
        let mut got = super::default_attachment_extensions();
        got.sort();
        assert_eq!(got, ["jpeg", "jpg", "md", "pdf", "png", "txt"]);
    }
}

#[cfg(test)]
mod chatbridge_mod_tests {
    use super::{ensure_staged, install_mod_dir_with, mod_dir_is_complete, pid_is_running, stage_chatbridge_mod, sweep_stale_staging};
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cubilot-mod-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_regular_file_at_the_destination_is_replaced_and_leaves_no_temp_entry() {
        let root = scratch("stage-file-dest");
        let js = root.join("src.js");
        let dest = root.join("data/chatbridge-mod");
        fs::write(&js, "v1").unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "stray file").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();
        assert!(dest.join("hooks/register.js").is_file());
        let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap()).unwrap()
            .filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".chatbridge-mod.")).collect();
        assert!(leftovers.is_empty(), "left temp entries: {leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stages_plugin_layout_and_replaces_old_dir() {
        let root = scratch("stage");
        let js = root.join("src.js");
        let dest = root.join("data/chatbridge-mod");
        fs::write(&js, "v1").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();
        assert!(dest.join(".claude-plugin/plugin.json").is_file());
        assert!(dest.join("hooks/hooks.json").is_file());
        assert_eq!(fs::read_to_string(dest.join("hooks/register.js")).unwrap(), "v1");

        // Restage: stale file from the old dir must be gone, new js in place, no temp dirs left.
        fs::write(dest.join("stale.txt"), "x").unwrap();
        fs::write(&js, "v2").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();
        assert_eq!(fs::read_to_string(dest.join("hooks/register.js")).unwrap(), "v2");
        assert!(!dest.join("stale.txt").exists());
        let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap()).unwrap()
            .filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".chatbridge-mod.")).collect();
        assert!(leftovers.is_empty(), "left temp dirs: {leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_stage_keeps_the_old_dir() {
        let root = scratch("fail");
        let js = root.join("src.js");
        let dest = root.join("data/chatbridge-mod");
        fs::write(&js, "v1").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();
        let err = stage_chatbridge_mod(&dest, &root.join("missing.js")).unwrap_err();
        assert!(err.contains("missing.js"), "{err}");
        assert_eq!(fs::read_to_string(dest.join("hooks/register.js")).unwrap(), "v1");
        let _ = fs::remove_dir_all(&root);
    }

    /// A complete staged mod in `dir` (what stage_chatbridge_mod writes).
    fn stage_into(dir: &std::path::Path) {
        let root = dir.parent().unwrap().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        let js = root.join("src.js");
        fs::write(&js, "v").unwrap();
        stage_chatbridge_mod(dir, &js).unwrap();
    }

    #[test]
    fn ensure_staged_skips_when_staged_retries_once_otherwise_and_names_the_cause() {
        let root = scratch("ensure");
        let dir = root.join("data/chatbridge-mod");
        stage_into(&dir);
        // Already staged this process and still on disk: no retry.
        let staged = AtomicBool::new(true);
        assert_eq!(ensure_staged(&staged, dir.clone(), || panic!("must not restage")).unwrap(), dir);
        // Not staged, retry succeeds.
        let not = AtomicBool::new(false);
        assert_eq!(ensure_staged(&not, dir.clone(), || Ok(dir.clone())).unwrap(), dir);
        // Not staged, retry fails: error carries the cause; a stale dir on disk is irrelevant.
        let mut calls = 0;
        let err = ensure_staged(&AtomicBool::new(false), dir, || {
            calls += 1;
            Err("copy register.js: not found".to_string())
        }).unwrap_err();
        assert_eq!(calls, 1);
        assert!(err.contains("register.js") && err.contains("not staged"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_ensure_staged_restages_when_the_staged_folder_lost_a_file() {
        let root = scratch("r7");
        let dir = root.join("data/chatbridge-mod");
        stage_into(&dir);
        assert!(mod_dir_is_complete(&dir));
        let staged = AtomicBool::new(true);                      // this process staged it earlier

        // Each file Claude Code needs, removed in turn: the flag alone must not be trusted.
        for missing in ["hooks/register.js", "hooks/hooks.json", ".claude-plugin/plugin.json"] {
            fs::remove_file(dir.join(missing)).unwrap();
            assert!(!mod_dir_is_complete(&dir), "{missing}");
            let mut calls = 0;
            let got = ensure_staged(&staged, dir.clone(), || {
                calls += 1;
                stage_into(&dir);
                Ok(dir.clone())
            }).unwrap();
            assert_eq!((calls, got), (1, dir.clone()), "{missing}: restaged once");
            assert!(mod_dir_is_complete(&dir), "{missing}: back");
            // And once it is whole again nothing is restaged.
            assert_eq!(ensure_staged(&staged, dir.clone(), || panic!("must not restage")).unwrap(), dir);
        }

        // The whole folder gone.
        fs::remove_dir_all(&dir).unwrap();
        let mut calls = 0;
        ensure_staged(&staged, dir.clone(), || { calls += 1; stage_into(&dir); Ok(dir.clone()) }).unwrap();
        assert_eq!(calls, 1);

        // A restage that fails reports the cause.
        fs::remove_file(dir.join("hooks/register.js")).unwrap();
        let err = ensure_staged(&staged, dir.clone(), || Err("disk full".to_string())).unwrap_err();
        assert!(err.contains("disk full") && err.contains("not staged"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r6_staging_sweeps_leftovers_of_dead_processes_only() {
        use std::process::Command;
        let root = scratch("r6");
        let data = root.join("data");
        let dest = data.join("chatbridge-mod");
        let js = root.join("src.js");
        fs::write(&js, "v1").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();

        // A pid that is certainly gone: a child that has exited and been reaped.
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let dead = child.id() as i32;
        child.wait().unwrap();
        assert!(!pid_is_running(dead));
        // A pid that certainly runs: the parent (the test runner's shell/cargo) and ourselves.
        let alive = std::os::unix::process::parent_id() as i32;
        assert!(pid_is_running(alive));
        let me = std::process::id();

        let mk = |name: String| { let d = data.join(&name); fs::create_dir_all(d.join("hooks")).unwrap(); fs::write(d.join("hooks/x"), "x").unwrap(); name };
        let gone = [mk(format!(".chatbridge-mod.tmp-{dead}")), mk(format!(".chatbridge-mod.old-{dead}-7")), mk(format!(".chatbridge-mod.tmp-{dead}-12"))];
        let kept = [
            mk(format!(".chatbridge-mod.tmp-{alive}-1")),        // another instance that is running
            mk(format!(".chatbridge-mod.old-{me}-999")),         // this process: other runs of it may be live
            mk(".chatbridge-mod.tmp-notapid".to_string()),        // not ours to judge
            mk(".chatbridge-mod.tmp-".to_string()),
            mk("chatbridge-mod-backup".to_string()),              // an unrelated neighbour
            mk(".other.tmp-1".to_string()),
        ];
        fs::write(data.join(format!(".chatbridge-mod.tmp-{dead}-file")), "a file, not a dir").unwrap();   // a stray file with a dead pid

        fs::write(&js, "v2").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();                 // sweeps as it stages

        for n in &gone { assert!(!data.join(n).exists(), "{n} should be swept"); }
        for n in &kept { assert!(data.join(n).exists(), "{n} should be kept"); }
        assert_eq!(fs::read_to_string(dest.join("hooks/register.js")).unwrap(), "v2");
        sweep_stale_staging(&data);                                // idempotent
        assert!(dest.join("hooks/register.js").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    /// Two directories, `tmp` (new) and `dest` (the mod that is installed), each with a marker file.
    fn two_dirs(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = scratch(name);
        let (tmp, dest) = (root.join("tmp"), root.join("dest"));
        for (d, v) in [(&tmp, "new"), (&dest, "old")] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("marker"), v).unwrap();
        }
        (root, tmp, dest)
    }
    fn err_of(code: i32) -> std::io::Error { std::io::Error::from_raw_os_error(code) }

    #[test]
    fn r5_where_the_swap_is_unsupported_it_fails_and_leaves_the_installed_mod_alone() {
        for code in [libc::ENOTSUP, libc::EINVAL] {
            let (root, tmp, dest) = two_dirs(&format!("r5-unsup-{code}"));
            let calls = std::cell::Cell::new(0);
            let swap = |_: &std::path::Path, _: &std::path::Path| { calls.set(calls.get() + 1); Err(err_of(code)) };
            let err = install_mod_dir_with(&tmp, &dest, &swap).unwrap_err();
            assert!(err.contains("atomically") && err.contains("left as it is"), "{err}");
            assert_eq!(calls.get(), 1, "no retry, no fallback");
            assert_eq!(fs::read_to_string(dest.join("marker")).unwrap(), "old", "the installed mod is untouched");
            assert!(tmp.is_dir(), "the new folder is still there for the caller to remove");
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn r5_any_other_swap_error_fails_the_same_way() {
        let (root, tmp, dest) = two_dirs("r5-eperm");
        let err = install_mod_dir_with(&tmp, &dest, &|_, _| Err(err_of(libc::EPERM))).unwrap_err();
        assert!(err.contains("swap into place") && err.contains("left as it is"), "{err}");
        assert_eq!(fs::read_to_string(dest.join("marker")).unwrap(), "old");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r5_a_dest_that_vanishes_before_the_swap_gets_a_plain_rename() {
        let (root, tmp, dest) = two_dirs("r5-vanish");
        let dest_for_swap = dest.clone();
        let swap = move |_: &std::path::Path, _: &std::path::Path| { fs::remove_dir_all(&dest_for_swap).unwrap(); Err(err_of(libc::ENOENT)) };
        install_mod_dir_with(&tmp, &dest, &swap).unwrap();
        assert_eq!(fs::read_to_string(dest.join("marker")).unwrap(), "new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r5_giving_up_after_three_lost_races_leaves_the_installed_mod_alone() {
        let (root, tmp, dest) = two_dirs("r5-race");
        let calls = std::cell::Cell::new(0);
        // dest keeps existing (another instance installed it) and the swap keeps reporting it gone.
        let swap = |_: &std::path::Path, _: &std::path::Path| { calls.set(calls.get() + 1); Err(err_of(libc::ENOENT)) };
        let err = install_mod_dir_with(&tmp, &dest, &swap).unwrap_err();
        assert!(err.contains("gave up after 3 tries") && err.contains("left the existing mod"), "{err}");
        assert_eq!(calls.get(), 3);
        assert_eq!(fs::read_to_string(dest.join("marker")).unwrap(), "old");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r5_a_failed_install_through_stage_keeps_the_old_mod_and_leaves_no_temp_dir() {
        // The same failure end to end: a register.js that cannot be copied.
        let root = scratch("r5-stage-fail");
        let js = root.join("src.js");
        let dest = root.join("data/chatbridge-mod");
        fs::write(&js, "v1").unwrap();
        stage_chatbridge_mod(&dest, &js).unwrap();
        assert!(stage_chatbridge_mod(&dest, &root.join("missing.js")).is_err());
        assert_eq!(fs::read_to_string(dest.join("hooks/register.js")).unwrap(), "v1");
        let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap()).unwrap().filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".chatbridge-mod.")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r5_the_mod_dir_is_never_missing_while_it_is_restaged() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let root = scratch("r5");
        let dest = root.join("data/chatbridge-mod");
        let js_a = root.join("a.js");
        let js_b = root.join("b.js");
        fs::write(&js_a, "AAAA").unwrap();
        fs::write(&js_b, "BBBB").unwrap();
        stage_chatbridge_mod(&dest, &js_a).unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let reader = {
            let (dest, stop) = (dest.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut reads = 0u32;
                let mut bad = Vec::new();
                while !stop.load(Ordering::SeqCst) {
                    match fs::read_to_string(dest.join("hooks/register.js")) {
                        Ok(t) if t == "AAAA" || t == "BBBB" => {}
                        other => bad.push(format!("{other:?}")),
                    }
                    reads += 1;
                }
                (reads, bad)
            })
        };
        // Four stagers at once (separate runs of one process, as the startup staging and a spawn's retry can be).
        let writers: Vec<_> = (0..4).map(|i| {
            let (dest, js) = (dest.clone(), if i % 2 == 0 { js_a.clone() } else { js_b.clone() });
            std::thread::spawn(move || for _ in 0..40 { stage_chatbridge_mod(&dest, &js).unwrap(); })
        }).collect();
        for w in writers { w.join().unwrap(); }
        stop.store(true, Ordering::SeqCst);
        let (reads, bad) = reader.join().unwrap();
        assert!(reads > 100, "the reader barely ran: {reads}");
        assert!(bad.is_empty(), "a reader saw a missing or half-written mod {} times of {reads}: {:?}", bad.len(), &bad[..bad.len().min(3)]);
        let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap()).unwrap().filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".chatbridge-mod.")).collect();
        assert!(leftovers.is_empty(), "left temp dirs: {leftovers:?}");
        assert!(mod_dir_is_complete(&dest));
        let _ = fs::remove_dir_all(&root);
    }
}
