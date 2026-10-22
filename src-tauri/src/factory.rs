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
// Marks a seeded copy in `factory-user/` (task 9.2): the hash of the bundled skill it was copied from. It is never
// staged and never part of a content hash.
const SEED_FILE: &str = ".cubilot-seed";
const SEED_TMP_PREFIX: &str = ".seed.tmp-";
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
        if name == ".DS_Store" || name == SEED_FILE {
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
                // A seeded copy that was not changed equals the bundled skill: nothing to report.
                if hash_tree(&target)? != hash_tree(&e.path())? {
                    log.push(format!("[factory] user skill replaces bundled skill: role={role} skill={name}"));
                }
                fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
            }
            copy_tree(&e.path(), &target)?;
        }
    }
    Ok(log)
}

// ---- Seeded copies (task 9.2) ----
// RENAME_EXCL: rename(2) replaces an existing EMPTY directory, so it cannot publish a seed safely. renamex_np with
// RENAME_EXCL fails with EEXIST when the destination exists, whatever it holds. Ok(true) = published.
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e));
    let (a, b) = (c(from)?, c(to)?);
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EEXIST) { Ok(false) } else { Err(err) }
}

// Copies each bundled skill folder of each role (and `shared`) into `<user>/<role>/skills/<name>/` when that folder
// does not exist. A folder that exists is never changed or deleted (a user edit can never be lost); an unchanged copy
// whose bundled skill has since changed gives one log line. Failures are logged, never fatal: staging goes on.
fn seed_user_skills(src: &Path, user: &Path, roles: &[String]) -> Vec<String> {
    let mut log = Vec::new();
    for role in roles {
        let bundled = src.join(role).join("skills");
        let Ok(rd) = fs::read_dir(&bundled) else { continue };
        let skills = user.join(role).join("skills");
        if let Err(e) = fs::create_dir_all(&skills) {
            log.push(format!("[factory] seed {role}: create {}: {e}", skills.display()));
            continue;
        }
        sweep_stale_seed_tmp(&skills);
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if !e.path().is_dir() || name.starts_with('.') {
                continue;
            }
            if let Err(msg) = seed_one(&e.path(), &skills, role, &name, &mut log) {
                log.push(format!("[factory] seed {role}/{name}: {msg}"));
            }
        }
    }
    log
}

