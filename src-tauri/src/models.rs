// The rows of the model x effort grid in the spawn modal (task 5.5).
// Claude: the four fixed models. Pi: ALL models of `pi --list-models`, each with whether its provider is signed in
// (`pi auth check`), so the modal can mark a provider that is not ready instead of hiding its models.
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Clone, serde::Serialize)]
pub struct ModelRow {
    pub provider: String, // "" for Claude
    pub model: String,
    pub thinking: bool,   // Pi's own "thinking" column; Claude: true
    pub ready: bool,      // provider signed in; Claude: true
}

pub fn claude_models() -> Vec<ModelRow> {
    ["haiku", "sonnet", "opus", "fable"]
        .iter()
        .map(|m| ModelRow { provider: String::new(), model: m.to_string(), thinking: true, ready: true })
        .collect()
}

// stdout of `pi --list-models`: a header line, then `provider model context max-out thinking images` in columns.
// Only stdout is parsed: pi prints "Could not refresh <provider>; showing cached models" on stderr.
pub fn parse_pi_models(stdout: &str) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 || (f[0] == "provider" && f[1] == "model") {
            continue;
        }
        if !crate::factory::valid_provider(f[0]) || !crate::factory::valid_model(f[1]) {
            continue; // a row the launch would refuse anyway
        }
        out.push((f[0].to_string(), f[1].to_string(), f[4] == "yes"));
    }
    out
}

const LIST_LIMIT: Duration = Duration::from_secs(20);

fn run_list_models(pi: &Path) -> Result<String, String> {
    use std::io::Read as _;
    let mut child = Command::new(pi)
        .arg("--list-models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run `pi --list-models`: {e}"))?;
    let deadline = Instant::now() + LIST_LIMIT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("`pi --list-models` took more than 20 seconds".to_string());
            }
        }
    }
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    Ok(out)
}

// Provider -> signed in. One check for each provider, all at once (each may take a moment on a bad network).
// `check` is the real `pi auth check` in the app and a fake in tests. Never --credentials (see pi_auth_check).
pub fn readiness<F>(providers: &[String], check: F) -> HashMap<String, bool>
where
    F: Fn(&str) -> bool + Sync,
{
    std::thread::scope(|s| {
        let handles: Vec<_> = providers.iter().map(|p| (p.clone(), s.spawn(|| check(p)))).collect();
        handles.into_iter().map(|(p, h)| (p, h.join().unwrap_or(false))).collect()
    })
}

// Cached for 5 minutes: the modal opens often and `pi auth check` may refresh a token over the network.
static READY_CACHE: Mutex<Option<(Instant, HashMap<String, bool>)>> = Mutex::new(None);

