// Per-agent skill switches (C6b). Design: factory/brief/04a-c6-design.md, sections 1 to 5.
//
// Files beside the agent link in `<factory dir>/agents/`, key = lowercase hex of the agent name:
//   <key>.skills-off        the human's choice (JSON array of ids). Survives a kill and the x button.
//   <key>.skills-prepared   written here on a click: a built view that nothing publishes yet.
//   <key>.skills-published  the view the paths on disk give now (written by the hub's relink, or by a launch).
//   <key>.skills-pending    the hub's copy of published for one reload attempt.
//   <key>.skills-applied    what the last successful reload loaded (hub). A launch writes it too.
//   <key>.view              symlink to the published build `<key>.view-<gen>`; the launch flags name it.
//   <key>.skills-lock/      publication lock (a folder, with an `owner` line).
// Both harnesses use the same view: `<view>/<role>/` and `<view>/shared/`, each a plugin folder whose `skills/`
// holds only the skills that are on. Claude method A (skillOverrides) does not hide plugin skills; it is not built.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) const LOCK_WAIT: Duration = Duration::from_secs(2);
static RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct SkillItem {
    pub id: String,
    pub on: bool,
    pub state: &'static str, // loaded | not_loaded | new
}

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct SkillGroup {
    pub name: String,
    pub skills: Vec<SkillItem>,
}

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct AgentSkills {
    pub role: Option<String>,
    pub mode: &'static str, // none | legacy | plain | view
    pub relaunch_needed: bool,
    pub groups: Vec<SkillGroup>,
}

fn agents_dir(dest: &Path) -> PathBuf {
    dest.join("agents")
}

fn rec(dest: &Path, agent: &str, suffix: &str) -> PathBuf {
    agents_dir(dest).join(format!("{}{suffix}", crate::factory::agent_key(agent)))
}

// JSON, mode 0600, temp file and rename (same rule as write_agent_settings).
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().ok_or_else(|| format!("no folder for {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let run = RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = dir.join(format!("{}.tmp-{}-{run}", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let _ = fs::remove_file(&tmp);
    let res = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .and_then(|_| fs::rename(&tmp, path));
    res.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("write {}: {e}", path.display())
    })
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

// ---- Inventory ----
fn skill_folders(version_dir: &Path, group: &str) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(version_dir.join(group).join("skills"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir()) // follows links
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

// Every skill id of the version: `<role>/<folder>` and `shared/<folder>`, sorted.
fn inventory(version_dir: &Path, role: &str) -> Vec<String> {
    let mut ids: Vec<String> = skill_folders(version_dir, role).into_iter().map(|f| format!("{role}/{f}")).collect();
    ids.extend(skill_folders(version_dir, "shared").into_iter().map(|f| format!("shared/{f}")));
    ids.sort();
    ids
}

fn read_off(dest: &Path, agent: &str) -> Vec<String> {
    strings(read_json(&rec(dest, agent, ".skills-off")).as_ref())
}

// ---- Mode: proven from the real launch flags, never from a substring ----
// Splits like a shell: single quotes, double quotes (backslash before " \ $ `), backslash. No expansion.
pub(crate) fn shell_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\'' => {
                has = true;
                for d in it.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = it.next() {
                    match d {
                        '"' => break,
                        '\\' => match it.peek().copied() {
                            Some(n) if matches!(n, '"' | '\\' | '$' | '`') => {
                                cur.push(n);
                                it.next();
                            }
                            _ => cur.push('\\'),
                        },
                        _ => cur.push(d),
                    }
                }
            }
            '\\' => {
                has = true;
                if let Some(n) = it.next() {
                    cur.push(n);
                }
            }
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            _ => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

// Flags that take a value in the role launch commands. The word after one is a value, never a flag.
const VALUE_FLAGS: [&str; 13] = [
    "--append-system-prompt", "--append-system-prompt-file", "--settings", "--model", "--effort", "--thinking", "--provider",
    "--exclude-tools", "--mcp-config", "--allowed-tools", "--disallowed-tools", "-e", "--prompt-template",
];

// `view`: a --skill or --plugin-dir value is under this agent's `<key>.view/`. `plain`: under its link `<key>/`.
// Anything else, or no command: `legacy`. A path of another agent, or a view path in another argument, is no proof.
pub(crate) fn mode_from_command(cmd: &str, dest: &Path, agent: &str) -> &'static str {
    let key = crate::factory::agent_key(agent);
    let view_prefix = format!("{}/", agents_dir(dest).join(format!("{key}.view")).display());
    let link_prefix = format!("{}/", agents_dir(dest).join(&key).display());
    let mut words = shell_words(cmd);
    // tmux prints a one-argument pane command as one double-quoted word: split that word once more.
    if words.len() == 1 && words[0].contains(char::is_whitespace) {
        words = shell_words(&words[0]);
    }
    let (mut view, mut plain) = (false, false);
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        if (w == "--skill" || w == "--plugin-dir") && i + 1 < words.len() {
            let v = &words[i + 1];
            if v.starts_with(&view_prefix) {
                view = true;
            } else if v.starts_with(&link_prefix) {
                plain = true;
            }
            i += 2;
        } else if VALUE_FLAGS.contains(&w) {
            i += 2;
        } else {
            i += 1;
        }
    }
    if view {
        "view"
    } else if plain {
        "plain"
    } else {
        "legacy"
    }
}

// ---- List ----
// The skills of the staged version `version_dir`, in two groups, with the box (`on`) and the state derived only from
// `.skills-applied`: loaded, not_loaded (in the applied inventory and off there) or new (not in the inventory).
pub(crate) fn list_in(dest: &Path, version_dir: &Path, agent: &str, role: Option<&str>, command: Option<&str>) -> AgentSkills {
    let Some(role) = role.filter(|r| !r.is_empty()) else {
        return AgentSkills { role: None, mode: "none", relaunch_needed: false, groups: vec![] };
    };
    let mode = command.map(|c| mode_from_command(c, dest, agent)).unwrap_or("legacy");
    // An id of an older role (a name used again with another role) is ignored here, as launch_in ignores it.
    let inv = inventory(version_dir, role);
    let off = read_off(dest, agent);
    let relaunch_needed = matches!(mode, "legacy" | "plain") && off.iter().any(|id| inv.contains(id));
    let applied = read_json(&rec(dest, agent, ".skills-applied"));
    let (a_skills, a_off) = match &applied {
        Some(a) => (strings(a.get("skills")), strings(a.get("off"))),
        None => (vec![], vec![]),
    };
    let group = |name: String, g: &str| SkillGroup {
        name,
        skills: skill_folders(version_dir, g)
            .into_iter()
            .map(|f| {
                let id = format!("{g}/{f}");
                let state = if !a_skills.contains(&id) {
                    "new"
                } else if a_off.contains(&id) {
                    "not_loaded"
                } else {
                    "loaded"
                };
                SkillItem { on: !off.contains(&id), id, state }
            })
            .collect(),
    };
    AgentSkills {
        role: Some(role.to_string()),
        mode,
        relaunch_needed,
        groups: vec![group(format!("Role \u{b7} {role}"), role), group("Shared".to_string(), "shared")],
    }
}

// ---- Store ----
// Unknown id: error, nothing written. Empty list: the file goes. A failed write changes nothing.
pub(crate) fn set_off_in(dest: &Path, version_dir: &Path, agent: &str, role: &str, off: &[String]) -> Result<(), String> {
    let inv = inventory(version_dir, role);
    if let Some(bad) = off.iter().find(|id| !inv.contains(id)) {
        return Err(format!("unknown skill: {bad}"));
    }
    let mut ids: Vec<String> = off.to_vec();
    ids.sort();
    ids.dedup();
    let path = rec(dest, agent, ".skills-off");
    if ids.is_empty() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", path.display())),
        };
    }
    write_atomic(&path, &serde_json::to_string(&ids).map_err(|e| e.to_string())?)
}