fn seed_one(bundled: &Path, skills: &Path, role: &str, name: &str, log: &mut Vec<String>) -> Result<(), String> {
    let dest = skills.join(name);
    let bundled_hash = hash_tree(bundled)?;
    if fs::symlink_metadata(&dest).is_ok() {
        // Exists: never touched. One line when it is an unchanged copy and the bundled skill is newer.
        if let Ok(seed) = fs::read_to_string(dest.join(SEED_FILE)) {
            if seed.trim() != bundled_hash && hash_tree(&dest).ok().as_deref() == Some(seed.trim()) {
                log.push(format!(
                    "[factory] bundled skill {role}/{name} changed; your copy is unchanged. Delete the folder {} to get the new version.",
                    dest.display()
                ));
            }
        }
        return Ok(());
    }
    let run = STAGE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = skills.join(format!("{SEED_TMP_PREFIX}{}-{run}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    let built = copy_tree(bundled, &tmp).and_then(|_| fs::write(tmp.join(SEED_FILE), &bundled_hash).map_err(|e| e.to_string()));
    let published = built.and_then(|_| rename_no_replace(&tmp, &dest).map_err(|e| format!("publish: {e}")));
    match published {
        Ok(true) => Ok(()),
        // Another staging (or the user) was faster: keep theirs, delete only the own temp folder.
        Ok(false) => { let _ = fs::remove_dir_all(&tmp); Ok(()) }
        Err(e) => { let _ = fs::remove_dir_all(&tmp); Err(e) }
    }
}

// An interrupted staging leaves `.seed.tmp-<pid>-...`: removed when that process is gone. Never staged (dot name).
fn sweep_stale_seed_tmp(skills: &Path) {
    let Ok(entries) = fs::read_dir(skills) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(SEED_TMP_PREFIX) else { continue };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else { continue };
        if !super::pid_is_running(pid) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

// FNV-1a 64 over every file's relative path and bytes, in sorted order. Stable across Rust versions (unlike
// DefaultHasher), so one input set gives one `v-<hash>` across builds. Not a security hash; it names a folder.
fn hash_tree(root: &Path) -> Result<String, String> {
    fn walk(dir: &Path, rel: &Path, h: &mut u64) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if e.file_name() == SEED_FILE || e.file_name() == ".DS_Store" {
                continue;
            }
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
        for line in seed_user_skills(src, user, &names) {
            eprintln!("{line}");
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
    // `active` is the stable path launches name (hot reload): a symlink swapped by rename, so it never goes missing.
    let act_tmp = dest.join(format!("active.tmp-{}-{run}", std::process::id()));
    let _ = fs::remove_file(&act_tmp);
    std::os::unix::fs::symlink(&version, &act_tmp).map_err(|e| format!("write active: {e}"))?;
    fs::rename(&act_tmp, dest.join("active")).map_err(|e| {
        let _ = fs::remove_file(&act_tmp);
        format!("publish active: {e}")
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

// Env the hub gets (startup and reload_settings): where agent links live and the version they should reach.
// No version (staging failed): only the dir, so the hub offers no reload.
pub(crate) fn hub_factory_env(dir: &Path, version: &str) -> Vec<(&'static str, String)> {
    let mut env = vec![("CUBILOT_FACTORY_DIR", dir.to_string_lossy().into_owned())];
    if !version.is_empty() {
        env.push(("CUBILOT_FACTORY_VERSION", version.to_string()));
    }
    env
}

// A staging error is logged and gives no version; the hub restart goes on.
pub(crate) fn staged_version_or_log(staged: Result<String, String>, what: &str) -> String {
    staged.unwrap_or_else(|e| {
        eprintln!("[{what}] factory staging failed: {e}");
        String::new()
    })
}

pub(crate) fn materialize_factory() -> Result<String, String> {
    let version = stage_factory(&resolve_factory_src()?, &factory_dir(), &super::app_data_dir().join("factory-user"))?;
    for line in cleanup_versions(&factory_dir(), super::pty::live_tmux_state(), std::time::SystemTime::now()) {
        eprintln!("{line}");
    }
    Ok(version)
}

const CLEANUP_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

// `v-<16 hex>` names found anywhere in a text (the start commands of live panes: legacy launches name a version).
fn version_names_in(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    (0..b.len())
        .filter(|&i| b[i..].starts_with(b"v-") && b.len() >= i + 18 && b[i + 2..i + 18].iter().all(u8::is_ascii_hexdigit))
        .map(|i| text[i..i + 18].to_string())
        .collect()
}

// Delete what no launch can still use. `live` is (names of live tmux sessions, start commands of live panes), or the
// error of asking tmux. In use: `current`, `active`, any agent link, any version a live pane command names. An agent
// link whose session is gone, and older than CLEANUP_MIN_AGE, is deleted first, so it no longer holds its version. Unused versions younger than
// CLEANUP_MIN_AGE stay: a spawn may have read `current` just before a publish and not made its link yet. Any failed
// read deletes nothing. Returns the log lines.
pub(crate) fn cleanup_versions(dest: &Path, live: Result<(Vec<String>, String), String>, now: std::time::SystemTime) -> Vec<String> {
    let fail = |what: String| vec![format!("[factory] cleanup skipped, nothing deleted: {what}")];
    let (sessions, panes) = match live {
        Ok(l) => l,
        Err(e) => return fail(format!("tmux: {e}")),
    };
    let keys: std::collections::HashSet<String> = sessions.iter().map(|a| agent_key(a)).collect();
    let agents = dest.join("agents");
    let mut links: Vec<(PathBuf, String)> = Vec::new(); // (link, target version name)
    if agents.is_dir() {
        let entries = match fs::read_dir(&agents) {
            Ok(r) => r,
            Err(e) => return fail(format!("read {}: {e}", agents.display())),
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.contains(".tmp-") || AGENT_RECORD_SUFFIXES.iter().any(|x| name.ends_with(x)) {
                continue;
            }
            match fs::read_link(e.path()) {
                Ok(t) => links.push((e.path(), t.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())),
                Err(err) => return fail(format!("read link {}: {err}", e.path().display())),
            }
        }
    }
    let mut in_use: std::collections::HashSet<String> = version_names_in(&panes).into_iter().collect();
    match fs::read_to_string(dest.join("current")) {
        Ok(c) => { in_use.insert(c.trim().to_string()); }
        Err(e) => return fail(format!("read current: {e}")),
    }
    if dest.join("active").symlink_metadata().is_ok() {
        match fs::read_link(dest.join("active")) {
            Ok(t) => { in_use.extend(t.file_name().map(|n| n.to_string_lossy().into_owned())); }
            Err(e) => return fail(format!("read link active: {e}")),
        }
    }
    let mut log = Vec::new();
    for (link, target) in links {
        let key = link.file_name().unwrap().to_string_lossy().into_owned();
        // A link younger than the age rule may belong to a spawn whose tmux session does not exist yet.
        let young = link.symlink_metadata().and_then(|m| m.modified()).ok().and_then(|m| now.duration_since(m).ok()).is_none_or(|age| age < CLEANUP_MIN_AGE);
        if keys.contains(&key) || young {
            in_use.insert(target);
        } else if fs::remove_file(&link).is_ok() {
            for x in AGENT_RECORD_SUFFIXES {
                let _ = fs::remove_file(agents.join(format!("{key}{x}")));
            }
            log.push(format!("[factory] deleted agent link {key}: its session is gone"));
        }
    }
    let Ok(entries) = fs::read_dir(dest) else { return fail(format!("read {}", dest.display())) };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with("v-") || !e.path().is_dir() || in_use.contains(&name) {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= CLEANUP_MIN_AGE);
        if old && fs::remove_dir_all(e.path()).is_ok() {
            log.push(format!("[factory] deleted unused version {name}"));
        }
    }
    log
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

// The role on the harness the launch uses (task 9.4). The role's provider, model and thinking apply only on the
// role's own harness; on the other one they are dropped and the human's choice must supply the model. The tool
// limits are the role file's own list for the launch harness (every role file has both).
pub(crate) fn role_launch_on(spec: &RoleSpec, harness: &str, version_dir: &Path, settings: Option<PathBuf>) -> RoleLaunch {
    let own = spec.harness == harness;
    let plugin_dir = version_dir.join(&spec.name);
    RoleLaunch {
        name: spec.name.clone(),
        harness: harness.to_string(),
        prompt_file: plugin_dir.join("role.md"),
        plugin_dir,
        shared_dir: version_dir.join("shared"),
        settings,
        provider: spec.provider.clone().filter(|_| own),
        model: spec.model.clone().filter(|_| own),
        thinking: spec.thinking.clone().filter(|_| own),
        effort: None,
        disallowed_tools: spec.disallowed_tools.clone(),
        exclude_tools: spec.exclude_tools.clone(),
    }
}

// A launch on another harness than the role's has no default model: it needs one from the human, else nothing starts.
pub(crate) fn check_role_harness(spec: &RoleSpec, harness: &str, choice: &LaunchChoice) -> Result<(), String> {
    if spec.harness != harness && choice.model.is_none() {
        return Err(format!(
            "role '{}' runs on {} by default; to launch it on {harness} choose a model. Nothing was started.",
            spec.name, spec.harness
        ));
    }
    Ok(())
}

// Lowercase hex of the agent name's UTF-8 bytes: the key of an agent's link (same rule as the pty events).
pub(crate) fn agent_key(agent: &str) -> String {
    agent.bytes().map(|b| format!("{b:02x}")).collect()
}

// Records beside an agent link, named `<key><suffix>`: plain files, never read as links.
const AGENT_RECORD_SUFFIXES: [&str; 2] = [".applied", ".pending"];

// A new session starts with no record of an earlier agent of the same name: the link, `<key>.applied` and
// `<key>.pending` go (a pending record left by a crashed reload would otherwise block every later reload).
// Only a role launch makes them again (link_agent), so a role-less launch never hot-reloads.
pub(crate) fn clear_agent_records(dest: &Path, agent: &str) -> Result<(), String> {
    let key = agent_key(agent);
    for name in std::iter::once(key.clone()).chain(AGENT_RECORD_SUFFIXES.iter().map(|x| format!("{key}{x}"))) {
        let p = dest.join("agents").join(name);
        if p.symlink_metadata().is_ok() {
            fs::remove_file(&p).map_err(|e| format!("remove {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

// `<dest>/agents/<key>` -> `<dest>/<version>`, by temp link plus rename; `<key>.applied` records the launch version
// (what the runtime has loaded). Returns the link path.
pub(crate) fn link_agent(dest: &Path, agent: &str, version: &str) -> Result<PathBuf, String> {
    let dir = dest.join("agents");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let key = agent_key(agent);
    let run = STAGE_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = dir.join(format!("{key}.tmp-{}-{run}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(dest.join(version), &tmp).map_err(|e| format!("write agent link: {e}"))?;
    let link = dir.join(&key);
    fs::rename(&tmp, &link).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("publish agent link: {e}")
    })?;
    let applied_tmp = dir.join(format!("{key}.applied.tmp-{}-{run}", std::process::id()));
    fs::write(&applied_tmp, version).map_err(|e| format!("write applied: {e}"))?;
    fs::rename(&applied_tmp, dir.join(format!("{key}.applied"))).map_err(|e| {
        let _ = fs::remove_file(&applied_tmp);
        format!("publish applied: {e}")
    })?;
    Ok(link)
}

// A launch names `<link>/<role>`. If a staging swap makes the link miss for a moment, refuse: starting without the
// role's plugin and prompt is the failure we must not hide.
pub(crate) fn check_active_role(active: &Path, role: &str) -> Result<(), String> {
    if active.join(role).join("role.md").is_file() {
        Ok(())
    } else {
        Err("the factory is being staged: try the launch again".to_string())
    }
}

// IO side of a spawn: the role spec, the version `current` names, the choice applied for this one launch, and for a
// Claude launch this agent's settings file (project = cwd). `harness` is the launch harness (the modal decides).
pub(crate) fn resolve_role_launch(agent: &str, role: &str, cwd: &Path, harness: &str, choice: &LaunchChoice) -> Result<RoleLaunch, String> {
    let version_dir = current_version_dir()?;
    let spec = load_role_spec(role, &resolve_factory_src()?, &version_dir)?;
    // Launch flags name this agent's own link, not the version folder or the shared `active` link: only the hub
    // moves the agent link (at the agent's idle point), so a busy agent never reads files of a newer version.
    let dest = factory_dir();
    check_active_role(&dest.join("active"), role)?;
    let version = fs::read_to_string(dest.join("current")).map_err(|e| format!("factory/current: {e}"))?;
    let active = link_agent(&dest, agent, version.trim())?;
    check_active_role(&active, role)?;
    check_role_harness(&spec, harness, choice)?;
    let settings = if harness == "claude" {
        let user_claude = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?.join(".claude");
        Some(write_agent_settings(agent, role, cwd, &user_claude, &factory_settings_dir())?)
    } else {
        None
    };
    Ok(with_choice(role_launch_on(&spec, harness, &active, settings), choice))
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
    fn active_link_follows_the_newest_version_and_resolves_after_every_swap() {
        let root = tmp_root("active");
        let src = make_src(&root);
        let dest = root.join("out");
        let v1 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        assert_eq!(fs::read_link(dest.join("active")).unwrap(), PathBuf::from(&v1));
        assert!(dest.join("active/worker/role.md").is_file(), "the link resolves to a staged version");
        // Each swap renames over `active` (no delete-then-create): it resolves after every staging.
        // A concurrent reader can still see a brief ENOENT on macOS (symlink rename-over is not atomic to lookups,
        // measured ~1% of reads under a tight swap loop), so this test checks the sequence, not a racing reader.
        let mut v2 = v1.clone();
        for i in 0..40 {
            fs::write(src.join("worker/skills/tdd/SKILL.md"), format!("tdd {}", i % 2)).unwrap();
            v2 = stage_factory(&src, &dest, &root.join("user")).unwrap();
            assert!(dest.join("active/worker/role.md").is_file(), "active does not resolve after staging {i}");
        }
        assert_ne!(v1, v2);
        assert_eq!(fs::read_link(dest.join("active")).unwrap(), PathBuf::from(&v2), "active names the newest staging");
        assert_eq!(fs::read_to_string(dest.join("current")).unwrap(), v2, "current is kept");
        let leftovers = fs::read_dir(&dest).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("active.tmp-")).count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_is_refused_while_active_is_missing() {
        let root = tmp_root("active-missing");
        let src = make_src(&root);
        let dest = root.join("out");
        let err = check_active_role(&dest.join("active"), "worker").unwrap_err();
        assert_eq!(err, "the factory is being staged: try the launch again");
        stage_factory(&src, &dest, &root.join("user")).unwrap();
        assert!(check_active_role(&dest.join("active"), "worker").is_ok());
        assert!(check_active_role(&dest.join("active"), "nope").is_err(), "a role not under active is refused too");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_link_points_at_the_version_and_a_name_with_a_space_gives_the_hex_key() {
        let root = tmp_root("agent-link");
        let src = make_src(&root);
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let link = link_agent(&dest, "my agent", &v).unwrap();
        assert_eq!(link, dest.join("agents/6d79206167656e74"));
        assert_eq!(fs::read_link(&link).unwrap(), dest.join(&v));
        assert!(link.join("worker/role.md").is_file());
        // A second link for the same name moves it; another name is untouched.
        let other = link_agent(&dest, "b", &v).unwrap();
        fs::write(src.join("worker/skills/tdd/SKILL.md"), "v2").unwrap();
        let v2 = stage_factory(&src, &dest, &root.join("user")).unwrap();
        link_agent(&dest, "my agent", &v2).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), dest.join(&v2));
        assert_eq!(fs::read_link(&other).unwrap(), dest.join(&v));
        let tmps = fs::read_dir(dest.join("agents")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp-")).count();
        assert_eq!(tmps, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hub_env_carries_the_dir_and_the_version_and_a_failed_staging_gives_no_version() {
        let dir = Path::new("/app/factory");
        let env = hub_factory_env(dir, "v-abc");
        assert!(env.contains(&("CUBILOT_FACTORY_DIR", "/app/factory".to_string())));
        assert!(env.contains(&("CUBILOT_FACTORY_VERSION", "v-abc".to_string())));
        let env = hub_factory_env(dir, "");
        assert_eq!(env, vec![("CUBILOT_FACTORY_DIR", "/app/factory".to_string())]);
        assert_eq!(staged_version_or_log(Ok("v-1".into()), "reload"), "v-1");
        assert_eq!(staged_version_or_log(Err("boom".into()), "reload"), "", "an error does not stop the restart");
    }

    #[test]
    fn cleanup_keeps_what_is_in_use_and_deletes_old_unused_versions() {
        use std::time::{Duration, SystemTime};
        let root = tmp_root("cleanup");
        let dest = root.join("out");
        let mk = |n: &str| fs::create_dir_all(dest.join(n)).unwrap();
        let ver = |c: char| format!("v-{}", c.to_string().repeat(16));
        for c in ['a', 'b', 'c', 'd', 'e', 'f', '1'] {
            mk(&ver(c));
        }
        fs::write(dest.join("current"), ver('a')).unwrap();
        std::os::unix::fs::symlink(ver('b'), dest.join("active")).unwrap();
        fs::create_dir_all(dest.join("agents")).unwrap();
        std::os::unix::fs::symlink(dest.join(ver('c')), dest.join("agents").join(agent_key("live one"))).unwrap();
        std::os::unix::fs::symlink(dest.join(ver('f')), dest.join("agents").join(agent_key("dead one"))).unwrap();
        fs::write(dest.join("agents").join(format!("{}.applied", agent_key("dead one"))), ver('f')).unwrap();
        fs::write(dest.join("agents").join(format!("{}.applied", agent_key("live one"))), ver('c')).unwrap();
        let pane = format!("sh -c \"claude --plugin-dir /x/factory/{}/worker\"", ver('d'));
        let later = SystemTime::now() + Duration::from_secs(11 * 60);
        let live = || Ok((vec!["live one".to_string()], pane.clone()));
        // Too young: nothing goes, not even the link with no session (a spawn may not have its session yet).
        let log = cleanup_versions(&dest, live(), SystemTime::now());
        assert!(log.is_empty(), "{log:?}");
        assert!(dest.join("agents").join(agent_key("dead one")).symlink_metadata().is_ok(), "a young link with no session stays");
        assert!(dest.join("agents").join(format!("{}.applied", agent_key("dead one"))).exists());
        assert!(dest.join(ver('e')).is_dir() && dest.join(ver('f')).is_dir(), "younger than 10 minutes stays");
        // A failed tmux query deletes nothing.
        let log = cleanup_versions(&dest, Err("boom".into()), later);
        assert_eq!(log.len(), 1);
        assert!(dest.join(ver('e')).is_dir());
        // Old: current (a), active (b), agent link (c), pane command (d) stay. The old link with no session goes
        // with its .applied, so e, f and 1 go too (4 log lines).
        let log = cleanup_versions(&dest, live(), later);
        assert_eq!(log.len(), 4, "{log:?}");
        assert!(dest.join("agents").join(agent_key("dead one")).symlink_metadata().is_err());
        assert!(!dest.join("agents").join(format!("{}.applied", agent_key("dead one"))).exists(), "its .applied goes with it");
        assert!(dest.join("agents").join(format!("{}.applied", agent_key("live one"))).exists());
        for c in ['a', 'b', 'c', 'd'] {
            assert!(dest.join(ver(c)).is_dir(), "{c} is in use");
        }
        for c in ['e', 'f', '1'] {
            assert!(!dest.join(ver(c)).exists(), "{c} is unused");
        }
        // An unreadable link deletes nothing.
        mk(&ver('2'));
        fs::write(dest.join("agents").join("notalink"), "x").unwrap();
        let log = cleanup_versions(&dest, live(), later);
        assert_eq!(log.len(), 1);
        assert!(dest.join(ver('2')).is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_role_launch_writes_the_link_and_applied_and_a_new_session_clears_both() {
        let root = tmp_root("applied");
        let src = make_src(&root);
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let key = agent_key("a b");
        let applied = dest.join("agents").join(format!("{key}.applied"));
        link_agent(&dest, "a b", &v).unwrap();
        assert_eq!(fs::read_to_string(&applied).unwrap(), v, "applied holds the launch version");
        assert!(dest.join("agents").join(&key).symlink_metadata().is_ok());
        // A new session of the same name WITHOUT a role: only the clear runs, so nothing is left.
        clear_agent_records(&dest, "a b").unwrap();
        assert!(dest.join("agents").join(&key).symlink_metadata().is_err(), "no link");
        assert!(!applied.exists(), "no .applied");
        clear_agent_records(&dest, "a b").unwrap(); // nothing to clear is fine
        // Another agent is untouched.
        link_agent(&dest, "other", &v).unwrap();
        clear_agent_records(&dest, "a b").unwrap();
        assert!(dest.join("agents").join(agent_key("other")).symlink_metadata().is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_session_clears_link_applied_and_pending_and_a_reattach_keeps_them() {
        let root = tmp_root("pending");
        let src = make_src(&root);
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let key = agent_key("bob");
        let agents = dest.join("agents");
        link_agent(&dest, "bob", &v).unwrap();
        fs::write(agents.join(format!("{key}.pending")), &v).unwrap();
        let all = || (agents.join(&key).symlink_metadata().is_ok(), agents.join(format!("{key}.applied")).exists(), agents.join(format!("{key}.pending")).exists());
        // Re-attach never calls clear_agent_records (see agent_command): the three stay.
        assert_eq!(all(), (true, true, true));
        // A new same-name session (role-less, so nothing recreates them): none is left.
        clear_agent_records(&dest, "bob").unwrap();
        assert_eq!(all(), (false, false, false));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_ignores_a_pending_record_and_removes_it_with_a_stale_link() {
        use std::time::{Duration, SystemTime};
        let root = tmp_root("cleanup-pending");
        let src = make_src(&root);
        let dest = root.join("out");
        let v = stage_factory(&src, &dest, &root.join("user")).unwrap();
        let old = format!("v-{}", "2".repeat(16));
        fs::create_dir_all(dest.join(&old)).unwrap();
        let agents = dest.join("agents");
        link_agent(&dest, "bob", &v).unwrap();
        let key = agent_key("bob");
        fs::write(agents.join(format!("{key}.pending")), &v).unwrap();
        let later = SystemTime::now() + Duration::from_secs(11 * 60);
        // A live session with a pending record: the record is not read as a link, the old version goes.
        let log = cleanup_versions(&dest, Ok((vec!["bob".into()], String::new())), later);
        assert!(!dest.join(&old).exists(), "a pending record blocked the cleanup: {log:?}");
        assert!(agents.join(format!("{key}.pending")).exists(), "a live agent keeps its pending record");
        // Its session is gone and the link is old: link, .applied and .pending go together.
        let log = cleanup_versions(&dest, Ok((vec![], String::new())), later);
        assert!(agents.join(&key).symlink_metadata().is_err(), "{log:?}");
        assert!(!agents.join(format!("{key}.applied")).exists());
        assert!(!agents.join(format!("{key}.pending")).exists());
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
        // since 9.2 the first staging seeded a copy; the user replaces the whole folder
        assert!(user.join("worker/skills/tdd/extra.md").is_file(), "seeded");
        fs::remove_dir_all(user.join("worker/skills/tdd")).unwrap();
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

    // ---- Seeded copies (task 9.2, brief test 14) ----
    fn seed_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(d: &Path, rel: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let mut es: Vec<_> = fs::read_dir(d).unwrap().flatten().collect();
            es.sort_by_key(|e| e.file_name());
            for e in es {
                let r = rel.join(e.file_name());
                if e.path().is_dir() { out.push((format!("{}/", r.display()), vec![])); walk(&e.path(), &r, out); }
                else { out.push((r.display().to_string(), fs::read(e.path()).unwrap())); }
            }
        }
        let mut out = Vec::new();
        walk(dir, Path::new(""), &mut out);
        out
    }
    fn no_temp(user: &Path) {
        for e in fs::read_dir(user).unwrap().flatten() {
            let skills = e.path().join("skills");
            if let Ok(rd) = fs::read_dir(&skills) {
                for s in rd.flatten() { assert!(!s.file_name().to_string_lossy().starts_with('.'), "temp left: {}", s.path().display()); }
            }
        }
    }

    #[test]
    fn a_first_staging_seeds_every_bundled_skill_with_a_seed_marker_that_is_never_staged() {
        let root = tmp_root("seed-first");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        let v = stage_factory(&src, &dest, &user).unwrap();
        for (role, skill, body) in [("worker", "tdd", "tdd v1"), ("editor", "ste", "ste"), ("shared", "asd", "asd")] {
            let d = user.join(role).join("skills").join(skill);
            assert_eq!(fs::read_to_string(d.join("SKILL.md")).unwrap(), body, "{role}/{skill}");
            assert_eq!(fs::read_to_string(d.join(".cubilot-seed")).unwrap(), hash_tree(&src.join(role).join("skills").join(skill)).unwrap());
            assert!(!dest.join(&v).join(role).join("skills").join(skill).join(".cubilot-seed").exists(), "not staged");
        }
        no_temp(&user);
        // the seed marker is not part of the content hash: the same inputs without the markers give the same version
        let v_again = stage_factory(&src, &dest, &user).unwrap();
        assert_eq!(v, v_again);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_existing_empty_folder_is_preserved_not_replaced_by_the_publish_step() {
        let root = tmp_root("seed-empty");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        // the publish primitive itself refuses an existing empty directory (plain rename(2) would replace it)
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("f"), "x").unwrap();
        fs::create_dir_all(&b).unwrap();
        use std::os::unix::fs::MetadataExt;
        let (ino_a, ino_b) = (fs::metadata(&a).unwrap().ino(), fs::metadata(&b).unwrap().ino());
        assert_eq!(rename_no_replace(&a, &b).unwrap(), false);
        assert!(a.join("f").is_file() && fs::read_dir(&b).unwrap().count() == 0, "neither side changed");
        assert_eq!((fs::metadata(&a).unwrap().ino(), fs::metadata(&b).unwrap().ino()), (ino_a, ino_b), "the same folders, not replaced");
        // and a staging over an existing empty skill folder leaves it empty
        fs::create_dir_all(user.join("worker/skills/tdd")).unwrap();
        let ino = fs::metadata(user.join("worker/skills/tdd")).unwrap().ino();
        stage_factory(&src, &dest, &user).unwrap();
        assert_eq!(fs::read_dir(user.join("worker/skills/tdd")).unwrap().count(), 0, "kept empty");
        assert_eq!(fs::metadata(user.join("worker/skills/tdd")).unwrap().ino(), ino, "the same folder, not replaced by an empty one");
        no_temp(&user);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_staging_never_changes_an_existing_folder_and_logs_one_line_for_an_unchanged_stale_copy() {
        let root = tmp_root("seed-keep");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        stage_factory(&src, &dest, &user).unwrap();
        let tdd = user.join("worker/skills/tdd");
        let ste = user.join("editor/skills/ste");
        // 1: a changed copy; 2: a folder with no marker (made by hand); 3: an unchanged copy whose bundled skill changes
        fs::write(tdd.join("SKILL.md"), "my edit").unwrap();
        fs::remove_file(ste.join(".cubilot-seed")).unwrap();
        let before = (seed_files(&tdd), seed_files(&ste), seed_files(&user.join("shared/skills/asd")));
        fs::write(src.join("shared/skills/asd/SKILL.md"), "asd v2").unwrap();
        fs::write(src.join("worker/skills/tdd/SKILL.md"), "tdd v2").unwrap();
        fs::write(src.join("editor/skills/ste/SKILL.md"), "ste v2").unwrap();
        let log = seed_user_skills(&src, &user, &["worker".into(), "editor".into(), "shared".into()]);
        assert_eq!(log.len(), 1, "{log:?}");
        assert!(log[0].contains("shared/asd") && log[0].contains("Delete the folder"), "{log:?}");
        let after = (seed_files(&tdd), seed_files(&ste), seed_files(&user.join("shared/skills/asd")));
        assert_eq!(before, after, "byte for byte the same");
        // a deleted copy comes back with the current bundled skill
        fs::remove_dir_all(&tdd).unwrap();
        seed_user_skills(&src, &user, &["worker".into()]);
        assert_eq!(fs::read_to_string(tdd.join("SKILL.md")).unwrap(), "tdd v2");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_seeds_leave_one_complete_copy_and_no_temp_folder() {
        let root = tmp_root("seed-race");
        let src = make_src(&root);
        let user = root.join("user");
        let roles: Vec<String> = vec!["worker".into(), "editor".into(), "shared".into()];
        let hs: Vec<_> = (0..8)
            .map(|_| { let (s, u, r) = (src.clone(), user.clone(), roles.clone()); std::thread::spawn(move || seed_user_skills(&s, &u, &r)) })
            .collect();
        for h in hs { assert!(h.join().unwrap().iter().all(|l| !l.contains("seed ")), "no failure line"); }
        let d = user.join("worker/skills/tdd");
        assert_eq!(fs::read_to_string(d.join("SKILL.md")).unwrap(), "tdd v1");
        assert!(d.join(".cubilot-seed").is_file());
        no_temp(&user);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_temp_folder_left_by_an_interrupted_staging_is_not_staged_and_does_not_stop_the_seed() {
        let root = tmp_root("seed-leftover");
        let src = make_src(&root);
        let (dest, user) = (root.join("out"), root.join("user"));
        let left = user.join("worker/skills/.seed.tmp-2147483646-0-tdd");
        fs::create_dir_all(&left).unwrap();
        fs::write(left.join("SKILL.md"), "half").unwrap();
        let live = user.join("worker/skills/.seed.tmp-1-0-tdd"); // pid 1 runs: not ours to delete
        fs::create_dir_all(&live).unwrap();
        let v = stage_factory(&src, &dest, &user).unwrap();
        assert_eq!(fs::read_to_string(user.join("worker/skills/tdd/SKILL.md")).unwrap(), "tdd v1");
        assert!(!left.exists(), "a dead process's temp folder is swept");
        assert!(live.exists(), "a running process's temp folder is kept");
        let staged = fs::read_dir(dest.join(&v).join("worker/skills")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(staged, vec!["tdd".to_string()], "no temp folder staged");
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

    // Tool limits for both harnesses (task 9.3): the launch harness is the user's choice, so every single-agent
    // role file carries both keys. The read-only roles block the file tools on both harnesses.
    #[test]
    fn every_bundled_role_has_tool_limits_for_both_harnesses() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../factory");
        let mut seen = Vec::new();
        for e in fs::read_dir(&src).unwrap().flatten() {
            let role = e.file_name().to_string_lossy().to_string();
            let Ok(text) = fs::read_to_string(e.path().join(format!("{role}.md"))) else { continue };
            if frontmatter_value(&text, "council").is_some() { continue; }
            let (dis, exc) = (frontmatter_value(&text, "disallowedTools"), frontmatter_value(&text, "excludeTools"));
            assert!(dis.is_some() && exc.is_some(), "{role}: needs both disallowedTools and excludeTools");
            let (dis, exc) = (csv_list(dis), csv_list(exc));
            for t in ["Task", "Agent"] { assert!(dis.iter().any(|x| x == t), "{role}: disallowedTools lacks {t}"); }
            let read_only = ["orchestrator", "validator", "reviewer"].contains(&role.as_str());
            for t in ["Edit", "Write", "NotebookEdit"] { assert_eq!(dis.iter().any(|x| x == t), read_only, "{role}: {t}"); }
            for t in ["edit", "write"] { assert_eq!(exc.iter().any(|x| x == t), read_only, "{role}: {t}"); }
            seen.push(role);
        }
        seen.sort();
        assert_eq!(seen, ["editor", "orchestrator", "reviewer", "tester", "validator", "worker", "writer"]);
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