pub fn pi_models(pi: &Path) -> Result<Vec<ModelRow>, String> {
    let parsed = parse_pi_models(&run_list_models(pi)?);
    let mut providers: Vec<String> = parsed.iter().map(|(p, _, _)| p.clone()).collect();
    providers.sort();
    providers.dedup();
    let cached = READY_CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(300)).map(|(_, m)| m.clone()));
    let ready = match cached {
        Some(m) if providers.iter().all(|p| m.contains_key(p)) => m,
        _ => {
            let m = readiness(&providers, |p| crate::pty::pi_auth_check(pi, p).is_ok());
            if let Ok(mut g) = READY_CACHE.lock() {
                *g = Some((Instant::now(), m.clone()));
            }
            m
        }
    };
    Ok(parsed
        .into_iter()
        .map(|(provider, model, thinking)| ModelRow { ready: ready.get(&provider).copied().unwrap_or(false), provider, model, thinking })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "provider          model                       context  max-out  thinking  images\n\
anthropic         claude-fable-5              1M       128K     yes       yes   \n\
openai            gpt-4                       8.2K     8.2K     no        no    \n\
openai-codex      gpt-5.6-sol                 272K     128K     yes       yes   \n\
\n\
broken line\n\
bad/provider      gpt-x                       1K       1K       yes       yes   \n";

    // Manual: `cargo test --lib real_pi -- --ignored --nocapture`. Runs the real `pi` (network: sign-in checks).
    #[test]
    #[ignore]
    fn real_pi_lists_models_with_ready_marks() {
        let rows = pi_models(&crate::resolve_pi_path()).unwrap();
        let mut by: std::collections::BTreeMap<String, (usize, bool)> = Default::default();
        for r in &rows {
            let e = by.entry(r.provider.clone()).or_insert((0, r.ready));
            e.0 += 1;
        }
        eprintln!("{} models; providers (count, ready): {by:?}", rows.len());
        assert!(rows.len() > 10);
    }

    #[test]
    fn claude_has_the_four_models_all_ready() {
        let r = claude_models();
        assert_eq!(r.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(), ["haiku", "sonnet", "opus", "fable"]);
        assert!(r.iter().all(|m| m.ready && m.provider.is_empty()));
    }

    #[test]
    fn pi_models_are_parsed_from_stdout_and_bad_rows_are_dropped() {
        let rows = parse_pi_models(SAMPLE);
        assert_eq!(
            rows,
            vec![
                ("anthropic".to_string(), "claude-fable-5".to_string(), true),
                ("openai".to_string(), "gpt-4".to_string(), false),
                ("openai-codex".to_string(), "gpt-5.6-sol".to_string(), true),
            ]
        );
        // a stderr line that leaked into the text is not a model row
        assert!(parse_pi_models("Could not refresh anthropic; showing cached models\n").is_empty());
        assert!(parse_pi_models("").is_empty());
    }

    #[test]
    fn readiness_checks_every_provider_once_and_in_parallel() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let t0 = Instant::now();
        let providers: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let m = readiness(&providers, |p| {
            calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            p == "a" || p == "c"
        });
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!((m["a"], m["b"], m["c"], m["d"]), (true, false, true, false));
        assert!(t0.elapsed() < Duration::from_millis(900), "parallel, not 4 x 300 ms: {:?}", t0.elapsed());
    }

    #[test]
    fn a_fake_pi_gives_rows_with_ready_marks_and_stderr_is_ignored() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cubilot-fake-pi-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pi = dir.join("pi");
        // `--list-models` prints rows on stdout and a warning on stderr; `auth check` is ready for openai-codex only
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--list-models\" ]; then echo 'Could not refresh anthropic; showing cached models' >&2; printf '%s' '{}'; exit 0; fi\n\
if [ \"$1\" = \"auth\" ] && [ \"$4\" = \"openai-codex\" ]; then echo '{{\"status\":\"ready\"}}'; exit 0; fi\n\
echo '{{\"status\":\"not_ready\",\"reason\":\"credentials_not_configured\"}}'; exit 1\n",
            SAMPLE.replace('\'', "")
        );
        std::fs::write(&pi, script).unwrap();
        std::fs::set_permissions(&pi, std::fs::Permissions::from_mode(0o755)).unwrap();
        let rows = pi_models(&pi).unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        let by = |m: &str| rows.iter().find(|r| r.model == m).unwrap();
        assert!(by("gpt-5.6-sol").ready && by("gpt-5.6-sol").thinking);
        assert!(!by("gpt-4").ready && !by("gpt-4").thinking, "not signed in: kept and marked, not hidden");
        assert!(!by("claude-fable-5").ready);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// The command: Claude rows at once, Pi rows from `pi --list-models` (blocking, so off the async runtime).
#[tauri::command]
pub async fn list_models(harness: String) -> Result<Vec<ModelRow>, String> {
    match harness.trim() {
        "claude" | "" => Ok(claude_models()),
        "pi" => {
            let pi = crate::resolve_pi_path();
            tauri::async_runtime::spawn_blocking(move || pi_models(&pi))
                .await
                .map_err(|e| format!("list models worker failed: {e}"))?
        }
        other => Err(format!("invalid harness: {other}")),
    }
}