// ---- Publication lock ----
fn ps_start(pid: i32) -> Option<String> {
    let o = std::process::Command::new("/bin/ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (o.status.success() && !s.is_empty()).then_some(s)
}

fn own_line(holder: &str) -> Result<String, String> {
    let pid = std::process::id() as i32;
    let start = ps_start(pid).ok_or_else(|| "cannot read the start time of this process".to_string())?;
    Ok(format!("{holder} {pid} {start}"))
}

// The owner is confirmed dead only if the line parses and its pid is gone, or the pid has another start time.
// A line that does not parse, or a `ps` that fails or is unclear, means alive.
// `ps -o lstart=` prints e.g. "Sat Oct 24 22:28:48 2026" (day padded with a space below 10).
fn is_lstart(s: &str) -> bool {
    let b = s.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let alpha = |i: usize| b.get(i).is_some_and(u8::is_ascii_alphabetic);
    b.len() == 24
        && alpha(0) && alpha(1) && alpha(2) && b[3] == b' '
        && alpha(4) && alpha(5) && alpha(6) && b[7] == b' '
        && (b[8] == b' ' || digit(8)) && digit(9) && b[10] == b' '
        && digit(11) && digit(12) && b[13] == b':' && digit(14) && digit(15) && b[16] == b':' && digit(17) && digit(18)
        && b[19] == b' ' && digit(20) && digit(21) && digit(22) && digit(23)
}

pub(crate) fn owner_dead(line: &str) -> bool {
    let mut p = line.splitn(3, ' ');
    let (Some(holder), Some(pid), Some(start)) = (p.next(), p.next(), p.next()) else { return false };
    if !matches!(holder, "app" | "hub") {
        return false;
    }
    let Ok(pid) = pid.parse::<i32>() else { return false };
    if pid <= 0 || !is_lstart(start.trim()) {
        return false; // a start time that is not `ps -o lstart=` output cannot prove a reused pid: the owner stays alive
    }
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return true;
    }
    ps_start(pid).is_some_and(|s| s != start.trim())
}

pub(crate) struct SkillsLock {
    dir: PathBuf,
    line: String,
}

// Stale-lock recovery is the one place where a process deletes a lock it does not own, so it is serialised: an exclusive
// flock on `<key>.skills-lock.guard` (the hub takes the same one). The kernel drops it when the process dies, so the
// guard cannot go stale and needs no recovery of its own. It is held only for the check-and-remove below. The owner
// line is read again under the guard, and nobody else can remove or replace the folder meanwhile (a taker needs the
// folder to be gone, and only a recovery under this guard removes a dead owner's folder).
struct RecoveryGuard(fs::File);

