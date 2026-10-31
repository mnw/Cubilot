// Read-only tmux queries of the shell: the bundled tmux path for the hub, the live sessions for the factory cleanup
// and the pane cwd for "open in editor". The hub owns every terminal (hub/core/tmux.ts); the shell starts no session.

use std::path::PathBuf;
use std::process::Command;

use crate::{app_data_dir, resolve_tmux_bin as real_tmux_bin};

#[cfg(test)]
thread_local! {
    // (tmux binary, socket) of an isolated test server; unset: the real ones.
    static TEST_TMUX: std::cell::RefCell<Option<(PathBuf, PathBuf)>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn resolve_tmux_bin() -> Result<PathBuf, String> {
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

// `=name:` names a pane of the session exactly (a bare `-t name` matches by prefix).
fn tmux_pane(name: &str) -> String {
    format!("={name}:")
}

// Mirrors hub.ts AGENT_NAME_RE; the name reaches a tmux target.
fn valid_agent_name(name: &str) -> bool {
    if name == "shell" {
        return false;
    }
    let n = name.chars().count();
    if !(1..=64).contains(&n) {
        return false;
    }
    if name.starts_with(' ') || name.ends_with(' ') {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))
}

fn resolve_utf8_locale() -> String {
    std::env::var("LANG")
        .ok()
        .filter(|v| v.to_lowercase().contains("utf"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string())
}

// A tmux client without a UTF-8 locale prints a tab of a -F / -p format as "_".
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_target_has_the_equals_prefix_and_the_colon() {
        assert_eq!(tmux_pane("worker-1"), "=worker-1:");
    }

    #[test]
    fn pane_current_path_refuses_a_bad_name_before_it_runs_tmux() {
        for bad in ["", "shell", " a", "a b;", "a\"b", &"x".repeat(65)] {
            assert!(pane_current_path(bad).is_err(), "{bad:?}");
        }
    }

    // A real tmux on an isolated socket (never the Cubilot one): TEST_TMUX points tmux_run at it for this thread.
    #[test]
    fn live_tmux_state_reads_sessions_and_fails_unless_there_is_no_socket() {
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/tmux");
        let bin = if bundled.exists() { bundled } else { PathBuf::from("tmux") };
        let sock = PathBuf::from(format!("/tmp/cubilot-rs-tmux-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        TEST_TMUX.with(|c| *c.borrow_mut() = Some((bin.clone(), sock.clone())));
        let raw = |args: &[&str]| Command::new(&bin).arg("-S").arg(&sock).args(args).status().map(|s| s.success()).unwrap_or(false);
        // No socket file: no server, nothing live.
        assert_eq!(live_tmux_state(), Ok((vec![], String::new())));
        // A live session and its start command.
        assert!(raw(&["new-session", "-d", "-s", "test agent", "-x", "80", "-y", "24", "sleep 300"]), "new-session");
        let (sessions, panes) = live_tmux_state().unwrap();
        assert_eq!(sessions, vec!["test agent".to_string()]);
        assert!(panes.contains("sleep 300"), "{panes}");
        // A socket path that is a regular file is a failure, not "no sessions".
        raw(&["kill-server"]);
        let _ = std::fs::remove_file(&sock);
        std::fs::write(&sock, "regular file").unwrap();
        let failed = live_tmux_state().is_err();
        let _ = std::fs::remove_file(&sock);
        TEST_TMUX.with(|c| *c.borrow_mut() = None);
        assert!(failed);
    }
}
