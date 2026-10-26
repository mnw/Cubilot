// The PATH of the user's login shell, for the Pi processes the app starts. An app opened from the Dock inherits the
// launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a Pi shim that runs `node` fails with "node: not found". Resolved
// once per process, as the user's login shell sets it. Failure keeps the inherited PATH.

use std::io::Read as _;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MARKER: &str = "__CUBILOT_PATH__";
const RESOLVE_LIMIT: Duration = Duration::from_secs(5);
const OUTPUT_CAP: usize = 64 * 1024;

// The value after the LAST marker; the shell's startup files may print anything before it.
pub(crate) fn parse_marker(stdout: &str) -> Option<String> {
    let rest = &stdout[stdout.rfind(MARKER)? + MARKER.len()..];
    let value = rest.lines().next()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

// $SHELL if it is an absolute path to an executable file, else /bin/zsh.
pub(crate) fn pick_shell(env_shell: Option<&str>) -> String {
    use std::os::unix::fs::PermissionsExt;
    env_shell
        .filter(|s| s.starts_with('/'))
        .filter(|s| std::fs::metadata(s).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false))
        .unwrap_or("/bin/zsh")
        .to_string()
}

// Reads what the pipe holds now, without waiting. Ok(true) at end of file.
fn drain(so: &mut std::process::ChildStdout, buf: &mut Vec<u8>) -> Result<bool, String> {
    let mut chunk = [0u8; 4096];
    loop {
        match so.read(&mut chunk) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > OUTPUT_CAP {
                    return Err(format!("the shell printed more than {OUTPUT_CAP} bytes"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(format!("could not read the shell output: {e}")),
        }
    }
}

// One thread, one deadline for the whole call: the pipe is read without blocking, so a background job that keeps it
// open cannot hold anything after we return. The output is capped. On any failure the shell is killed and reaped.
pub(crate) fn resolve_with(shell: &str, limit: Duration) -> Result<String, String> {
    use std::os::fd::AsRawFd as _;
    let deadline = Instant::now() + limit;
    let script = format!("printf \"{MARKER}%s\\n\" \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {shell}: {e}"))?;
    let kill = |child: &mut std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
    let Some(mut so) = child.stdout.take() else {
        kill(&mut child);
        return Err("no stdout".to_string());
    };
    let fd = so.as_raw_fd();
    // SAFETY: fd is the open read end of our own pipe, owned by `so` for the whole call.
    let nonblocking = unsafe { libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK) } == 0;
    if !nonblocking {
        kill(&mut child);
        return Err("could not set the shell pipe to non-blocking".to_string());
    }
    let mut buf = Vec::new();
    let status = loop {
        if let Err(e) = drain(&mut so, &mut buf) {
            kill(&mut child);
            return Err(e);
        }
        match child.try_wait() {
            Ok(Some(st)) => {
                // What the shell wrote before it exited is in the pipe: take it, but wait for no descendant.
                drain(&mut so, &mut buf)?;
                break st;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                kill(&mut child);
                return Err(format!("{shell} took more than {} ms", limit.as_millis()));
            }
        }
    };
    if !status.success() {
        return Err(format!("{shell} exited with {status}"));
    }
    parse_marker(&String::from_utf8_lossy(&buf)).ok_or_else(|| format!("{shell} printed no PATH"))
}

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

// Blocking (up to 5 s on the first call): call from spawn_blocking. A failure is cached and logged once.
pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH
        .get_or_init(|| {
            let shell = pick_shell(std::env::var("SHELL").ok().as_deref());
            match resolve_with(&shell, RESOLVE_LIMIT) {
                Ok(p) => Some(p),
                Err(e) => {
                    eprintln!("[login_path] keeping the inherited PATH: {e}");
                    None
                }
            }
        })
        .as_deref()
}