impl RecoveryGuard {
    fn take(path: &Path, deadline: Instant) -> Option<Self> {
        use std::os::fd::AsRawFd as _;
        let f = fs::OpenOptions::new().create(true).append(true).open(path).ok()?;
        loop {
            // SAFETY: the fd is open and owned by `f` for the whole call.
            if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Some(Self(f));
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

type RecoveryHook = Box<dyn Fn(&Path) + Send + Sync>;
// Test seam: runs under the guard, right after the owner line is confirmed dead and before anything is removed.
#[cfg(test)]
static RECOVERY_HOOK: std::sync::Mutex<Option<RecoveryHook>> = std::sync::Mutex::new(None);

impl SkillsLock {
    pub(crate) fn take(dest: &Path, agent: &str, holder: &str, wait: Duration) -> Result<Self, String> {
        Self::take_as(dest, agent, &own_line(holder)?, wait)
    }

    // `line` is the owner line to write. Production passes its own; the concurrency tests pass the line of a live helper.
    pub(crate) fn take_as(dest: &Path, agent: &str, line: &str, wait: Duration) -> Result<Self, String> {
        let dir = rec(dest, agent, ".skills-lock");
        let guard_path = rec(dest, agent, ".skills-lock.guard");
        fs::create_dir_all(agents_dir(dest)).map_err(|e| format!("create agents folder: {e}"))?;
        let deadline = Instant::now() + wait;
        loop {
            match fs::create_dir(&dir) {
                Ok(()) => {
                    if let Err(e) = fs::write(dir.join("owner"), format!("{line}\n")) {
                        let _ = fs::remove_dir(&dir);
                        return Err(format!("write lock owner: {e}"));
                    }
                    return Ok(Self { dir, line: line.to_string() });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A missing owner file is a taker that is still writing it: wait. A lock is never removed by age.
                    if fs::read_to_string(dir.join("owner")).ok().is_some_and(|t| owner_dead(t.trim())) {
                        if let Some(_guard) = RecoveryGuard::take(&guard_path, deadline) {
                            // Under the guard: decide again from a fresh read. Remove only a folder whose owner is the
                            // dead one we see now; any other state (gone, new owner, unclear) is left alone.
                            let now = fs::read_to_string(dir.join("owner")).ok().map(|t| t.trim().to_string());
                            if let Some(l) = now.filter(|l| owner_dead(l)) {
                                #[cfg(test)]
                                if let Some(h) = RECOVERY_HOOK.lock().unwrap().as_ref() {
                                    h(&dir);
                                }
                                let _ = &l;
                                let gone = match fs::remove_file(dir.join("owner")) {
                                    Ok(()) => true,
                                    Err(e) => e.kind() == std::io::ErrorKind::NotFound,
                                };
                                // Retry at once only if the folder is really gone and there is time left. A removal that
                                // fails falls through to the deadline check below: no unbounded loop.
                                if gone && fs::remove_dir(&dir).is_ok() && Instant::now() < deadline {
                                    continue;
                                }
                            } else if Instant::now() < deadline {
                                continue; // the state changed under us: look again
                            }
                        }
                    }
                }
                Err(e) => return Err(format!("take lock {}: {e}", dir.display())),
            }
            if Instant::now() >= deadline {
                return Err("the skills lock is busy; try again".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // Removes the lock only if its owner line is still `line`.
    pub(crate) fn release_as(dir: &Path, line: &str) {
        if fs::read_to_string(dir.join("owner")).ok().map(|t| t.trim().to_string()).as_deref() == Some(line) {
            let _ = fs::remove_file(dir.join("owner"));
            let _ = fs::remove_dir(dir);
        }
    }
}

impl Drop for SkillsLock {
    fn drop(&mut self) {
        Self::release_as(&self.dir, &self.line);
    }
}

// ---- Builds ----
fn view_gens(dest: &Path, agent: &str) -> Vec<u64> {
    let prefix = format!("{}.view-", crate::factory::agent_key(agent));
    fs::read_dir(agents_dir(dest))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(&prefix).and_then(|n| n.parse::<u64>().ok()))
        .collect()
}

fn record_gen(dest: &Path, agent: &str, suffix: &str) -> Option<u64> {
    read_json(&rec(dest, agent, suffix))?.get("gen")?.as_u64()
}

// One more than the highest generation seen in a record or a view folder.
fn next_gen(dest: &Path, agent: &str) -> u64 {
    let recs = [".skills-prepared", ".skills-published", ".skills-pending", ".skills-applied"].iter().filter_map(|s| record_gen(dest, agent, s));
    recs.chain(view_gens(dest, agent)).max().map_or(1, |g| g + 1)
}

// `<key>.view-<gen>/<group>/`: a plugin folder per group. `skills/` is a real folder of symlinks to the skills that
// are on (the target goes through the agent link, so a version change reaches the right files). `.claude-plugin`,
// `.gitignore` and `tsconfig.json` are real copies: Claude Code writes into them, and a write through a link would
// change a staged file that every agent of the version shares. Everything else (role.md, hooks, ...) is a link.
fn build_view(dest: &Path, version_dir: &Path, agent: &str, role: &str, gen: u64, off: &[String]) -> Result<PathBuf, String> {
    let key = crate::factory::agent_key(agent);
    let link = agents_dir(dest).join(&key);
    let view = agents_dir(dest).join(format!("{key}.view-{gen}"));
    let build = || -> Result<(), String> {
        let _ = fs::remove_dir_all(&view);
        for group in [role, "shared"] {
            let src = version_dir.join(group);
            if !src.is_dir() {
                return Err(format!("{} is missing in the staged version", src.display()));
            }
            let dst = view.join(group);
            fs::create_dir_all(&dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
            for e in fs::read_dir(&src).map_err(|e| format!("read {}: {e}", src.display()))?.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if n == ".DS_Store" {
                    continue;
                }
                if n == "skills" {
                    fs::create_dir_all(dst.join("skills")).map_err(|e| e.to_string())?;
                    for f in skill_folders(version_dir, group) {
                        if off.contains(&format!("{group}/{f}")) {
                            continue;
                        }
                        std::os::unix::fs::symlink(link.join(group).join("skills").join(&f), dst.join("skills").join(&f))
                            .map_err(|e| format!("link skill {f}: {e}"))?;
                    }
                } else if n == ".claude-plugin" || n == ".gitignore" || n == "tsconfig.json" {
                    if e.path().is_dir() {
                        crate::factory::copy_tree(&e.path(), &dst.join(&name))?;
                    } else {
                        fs::copy(e.path(), dst.join(&name)).map_err(|e| format!("copy {n}: {e}"))?;
                    }
                } else {
                    std::os::unix::fs::symlink(link.join(group).join(&name), dst.join(&name)).map_err(|e| format!("link {n}: {e}"))?;
                }
            }
        }
        Ok(())
    };
    build().map_err(|e| {
        let _ = fs::remove_dir_all(&view);
        e
    })?;
    Ok(view)
}

// Deletes the builds that no record names, except the one generation below the published one (a lazy read through
// the old path still works for one more generation). Never touches a named build. Runs under the lock.
fn cleanup_views(dest: &Path, agent: &str) {
    let named: Vec<u64> = [".skills-prepared", ".skills-published", ".skills-pending"].iter().filter_map(|s| record_gen(dest, agent, s)).collect();
    let published = record_gen(dest, agent, ".skills-published");
    let gens = view_gens(dest, agent);
    let previous = published.and_then(|p| gens.iter().copied().filter(|g| *g < p).max());
    let key = crate::factory::agent_key(agent);
    for g in gens {
        if !named.contains(&g) && Some(g) != previous {
            let _ = fs::remove_dir_all(agents_dir(dest).join(format!("{key}.view-{g}")));
        }
    }
}

// <key>.view -> <key>.view-<gen> by temp link and rename: a run reads a whole old view or a whole new one.
fn swap_view_link(dest: &Path, agent: &str, gen: u64) -> Result<(), String> {
    let key = crate::factory::agent_key(agent);
    let run = RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = agents_dir(dest).join(format!("{key}.view.tmp-{}-{run}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(format!("{key}.view-{gen}"), &tmp).map_err(|e| format!("write view link: {e}"))?;
    fs::rename(&tmp, agents_dir(dest).join(format!("{key}.view"))).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("publish view link: {e}")
    })
}

fn remove_record(dest: &Path, agent: &str, suffix: &str) {
    let _ = fs::remove_file(rec(dest, agent, suffix));
}

// The Reload click: builds the next view from the stored choice and writes `.skills-prepared`. Publishes nothing.
pub(crate) fn apply_in(dest: &Path, version_dir: &Path, agent: &str, role: Option<&str>, command: Option<&str>) -> Result<(), String> {
    let Some(role) = role.filter(|r| !r.is_empty()) else { return Err("the agent has no role".to_string()) };
    let state = list_in(dest, version_dir, agent, Some(role), command);
    if state.relaunch_needed {
        return Err(format!("Relaunch {agent} to apply: it was started without a skill view"));
    }
    let _lock = SkillsLock::take(dest, agent, "app", LOCK_WAIT)?;
    let inv = inventory(version_dir, role);
    let off: Vec<String> = read_off(dest, agent).into_iter().filter(|id| inv.contains(id)).collect();
    let gen = next_gen(dest, agent);
    let version = version_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if state.mode != "view" {
        // Plain or legacy, and every skill on: the launch flags name the agent link and already load everything, so there
        // is no build. The inventory is still refreshed: a version may have added a skill, and without a new record
        // every Reload would keep the old inventory and show that skill as "new" for good. The hub publishes this
        // record at the next relink (kind "inventory": no view swap).
        let prepared = json!({ "gen": gen, "off": [], "skills": inv, "kind": "inventory", "version": version });
        return write_atomic(&rec(dest, agent, ".skills-prepared"), &prepared.to_string());
    }
    build_view(dest, version_dir, agent, role, gen, &off)?;
    let prepared = json!({ "gen": gen, "off": off, "skills": inv, "kind": "view", "version": version });
    if let Err(e) = write_atomic(&rec(dest, agent, ".skills-prepared"), &prepared.to_string()) {
        let _ = fs::remove_dir_all(agents_dir(dest).join(format!("{}.view-{gen}", crate::factory::agent_key(agent))));
        return Err(e);
    }
    cleanup_views(dest, agent);
    Ok(())
}

// A role launch. An empty choice keeps the launch flags byte for byte (None) and writes the empty records. A choice
// with a skill off builds the view, publishes it and returns the view root the flags name.
pub(crate) fn launch_in(dest: &Path, version_dir: &Path, agent: &str, role: &str, version: &str) -> Result<Option<PathBuf>, String> {
    let _lock = SkillsLock::take(dest, agent, "app", LOCK_WAIT)?;
    let inv = inventory(version_dir, role);
    let off: Vec<String> = read_off(dest, agent).into_iter().filter(|id| inv.contains(id)).collect();
    let key = crate::factory::agent_key(agent);
    let (gen, root) = if off.is_empty() {
        (0, None)
    } else {
        let gen = next_gen(dest, agent);
        build_view(dest, version_dir, agent, role, gen, &off)?;
        swap_view_link(dest, agent, gen)?;
        (gen, Some(agents_dir(dest).join(format!("{key}.view"))))
    };
    let body = json!({ "version": version, "gen": gen, "off": off, "skills": inv }).to_string();
    write_atomic(&rec(dest, agent, ".skills-published"), &body)?;
    write_atomic(&rec(dest, agent, ".skills-applied"), &body)?;
    remove_record(dest, agent, ".skills-prepared");
    remove_record(dest, agent, ".skills-pending");
    cleanup_views(dest, agent);
    Ok(root)
}

// ---- Tauri commands ----
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("skills worker failed: {e}"))?
}

#[tauri::command]
pub async fn agent_skills(agent: String) -> Result<AgentSkills, String> {
    blocking(move || {
        let (role, command) = crate::pty::agent_role_and_command(&agent);
        Ok(list_in(&crate::factory::factory_dir(), &crate::factory::current_version_dir()?, &agent, role.as_deref(), command.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn agent_skills_set(agent: String, off: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let (role, _) = crate::pty::agent_role_and_command(&agent);
        let role = role.ok_or_else(|| "the agent has no role".to_string())?;
        set_off_in(&crate::factory::factory_dir(), &crate::factory::current_version_dir()?, &agent, &role, &off)
    })
    .await
}

#[tauri::command]
pub async fn agent_skills_apply(agent: String) -> Result<(), String> {
    blocking(move || {
        let (role, command) = crate::pty::agent_role_and_command(&agent);
        apply_in(&crate::factory::factory_dir(), &crate::factory::current_version_dir()?, &agent, role.as_deref(), command.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cubilot-skills-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    // A staged version: worker with skills a, b and shared with skill s; a plugin manifest in both.
    fn staged(root: &Path) -> (PathBuf, PathBuf) {
        let dest = root.join("factory");
        let v = dest.join("v-0000000000000001");
        for (g, skills) in [("worker", vec!["a", "b"]), ("shared", vec!["s"])] {
            fs::create_dir_all(v.join(g).join(".claude-plugin")).unwrap();
            fs::write(v.join(g).join(".claude-plugin/plugin.json"), format!("{{\"name\":\"factory-{g}\"}}")).unwrap();
            for s in skills {
                fs::create_dir_all(v.join(g).join("skills").join(s)).unwrap();
                fs::write(v.join(g).join("skills").join(s).join("SKILL.md"), s).unwrap();
            }
        }
        fs::write(v.join("worker/role.md"), "role").unwrap();
        fs::create_dir_all(v.join("worker/hooks")).unwrap();
        fs::write(v.join("worker/hooks/hooks.json"), "{}").unwrap();
        crate::factory::link_agent(&dest, "ag", "v-0000000000000001").unwrap();
        (dest, v)
    }

    fn ids(s: &AgentSkills) -> Vec<(String, bool, &'static str)> {
        s.groups.iter().flat_map(|g| g.skills.iter().map(|k| (k.id.clone(), k.on, k.state))).collect()
    }

    fn view_cmd(dest: &Path, agent: &str, with_view: bool) -> String {
        let key = crate::factory::agent_key(agent);
        let base = if with_view { format!("{}/agents/{key}.view", dest.display()) } else { format!("{}/agents/{key}", dest.display()) };
        format!("CHATBRIDGE_ROLE='worker' '/bin/pi' --no-skills --skill '{base}/worker/skills' --skill '{base}/shared/skills' -e '/e.js'")
    }

    #[test]
    fn a_role_less_agent_has_no_groups_and_a_legacy_agent_with_a_role_is_not_role_less() {
        let root = tmp("none");
        let (dest, v) = staged(&root);
        let none = list_in(&dest, &v, "ag", None, None);
        assert_eq!((none.role.clone(), none.mode, none.relaunch_needed, none.groups.len()), (None, "none", false, 0));
        let legacy = list_in(&dest, &v, "ag", Some("worker"), Some("'/bin/claude' --plugin-dir '/m'"));
        assert_eq!((legacy.role.as_deref(), legacy.mode), (Some("worker"), "legacy"));
        assert_eq!(legacy.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Role \u{b7} worker", "Shared"]);
        // no applied record: every skill is new
        assert!(ids(&legacy).iter().all(|(_, on, st)| *on && *st == "new"), "{:?}", ids(&legacy));
        assert!(list_in(&dest, &v, "ag", Some("worker"), None).mode == "legacy", "an unreadable command is legacy");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn states_come_only_from_the_applied_record() {
        let root = tmp("state");
        let (dest, v) = staged(&root);
        write_atomic(&rec(&dest, "ag", ".skills-applied"), r#"{"version":"x","gen":1,"off":["worker/b"],"skills":["worker/a","worker/b"]}"#).unwrap();
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        let l = list_in(&dest, &v, "ag", Some("worker"), Some(&view_cmd(&dest, "ag", true)));
        assert_eq!(
            ids(&l),
            vec![
                ("worker/a".into(), false, "loaded"),     // off in the store, still loaded: a change waits
                ("worker/b".into(), true, "not_loaded"),  // re-enabled, still not loaded
                ("shared/s".into(), true, "new"),         // not in the applied inventory
            ]
        );
        assert!(!l.relaunch_needed, "view mode never needs a relaunch");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relaunch_is_needed_for_the_first_uncheck_of_a_plain_or_legacy_agent_only() {
        let root = tmp("relaunch");
        let (dest, v) = staged(&root);
        let plain = view_cmd(&dest, "ag", false);
        assert!(!list_in(&dest, &v, "ag", Some("worker"), Some(&plain)).relaunch_needed, "nothing off");
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        let l = list_in(&dest, &v, "ag", Some("worker"), Some(&plain));
        assert_eq!((l.mode, l.relaunch_needed), ("plain", true));
        assert!(list_in(&dest, &v, "ag", Some("worker"), Some("'/bin/claude'")).relaunch_needed);
        assert!(!list_in(&dest, &v, "ag", Some("worker"), Some(&view_cmd(&dest, "ag", true))).relaunch_needed);
        // apply on such an agent returns the error and builds nothing
        let e = apply_in(&dest, &v, "ag", Some("worker"), Some(&plain)).unwrap_err();
        assert!(e.contains("Relaunch ag to apply"), "{e}");
        assert!(view_gens(&dest, "ag").is_empty() && !rec(&dest, "ag", ".skills-prepared").exists());
        let _ = fs::remove_dir_all(&root);
    }

    // Validator finding (C6b): a plain agent with every skill on must still refresh its inventory, or a skill that a new
    // version adds stays "new" through every Reload.
    #[test]
    fn a_plain_agent_with_every_skill_on_prepares_an_inventory_record_and_no_build() {
        let root = tmp("inventory");
        let (dest, v) = staged(&root);
        launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap();
        let cmd = view_cmd(&dest, "ag", false);
        // a new version adds worker/c
        fs::create_dir_all(v.join("worker/skills/c")).unwrap();
        apply_in(&dest, &v, "ag", Some("worker"), Some(&cmd)).unwrap();
        let prepared = read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap();
        assert_eq!((prepared["kind"].as_str(), prepared["gen"].as_u64(), strings(prepared.get("off"))), (Some("inventory"), Some(1), vec![]));
        assert!(strings(prepared.get("skills")).contains(&"worker/c".to_string()));
        assert!(view_gens(&dest, "ag").is_empty(), "no build and no view link for a plain agent");
        // a legacy agent too
        assert!(apply_in(&dest, &v, "ag", Some("worker"), Some("'/bin/claude'")).is_ok());
        assert_eq!(read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap()["gen"], 2);
        let _ = fs::remove_dir_all(&root);
    }

    // Validator suggestion: an id of an older role must not demand a relaunch.
    #[test]
    fn an_obsolete_role_id_in_the_store_does_not_set_relaunch_needed() {
        let root = tmp("obsolete");
        let (dest, v) = staged(&root);
        write_atomic(&rec(&dest, "ag", ".skills-off"), r#"["old-role/x"]"#).unwrap();
        let plain = view_cmd(&dest, "ag", false);
        assert!(!list_in(&dest, &v, "ag", Some("worker"), Some(&plain)).relaunch_needed);
        assert!(apply_in(&dest, &v, "ag", Some("worker"), Some(&plain)).is_ok(), "apply does not refuse");
        assert_eq!(strings(read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap().get("off")), Vec::<String>::new(), "the obsolete id is not carried");
        // a real id next to it still needs the relaunch
        write_atomic(&rec(&dest, "ag", ".skills-off"), r#"["old-role/x","worker/a"]"#).unwrap();
        assert!(list_in(&dest, &v, "ag", Some("worker"), Some(&plain)).relaunch_needed);
        let _ = fs::remove_dir_all(&root);
    }

    // C6-1 (Validator): the full plain reload. A plain agent with every skill on launches with the link flags and no view; a
    // version adds a skill; the click prepares an inventory record; the hub's publication and success report (simulated
    // here exactly as factory-skills.ts writes them) make the new skill `loaded`. No view exists at any point, and the flags
    // the launch gave are the same before and after.
    #[test]
    fn a_plain_agent_reload_makes_a_new_skill_loaded_with_no_view_and_the_same_flags() {
        let root = tmp("plain-reload");
        let (dest, v) = staged(&root);
        let key = crate::factory::agent_key("ag");
        let flags_before = view_cmd(&dest, "ag", false);
        assert_eq!(launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap(), None);
        fs::create_dir_all(v.join("worker/skills/c")).unwrap(); // the new version's skill
        let before = list_in(&dest, &v, "ag", Some("worker"), Some(&flags_before));
        assert_eq!(ids(&before).iter().find(|(i, _, _)| i == "worker/c").unwrap().2, "new");
        apply_in(&dest, &v, "ag", Some("worker"), Some(&flags_before)).unwrap();
        // the hub: publish the prepared record, copy it to pending, then to applied on the success report
        let prepared = read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap();
        assert_eq!(prepared["kind"], "inventory");
        let mut published = serde_json::json!({ "gen": prepared["gen"], "off": prepared["off"], "skills": prepared["skills"], "version": "v-0000000000000001" });
        write_atomic(&rec(&dest, "ag", ".skills-published"), &published.to_string()).unwrap();
        published["attempt"] = "a1".into();
        write_atomic(&rec(&dest, "ag", ".skills-pending"), &published.to_string()).unwrap();
        let applied = serde_json::json!({ "version": published["version"], "gen": published["gen"], "off": published["off"], "skills": published["skills"] });
        write_atomic(&rec(&dest, "ag", ".skills-applied"), &applied.to_string()).unwrap();
        let after = list_in(&dest, &v, "ag", Some("worker"), Some(&flags_before));
        assert_eq!(ids(&after).iter().find(|(i, _, _)| i == "worker/c").unwrap(), &("worker/c".to_string(), true, "loaded"));
        assert!(ids(&after).iter().all(|(_, on, st)| *on && *st == "loaded"));
        assert_eq!((after.mode, after.relaunch_needed), ("plain", false));
        assert!(view_gens(&dest, "ag").is_empty() && agents_dir(&dest).join(format!("{key}.view")).symlink_metadata().is_err(), "no view at any point");
        assert_eq!(view_cmd(&dest, "ag", false), flags_before, "the launch flags did not change");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mode_is_read_from_the_real_flag_values_only() {
        let root = tmp("mode");
        let (dest, _) = staged(&root);
        let key = crate::factory::agent_key("ag");
        let other = crate::factory::agent_key("other");
        let d = dest.display();
        let view = format!("{d}/agents/{key}.view");
        let link = format!("{d}/agents/{key}");
        let m = |c: &str| mode_from_command(c, &dest, "ag");
        assert_eq!(m(&format!("pi --skill '{view}/worker/skills' --skill '{view}/shared/skills'")), "view");
        assert_eq!(m(&format!("claude --plugin-dir '/m' --plugin-dir '{view}/worker' --plugin-dir '{view}/shared'")), "view");
        assert_eq!(m(&format!("pi --skill '{link}/worker/skills' --skill '{link}/shared/skills'")), "plain");
        // the view text in another place is no proof
        assert_eq!(m(&format!("pi --append-system-prompt '{view}/x' --skill '{link}/worker/skills'")), "plain");
        assert_eq!(m(&format!("CHATBRIDGE_ROOM='{view}/worker' pi --skill '{link}/worker/skills'")), "plain");
        assert_eq!(m(&format!("pi --append-system-prompt-file '{view}/role.md' --model x")), "legacy");
        assert_eq!(m(&format!("pi --append-system-prompt --skill '{view}/worker/skills'")), "legacy", "a value that looks like a flag");
        assert_eq!(m(&format!("pi 'a --skill {view}/worker/skills'")), "legacy", "one quoted argument");
        // another agent's view
        assert_eq!(m(&format!("pi --skill '{d}/agents/{other}.view/worker/skills'")), "legacy");
        // a path with a space and a quote is split right
        assert_eq!(m(&format!("pi --skill \"{view}/worker/skills\"")), "view");
        assert_eq!(m(&format!("pi --skill {}", view.replace(' ', "\\ ") + "/worker/skills")), "view");
        assert_eq!(m("pi --no-skills -e '/e.js'"), "legacy");
        assert_eq!(m(""), "legacy");
        assert_eq!(shell_words(r#"a 'b c' "d \" e" f\ g"#), ["a", "b c", "d \" e", "f g"]);
        let _ = fs::remove_dir_all(&root);
    }

    // The text tmux 3.5a prints for #{pane_start_command} (read from live panes skp-a and skc-a on install 23): the
    // whole one-argument command in one pair of double quotes. The earlier tests used the raw spawn text and missed it.
    #[test]
    fn mode_reads_the_real_tmux_pane_start_command_of_both_harnesses() {
        let dest = Path::new("/Users/mnw/Library/Application Support/Cubilot/factory");
        let app = "/Users/mnw/Library/Application Support/Cubilot";
        let pi = |key: &str, dir: &str| {
            format!(
                "\"PATH='/opt/homebrew/bin:/usr/bin' CHATBRIDGE_AGENT='skp-a' CHATBRIDGE_ROOM='cubilot' CHATBRIDGE_ROLE='validator' '/Users/mnw/Library/pnpm/bin/pi' --no-approve --no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt '{app}/factory/agents/{key}{dir}/validator/role.md' --skill '{app}/factory/agents/{key}{dir}/validator/skills' --skill '{app}/factory/agents/{key}{dir}/shared/skills' --provider 'openai-codex' --model 'gpt-5.6-sol' --thinking 'high' --exclude-tools 'edit,write,ack_permission' -e '/Applications/Cubilot.app/Contents/MacOS/../Resources/resources/pi-extension.js'\""
            )
        };
        let claude = |key: &str, dir: &str| {
            format!(
                "\"CHATBRIDGE_AGENT='skc-a' CHATBRIDGE_ROOM='cubilot' CHATBRIDGE_ROLE='worker' '/Users/mnw/.claude/local/claude' --plugin-dir '{app}/chatbridge-mod' --plugin-dir '{app}/factory/agents/{key}{dir}/worker' --plugin-dir '{app}/factory/agents/{key}{dir}/shared' --append-system-prompt-file '{app}/factory/agents/{key}{dir}/worker/role.md' --settings '{app}/factory-settings/skc-a.json' --model 'sonnet' --effort 'medium' --disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission' --allowed-tools 'mcp__chatbridge__post,mcp__chatbridge__list_tickets'\""
            )
        };
        assert_eq!(mode_from_command(&pi("736b702d61", ""), dest, "skp-a"), "plain");
        assert_eq!(mode_from_command(&pi("736b702d61", ".view"), dest, "skp-a"), "view");
        assert_eq!(mode_from_command(&pi("736b702d62", ""), dest, "skp-a"), "legacy", "the path of another agent");
        assert_eq!(mode_from_command(&pi("736b702d62", ".view"), dest, "skp-a"), "legacy", "the view of another agent");
        assert_eq!(mode_from_command(&claude("736b632d61", ""), dest, "skc-a"), "plain");
        assert_eq!(mode_from_command(&claude("736b632d61", ".view"), dest, "skc-a"), "view");
        assert_eq!(mode_from_command(&claude("736b632d62", ""), dest, "skc-a"), "legacy", "the path of another agent");
        assert_eq!(mode_from_command(&claude("736b632d62", ".view"), dest, "skc-a"), "legacy", "the view of another agent");
        // a legacy launch (no factory role) still reads as legacy
        assert_eq!(mode_from_command("\"CHATBRIDGE_AGENT='x' '/c' --plugin-dir '/m'\"", dest, "skc-a"), "legacy");
        // misleading quoted arguments in the tmux form stay legacy: the same negatives as the raw-text test
        let view = format!("{app}/factory/agents/736b702d61.view");
        let link = format!("{app}/factory/agents/736b702d61");
        let w = |inner: &str| format!("\"{inner}\"");
        assert_eq!(mode_from_command(&w(&format!("pi 'a --skill {view}/validator/skills'")), dest, "skp-a"), "legacy", "one quoted argument");
        assert_eq!(mode_from_command(&w(&format!("pi --append-system-prompt --skill '{view}/validator/skills'")), dest, "skp-a"), "legacy", "a value that looks like a flag");
        assert_eq!(mode_from_command(&w(&format!("pi --append-system-prompt-file '{view}/role.md' --model x")), dest, "skp-a"), "legacy", "the view in another argument");
        assert_eq!(mode_from_command(&w(&format!("CHATBRIDGE_ROOM='{view}/validator' pi --skill '{link}/validator/skills'")), dest, "skp-a"), "plain", "the view text in an env value is no proof");
        assert_eq!(mode_from_command(&w(&format!("'--skill {view}/validator/skills'")), dest, "skp-a"), "legacy", "the whole command is one quoted argument");
        assert_eq!(mode_from_command(&w(&format!("pi -e '--skill' '{view}/validator/skills'")), dest, "skp-a"), "legacy", "a value of -e");
    }

    #[test]
    fn set_refuses_an_unknown_id_deletes_the_file_for_an_empty_list_and_writes_mode_0600() {
        let root = tmp("set");
        let (dest, v) = staged(&root);
        let path = rec(&dest, "ag", ".skills-off");
        assert!(set_off_in(&dest, &v, "ag", "worker", &["worker/zzz".into()]).unwrap_err().contains("unknown skill"));
        assert!(!path.exists(), "nothing written");
        set_off_in(&dest, &v, "ag", "worker", &["shared/s".into(), "worker/a".into(), "worker/a".into()]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"["shared/s","worker/a"]"#, "sorted, no duplicates");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // a role change: an id of another role is refused by set, ignored by a build
        assert!(set_off_in(&dest, &v, "ag", "editor", &["worker/a".into()]).is_err());
        set_off_in(&dest, &v, "ag", "worker", &[]).unwrap();
        assert!(!path.exists());
        set_off_in(&dest, &v, "ag", "worker", &[]).unwrap(); // nothing to delete is fine
        // a failing write keeps the old file
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        let agents = agents_dir(&dest);
        fs::set_permissions(&agents, fs::Permissions::from_mode(0o500)).unwrap();
        let res = set_off_in(&dest, &v, "ag", "worker", &["worker/b".into()]);
        fs::set_permissions(&agents, fs::Permissions::from_mode(0o755)).unwrap();
        if res.is_ok() {
            eprintln!("(running as a user that ignores folder permissions: failing-write case not exercised)");
        } else {
            assert_eq!(fs::read_to_string(&path).unwrap(), r#"["worker/a"]"#);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_choice_survives_a_kill_and_the_x_button() {
        let root = tmp("survive");
        let (dest, v) = staged(&root);
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        crate::factory::clear_agent_records(&dest, "ag").unwrap();
        assert_eq!(read_off(&dest, "ag"), ["worker/a"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_with_an_empty_choice_is_unchanged_and_writes_the_empty_records() {
        let root = tmp("launch-empty");
        let (dest, v) = staged(&root);
        assert_eq!(launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap(), None);
        for s in [".skills-published", ".skills-applied"] {
            let j = read_json(&rec(&dest, "ag", s)).unwrap();
            assert_eq!((j["gen"].as_u64(), strings(j.get("off")), strings(j.get("skills"))), (Some(0), vec![], vec!["shared/s".to_string(), "worker/a".into(), "worker/b".into()]), "{s}");
        }
        assert!(view_gens(&dest, "ag").is_empty() && agents_dir(&dest).join(format!("{}.view", crate::factory::agent_key("ag"))).symlink_metadata().is_err());
        // an unknown id in the store is ignored by a launch and the store is not rewritten
        write_atomic(&rec(&dest, "ag", ".skills-off"), r#"["old-role/x"]"#).unwrap();
        assert_eq!(launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap(), None);
        assert_eq!(fs::read_to_string(rec(&dest, "ag", ".skills-off")).unwrap(), r#"["old-role/x"]"#);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_with_a_skill_off_builds_and_publishes_the_view_and_the_view_holds_only_what_is_on() {
        let root = tmp("launch-off");
        let (dest, v) = staged(&root);
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        let key = crate::factory::agent_key("ag");
        let view = launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap().unwrap();
        assert_eq!(view, agents_dir(&dest).join(format!("{key}.view")));
        assert_eq!(fs::read_link(&view).unwrap(), Path::new(&format!("{key}.view-1")));
        assert!(!view.join("worker/skills/a").exists() && view.join("worker/skills/b/SKILL.md").is_file());
        assert!(view.join("shared/skills/s/SKILL.md").is_file());
        // the targets go through the agent link; role.md and hooks are links; the manifest is a real copy
        assert_eq!(fs::read_link(view.join("worker/skills/b")).unwrap(), agents_dir(&dest).join(&key).join("worker/skills/b"));
        assert!(view.join("worker/role.md").symlink_metadata().unwrap().file_type().is_symlink() && view.join("worker/role.md").is_file());
        assert!(view.join("worker/hooks/hooks.json").is_file());
        let manifest = view.join("worker/.claude-plugin");
        assert!(manifest.symlink_metadata().unwrap().file_type().is_dir() && manifest.join("plugin.json").is_file());
        // the staged skill is still there for another agent of the role
        assert!(v.join("worker/skills/a/SKILL.md").is_file());
        let j = read_json(&rec(&dest, "ag", ".skills-applied")).unwrap();
        assert_eq!((j["gen"].as_u64(), strings(j.get("off"))), (Some(1), vec!["worker/a".to_string()]));
        // the list: view mode, a is off and not_loaded
        let l = list_in(&dest, &v, "ag", Some("worker"), Some(&view_cmd(&dest, "ag", true)));
        assert_eq!(ids(&l)[0], ("worker/a".into(), false, "not_loaded"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preparation_builds_without_publishing_and_a_newer_one_replaces_the_older_unpublished_build() {
        let root = tmp("prepare");
        let (dest, v) = staged(&root);
        let key = crate::factory::agent_key("ag");
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap(); // gen 1 published
        let cmd = view_cmd(&dest, "ag", true);
        let published_link = agents_dir(&dest).join(format!("{key}.view"));
        let before = fs::read_link(&published_link).unwrap();
        let published_rec = fs::read_to_string(rec(&dest, "ag", ".skills-published")).unwrap();
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into(), "worker/b".into()]).unwrap();
        apply_in(&dest, &v, "ag", Some("worker"), Some(&cmd)).unwrap();
        assert_eq!(fs::read_link(&published_link).unwrap(), before, "the published symlink is unchanged");
        assert_eq!(fs::read_to_string(rec(&dest, "ag", ".skills-published")).unwrap(), published_rec);
        assert_eq!(read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap()["gen"], 2);
        assert!(!agents_dir(&dest).join(format!("{key}.view-2/worker/skills/b")).exists());
        // all on again: a full view, prepared as gen 3; the unpublished gen 2 goes
        set_off_in(&dest, &v, "ag", "worker", &[]).unwrap();
        apply_in(&dest, &v, "ag", Some("worker"), Some(&cmd)).unwrap();
        assert_eq!(read_json(&rec(&dest, "ag", ".skills-prepared")).unwrap()["gen"], 3);
        let full = agents_dir(&dest).join(format!("{key}.view-3"));
        assert!(full.join("worker/skills/a").exists() && full.join("worker/skills/b").exists() && full.join("shared/skills/s").exists(), "all on: every skill");
        assert!(!agents_dir(&dest).join(format!("{key}.view-2")).exists(), "the older unpublished build is deleted");
        assert!(agents_dir(&dest).join(format!("{key}.view-1")).exists(), "the published build stays");
        // a failing build (the role folder is missing) leaves .skills-prepared as it was
        let prepared = fs::read_to_string(rec(&dest, "ag", ".skills-prepared")).unwrap();
        fs::rename(v.join("shared"), v.join("shared-away")).unwrap();
        assert!(apply_in(&dest, &v, "ag", Some("worker"), Some(&cmd)).is_err());
        fs::rename(v.join("shared-away"), v.join("shared")).unwrap();
        assert_eq!(fs::read_to_string(rec(&dest, "ag", ".skills-prepared")).unwrap(), prepared);
        // plain agent, everything on: apply is a no-op
        assert!(apply_in(&dest, &v, "ag", Some("worker"), Some(&view_cmd(&dest, "ag", false))).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    // The view is built from the REAL factory tree: nothing in the staged version changes, even when the view's
    // real folders are written to (Claude Code writes .claude-plugin/types, .gitignore, tsconfig.json there).
    #[test]
    fn a_view_of_the_real_staged_tree_leaves_every_staged_file_unchanged_when_the_view_is_written() {
        fn mtimes(dir: &Path, out: &mut Vec<(PathBuf, std::time::SystemTime)>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                let m = e.path().symlink_metadata().unwrap();
                out.push((e.path(), m.modified().unwrap()));
                if m.is_dir() {
                    mtimes(&e.path(), out);
                }
            }
        }
        let root = tmp("real");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let dest = root.join("out");
        let v = crate::factory::stage_factory(&src, &dest, &root.join("user")).unwrap();
        let vdir = dest.join(&v);
        crate::factory::link_agent(&dest, "w1", &v).unwrap();
        let first = skill_folders(&vdir, "worker").first().cloned().expect("the worker has skills");
        set_off_in(&dest, &vdir, "w1", "worker", &[format!("worker/{first}")]).unwrap();
        let hash = crate::factory::hash_tree(&vdir).unwrap();
        let mut before = Vec::new();
        mtimes(&vdir, &mut before);
        let view = launch_in(&dest, &vdir, "w1", "worker", &v).unwrap().unwrap();
        assert!(!view.join("worker/skills").join(&first).exists());
        assert_eq!(skill_folders(&vdir, "worker").len() - 1, fs::read_dir(view.join("worker/skills")).unwrap().count());
        // what Claude Code writes into a --plugin-dir
        for g in ["worker", "shared"] {
            fs::create_dir_all(view.join(g).join(".claude-plugin/types")).unwrap();
            fs::write(view.join(g).join(".claude-plugin/types/index.d.ts"), "x").unwrap();
            fs::write(view.join(g).join(".gitignore"), "x").unwrap();
            fs::write(view.join(g).join("tsconfig.json"), "{}").unwrap();
        }
        assert_eq!(crate::factory::hash_tree(&vdir).unwrap(), hash, "the staged version has the same hash");
        let mut after = Vec::new();
        mtimes(&vdir, &mut after);
        assert_eq!(before, after, "no staged file or folder has a new mtime");
        assert!(!vdir.join("worker/.claude-plugin/types").exists());
        let _ = fs::remove_dir_all(&root);
    }

    // ---- lock ----
    fn child_owner(holder: &str) -> (std::process::Child, String) {
        let c = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = c.id() as i32;
        let line = format!("{holder} {pid} {}", ps_start(pid).unwrap());
        (c, line)
    }

    fn set_lock(dest: &Path, agent: &str, line: Option<&str>) -> PathBuf {
        let dir = rec(dest, agent, ".skills-lock");
        fs::create_dir_all(&dir).unwrap();
        if let Some(l) = line {
            fs::write(dir.join("owner"), format!("{l}\n")).unwrap();
        }
        dir
    }

    #[test]
    fn a_lock_with_a_live_owner_is_never_taken_however_old() {
        let root = tmp("lock-live");
        let (dest, _) = staged(&root);
        let (mut child, line) = child_owner("hub");
        let dir = set_lock(&dest, "ag", Some(&line));
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        fs::File::open(&dir).unwrap().set_modified(old).unwrap();
        let t0 = Instant::now();
        let e = SkillsLock::take(&dest, "ag", "app", Duration::from_millis(300)).err().expect("busy");
        assert!(e.contains("busy") && t0.elapsed() < Duration::from_secs(2), "{e}");
        assert_eq!(fs::read_to_string(dir.join("owner")).unwrap().trim(), line, "the lock and its owner line are unchanged");
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lock_of_a_dead_pid_or_a_reused_pid_is_removed_and_taken() {
        let root = tmp("lock-dead");
        let (dest, _) = staged(&root);
        // a pid that is gone
        let (mut child, line) = child_owner("hub");
        let _ = child.kill();
        let _ = child.wait();
        set_lock(&dest, "ag", Some(&line));
        let l = SkillsLock::take(&dest, "ag", "app", Duration::from_secs(2)).expect("a dead owner's lock is taken");
        drop(l);
        assert!(!rec(&dest, "ag", ".skills-lock").exists(), "released");
        // a live pid with another start time (the pid was reused)
        let (mut child, _) = child_owner("hub");
        let reused = format!("hub {} Mon Jan  1 00:00:00 2001", child.id());
        set_lock(&dest, "ag", Some(&reused));
        assert!(SkillsLock::take(&dest, "ag", "app", Duration::from_secs(2)).is_ok());
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    // Validator (lock review): a start time that is not ps output cannot prove a reused pid.
    #[test]
    fn a_live_pid_with_a_garbage_start_time_is_not_a_dead_owner_and_its_lock_stays() {
        let root = tmp("lock-garbage");
        let (dest, _) = staged(&root);
        let (mut child, line) = child_owner("hub");
        let pid = child.id();
        assert!(!owner_dead(&format!("hub {pid} garbage")));
        assert!(!owner_dead(&format!("hub {pid} Mon Jan  1 00:00:0 2001")), "one digit short");
        assert!(!owner_dead(&format!("hub {pid} ")), "empty start");
        assert!(owner_dead(&format!("hub {pid} Mon Jan  1 00:00:00 2001")), "a well-formed start time that differs is a reused pid");
        assert!(!owner_dead(&line), "the real start time: alive");
        let dir = set_lock(&dest, "ag", Some(&format!("hub {pid} garbage")));
        assert!(SkillsLock::take(&dest, "ag", "app", Duration::from_millis(300)).is_err());
        assert_eq!(fs::read_to_string(dir.join("owner")).unwrap().trim(), format!("hub {pid} garbage"), "lock and owner line unchanged");
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    // Validator (lock review): a dead owner whose lock cannot be removed must not loop past the deadline.
    #[test]
    fn a_dead_owner_lock_that_cannot_be_removed_fails_at_the_deadline_and_does_not_loop() {
        let root = tmp("lock-stuck");
        let (dest, _) = staged(&root);
        let (mut child, line) = child_owner("hub");
        let _ = child.kill();
        let _ = child.wait();
        let dir = set_lock(&dest, "ag", Some(&line));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap(); // the owner file cannot be unlinked
        let t0 = Instant::now();
        let res = SkillsLock::take(&dest, "ag", "app", Duration::from_millis(400));
        let took = t0.elapsed();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        if res.is_ok() {
            eprintln!("(running as a user that ignores folder permissions: stuck-lock case not exercised)");
        } else {
            assert!(res.err().unwrap().contains("busy"));
            assert!(took >= Duration::from_millis(350) && took < Duration::from_secs(2), "returns at the deadline: {took:?}");
            assert!(dir.join("owner").exists(), "nothing was removed");
        }
        let _ = fs::remove_dir_all(&root);
    }

    // Validator (lock review 3): recovery must not delete a lock that another contender took after our read.
    // 1. Mid-recovery, under the guard, a second contender cannot recover or take the lock; it waits, and after the first
    //    one finishes it gets a lock whose owner file is intact.
    #[test]
    fn a_second_contender_cannot_act_while_a_recovery_is_between_its_check_and_its_removal() {
        let root = tmp("lock-recover-mid");
        let (dest, _) = staged(&root);
        let (mut dead, dead_line) = child_owner("hub");
        let _ = dead.kill();
        let _ = dead.wait();
        let (mut b_child, b_line) = child_owner("app");
        let (mut a_child, a_line) = child_owner("app");
        set_lock(&dest, "ag", Some(&dead_line));
        let dest2 = dest.clone();
        let b_line2 = b_line.clone();
        let inside = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let b_result: std::sync::Arc<std::sync::Mutex<Option<(Result<(), String>, bool)>>> = Default::default();
        let (inside2, b_result2) = (inside.clone(), b_result.clone());
        // The hook runs on thread A under the guard. It starts B and gives B time to try; B must still be waiting.
        let mine = rec(&dest, "ag", ".skills-lock");
        *RECOVERY_HOOK.lock().unwrap() = Some(Box::new(move |lock: &Path| {
            // Only this test's lock: other tests recover locks in parallel.
            if lock != mine || inside2.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let (d, l, r) = (dest2.clone(), b_line2.clone(), b_result2.clone());
            let h = std::thread::spawn(move || {
                let res = SkillsLock::take_as(&d, "ag", &l, Duration::from_secs(5));
                let own = fs::read_to_string(rec(&d, "ag", ".skills-lock").join("owner")).map(|t| t.trim() == l).unwrap_or(false);
                *r.lock().unwrap() = Some((res.map(|g| drop(g)), own));
            });
            std::thread::sleep(Duration::from_millis(300));
            assert!(b_result2.lock().unwrap().is_none(), "B acquired or gave up while A was inside the recovery");
            std::mem::forget(h);
        }));
        let a = SkillsLock::take_as(&dest, "ag", &a_line, Duration::from_secs(5)).expect("A recovers and takes the lock");
        *RECOVERY_HOOK.lock().unwrap() = None;
        assert_eq!(fs::read_to_string(rec(&dest, "ag", ".skills-lock").join("owner")).unwrap().trim(), a_line, "A's owner file is intact");
        drop(a);
        let deadline = Instant::now() + Duration::from_secs(5);
        while b_result.lock().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let got = b_result.lock().unwrap().take().expect("B finished");
        assert!(got.0.is_ok(), "B takes the lock after A releases: {:?}", got.0);
        assert!(got.1, "B's owner file was intact while B held the lock");
        for c in [&mut a_child, &mut b_child] {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = fs::remove_dir_all(&root);
    }

    // 2. Many contenders, each with its own live identity, recover one dead owner's lock and then keep taking it. At every
    //    moment at most one holds it, and the holder always finds its own owner line in the file.
    #[test]
    fn many_contenders_recovering_one_dead_lock_never_hold_it_together_or_lose_their_owner_file() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tmp("lock-stress");
        let (dest, _) = staged(&root);
        let (mut dead, dead_line) = child_owner("hub");
        let _ = dead.kill();
        let _ = dead.wait();
        set_lock(&dest, "ag", Some(&dead_line));
        let active = std::sync::Arc::new(AtomicUsize::new(0));
        let max = std::sync::Arc::new(AtomicUsize::new(0));
        let broken = std::sync::Arc::new(AtomicUsize::new(0));
        let mut kids = Vec::new();
        let mut threads = Vec::new();
        for _ in 0..6 {
            let (c, line) = child_owner("app");
            kids.push(c);
            let (dest, active, max, broken) = (dest.clone(), active.clone(), max.clone(), broken.clone());
            threads.push(std::thread::spawn(move || {
                for _ in 0..4 {
                    let g = SkillsLock::take_as(&dest, "ag", &line, Duration::from_secs(20)).expect("a contender gets the lock in time");
                    let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max.fetch_max(n, Ordering::SeqCst);
                    let owner = rec(&dest, "ag", ".skills-lock").join("owner");
                    for _ in 0..3 {
                        if fs::read_to_string(&owner).map(|t| t.trim() != line).unwrap_or(true) {
                            broken.fetch_add(1, Ordering::SeqCst);
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    drop(g);
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(max.load(Ordering::SeqCst), 1, "two holders at once");
        assert_eq!(broken.load(Ordering::SeqCst), 0, "a holder lost its owner file");
        for mut c in kids {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = fs::remove_dir_all(&root);
    }

    // C6-3 (Validator): recovery is serialised across the two implementations. Rust threads and `bun` processes (the hub's
    // takeLock) contend for one dead owner's lock, each with its own live identity, and log to one file. At any moment at most
    // one holds it, and every holder finds its own owner line while it holds. If `bun` is not found the test says so and
    // runs only the Rust contenders (a skip, reported on stderr).
    #[test]
    fn rust_and_hub_contenders_recovering_one_dead_lock_never_hold_it_together() {
        use std::io::Write as _;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tmp("lock-cross");
        let (dest, _) = staged(&root);
        let bun = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].iter().map(PathBuf::from).find(|p| p.is_file()).or_else(|| {
            std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("bun")).find(|f| f.is_file()))
        });
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/helpers/skills-lock-contender.ts");
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        if bun.is_none() {
            eprintln!("SKIPPED the hub half of the cross-implementation lock test: bun not found");
        }
        let (mut dead, dead_line) = child_owner("hub");
        let _ = dead.kill();
        let _ = dead.wait();
        set_lock(&dest, "ag", Some(&dead_line));
        let log = root.join("cross.log");
        fs::write(&log, "").unwrap();
        let key = crate::factory::agent_key("ag");
        let mut kids = Vec::new();
        let mut procs = Vec::new();
        if let Some(bun) = &bun {
            for _ in 0..3 {
                let (c, line) = child_owner("app");
                kids.push(c);
                procs.push(
                    std::process::Command::new(bun)
                        .current_dir(&repo)
                        .args(["run", helper.to_str().unwrap(), dest.to_str().unwrap(), &key, &line, "4", log.to_str().unwrap()])
                        .spawn()
                        .expect("start the hub contender"),
                );
            }
        }
        let broken = std::sync::Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..3 {
            let (c, line) = child_owner("app");
            kids.push(c);
            let (dest, log, broken) = (dest.clone(), log.clone(), broken.clone());
            threads.push(std::thread::spawn(move || {
                for _ in 0..4 {
                    let g = SkillsLock::take_as(&dest, "ag", &line, Duration::from_secs(60)).expect("a Rust contender gets the lock");
                    let mut f = fs::OpenOptions::new().append(true).open(&log).unwrap();
                    writeln!(f, "acquire {line}").unwrap();
                    let owner = rec(&dest, "ag", ".skills-lock").join("owner");
                    for _ in 0..3 {
                        if fs::read_to_string(&owner).map(|t| t.trim() != line).unwrap_or(true) {
                            broken.fetch_add(1, Ordering::SeqCst);
                            writeln!(f, "VIOLATION {line}").unwrap();
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    writeln!(f, "release {line}").unwrap();
                    drop(g);
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }
        for mut p in procs {
            assert!(p.wait().unwrap().success(), "a hub contender failed");
        }
        for mut c in kids {
            let _ = c.kill();
            let _ = c.wait();
        }
        let text = fs::read_to_string(&log).unwrap();
        assert_eq!(broken.load(Ordering::SeqCst), 0, "{text}");
        let (mut holder, mut acquires): (Option<String>, usize) = (None, 0);
        for l in text.lines() {
            let (ev, id) = l.split_once(' ').unwrap();
            match ev {
                "acquire" => {
                    assert!(holder.is_none(), "two holders at once: {l}");
                    holder = Some(id.to_string());
                    acquires += 1;
                }
                "release" => {
                    assert_eq!(holder.as_deref(), Some(id), "{l}");
                    holder = None;
                }
                other => panic!("{other}: {l}"),
            }
        }
        assert_eq!(acquires, if bun.is_some() { 24 } else { 12 });
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unparsable_owner_line_a_missing_owner_file_and_a_foreign_release_leave_the_lock() {
        let root = tmp("lock-unclear");
        let (dest, _) = staged(&root);
        for (tag, line) in [("garbage", Some("not a line")), ("holder", Some("who 1 x")), ("missing", None)] {
            let dir = set_lock(&dest, "ag", line);
            assert!(SkillsLock::take(&dest, "ag", "app", Duration::from_millis(200)).is_err(), "{tag}");
            assert!(dir.exists(), "{tag}: not removed");
            let _ = fs::remove_dir_all(&dir);
        }
        // a release by a process that is not the owner leaves the lock
        let l = SkillsLock::take(&dest, "ag", "app", Duration::from_secs(1)).unwrap();
        SkillsLock::release_as(&l.dir, "app 1 other");
        assert!(l.dir.join("owner").exists(), "a foreign release changed nothing");
        let dir = l.dir.clone();
        drop(l);
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preparation_waits_for_the_lock_and_errors_after_the_wait() {
        let root = tmp("lock-wait");
        let (dest, v) = staged(&root);
        set_off_in(&dest, &v, "ag", "worker", &["worker/a".into()]).unwrap();
        launch_in(&dest, &v, "ag", "worker", "v-0000000000000001").unwrap();
        let (mut child, line) = child_owner("hub");
        set_lock(&dest, "ag", Some(&line));
        let t0 = Instant::now();
        let cmd = view_cmd(&dest, "ag", true);
        let e = apply_in(&dest, &v, "ag", Some("worker"), Some(&cmd)).unwrap_err();
        assert!(e.contains("busy") && t0.elapsed() >= LOCK_WAIT, "{e} {:?}", t0.elapsed());
        assert!(view_gens(&dest, "ag").len() == 1, "no build made, none deleted");
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }
}