// Sets the child's PATH. `path` None leaves the inherited one.
pub(crate) fn apply(cmd: &mut Command, path: Option<&str>) {
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &std::path::Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().to_string()
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cubilot-login-path-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parse_takes_the_value_after_the_last_marker_and_ignores_noise() {
        assert_eq!(parse_marker("motd\n__CUBILOT_PATH__/a:/b\n").as_deref(), Some("/a:/b"));
        assert_eq!(parse_marker("__CUBILOT_PATH__/old\nnoise\n__CUBILOT_PATH__/new:/bin\ntrailing").as_deref(), Some("/new:/bin"));
        assert_eq!(parse_marker("\x1b[0mprompt__CUBILOT_PATH__/x\n").as_deref(), Some("/x"));
        assert_eq!(parse_marker("no marker here"), None);
        assert_eq!(parse_marker("__CUBILOT_PATH__\n"), None);
        assert_eq!(parse_marker("__CUBILOT_PATH__   \n"), None);
    }

    #[test]
    fn shell_choice_needs_an_absolute_executable_else_zsh() {
        assert_eq!(pick_shell(Some("/bin/sh")), "/bin/sh");
        assert_eq!(pick_shell(Some("zsh")), "/bin/zsh");
        assert_eq!(pick_shell(Some("/nonexistent/shell")), "/bin/zsh");
        assert_eq!(pick_shell(Some("/etc/hosts")), "/bin/zsh", "a file that is not executable");
        assert_eq!(pick_shell(None), "/bin/zsh");
    }

    #[test]
    fn a_shell_that_prints_noise_before_the_marker_gives_the_path() {
        let d = tmp("ok");
        let sh = script(&d, "sh-ok", "echo banner; echo '__CUBILOT_PATH__/opt/x/bin:/usr/bin'");
        assert_eq!(resolve_with(&sh, Duration::from_secs(5)), Ok("/opt/x/bin:/usr/bin".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn timeout_nonzero_exit_and_empty_output_are_errors() {
        let d = tmp("err");
        let hang = script(&d, "sh-hang", "sleep 30");
        let t0 = Instant::now();
        let e = resolve_with(&hang, Duration::from_millis(300)).unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(2), "killed at the limit, not after 30 s: {:?}", t0.elapsed());
        assert!(e.contains("took more than"), "{e}");
        let bad = script(&d, "sh-bad", "echo '__CUBILOT_PATH__/x'; exit 3");
        assert!(resolve_with(&bad, Duration::from_secs(5)).unwrap_err().contains("exited with"));
        let empty = script(&d, "sh-empty", "exit 0");
        assert!(resolve_with(&empty, Duration::from_secs(5)).unwrap_err().contains("printed no PATH"));
        assert!(resolve_with("/nonexistent/sh", Duration::from_secs(5)).unwrap_err().contains("could not run"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_whole_call_stays_inside_the_limit_when_stdout_closes_near_the_deadline() {
        let d = tmp("late");
        // marker out, stdout closed at about 300 ms (limit 400 ms), then the shell hangs: the deadline is not extended
        let late = script(&d, "sh-late", "echo '__CUBILOT_PATH__/x'; sleep 0.3; exec 1>&-; sleep 30");
        let t0 = Instant::now();
        let e = resolve_with(&late, Duration::from_millis(400)).unwrap_err();
        assert!(e.contains("took more than"), "{e}");
        let took = t0.elapsed();
        assert!(took >= Duration::from_millis(300) && took < Duration::from_millis(800), "no extension past the limit: {took:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_descendant_that_keeps_the_pipe_open_holds_nothing_after_the_call() {
        let d = tmp("desc");
        let bg = script(&d, "sh-bg", "echo '__CUBILOT_PATH__/y'; sleep 3 &\nexit 0");
        let t0 = Instant::now();
        assert_eq!(resolve_with(&bg, Duration::from_secs(5)), Ok("/y".to_string()));
        assert!(t0.elapsed() < Duration::from_secs(2), "does not wait for the descendant: {:?}", t0.elapsed());
        // the same without a marker: an error at once, not a wait for the descendant
        let bg2 = script(&d, "sh-bg2", "sleep 3 &\nexit 0");
        let t0 = Instant::now();
        assert!(resolve_with(&bg2, Duration::from_secs(5)).is_err());
        assert!(t0.elapsed() < Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn output_is_capped_and_the_shell_is_killed() {
        let d = tmp("cap");
        let big = script(&d, "sh-big", "yes | head -c 200000");
        let t0 = Instant::now();
        let e = resolve_with(&big, Duration::from_secs(5)).unwrap_err();
        assert!(e.contains("more than"), "{e}");
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn apply_sets_path_only_when_resolved() {
        let mut c = Command::new("x");
        apply(&mut c, None);
        assert!(c.get_envs().next().is_none(), "inherited PATH kept");
        apply(&mut c, Some("/a:/b"));
        let got: Vec<_> = c.get_envs().map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string()))).collect();
        assert_eq!(got, vec![("PATH".to_string(), Some("/a:/b".to_string()))]);
    }
}
