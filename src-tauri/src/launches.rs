// The shell's side of the launch stream (stage-sessions 4.2). The hub never starts a process: it queues `launch` and
// `close` requests on GET /launches/stream. This file reads that stream, does the work with the existing session code
// (pty_spawn, close_session) and answers each request on POST /launches/<id>/ack. It decides nothing: the hub's stage
// logic decides what a launch is, and the shell never runs git.
//
// The stream and the acks go through `curl` with the token on stdin (`--config -`), so the token never shows in a
// process list. The Claude mod does the same for its hub calls. No session is ever killed on app exit.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{pty, HubInfo, HubState};

#[derive(Debug, PartialEq)]
pub enum Request {
    Launch { id: String, stage_id: String, session: String, role: String, room: String, harness: String, cwd: Option<String>, prompt: String },
    Close { id: String, session: String },
}

fn str_field(v: &Value, k: &str) -> Result<String, String> {
    v.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("missing {k}"))
}

/// One `data:` payload of the stream. The prompt and env are not read here: 4.3 writes the prompt file, and the shell
/// sets `CUBILOT_STAGE_ID` from `stage_id`.
pub fn parse_request(data: &str) -> Result<Request, String> {
    let v: Value = serde_json::from_str(data).map_err(|e| format!("bad json: {e}"))?;
    let id = str_field(&v, "id")?;
    match str_field(&v, "kind")?.as_str() {
        "launch" => Ok(Request::Launch {
            id,
            stage_id: str_field(&v, "stage_id")?,
            session: str_field(&v, "session")?,
            role: str_field(&v, "role")?,
            room: str_field(&v, "room")?,
            harness: str_field(&v, "harness")?,
            cwd: v.get("cwd").and_then(Value::as_str).map(str::to_string),
            // The ticket part of the first message (4.3). Empty for a launch that has none.
            prompt: v.get("prompt").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "close" => Ok(Request::Close { id, session: str_field(&v, "session")? }),
        other => Err(format!("unknown request kind: {other}")),
    }
}

/// The ack for a close: the session was killed, or it did not exist (`absent`, so the hub stops waiting), or tmux failed.
pub fn close_ack(outcome: Result<bool, String>) -> Value {
    match outcome {
        Ok(true) => json!({ "result": "spawned" }),
        Ok(false) => json!({ "result": "error", "error": "no such session", "absent": true }),
        Err(e) => json!({ "result": "error", "error": e }),
    }
}

fn launch_ack(outcome: Result<(), String>) -> Value {
    match outcome {
        Ok(()) => json!({ "result": "spawned" }),
        Err(e) => json!({ "result": "error", "error": e }),
    }
}

// A value inside a curl config file: double quotes with \ and " escaped, newlines as \n.
fn cfg_quote(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn curl_config(info: &HubInfo, path: &str, body: Option<&str>) -> String {
    let mut c = format!("url = {}\nheader = {}\n", cfg_quote(&format!("{}{}", info.url.trim_end_matches('/'), path)), cfg_quote(&format!("Authorization: Bearer {}", info.token)));
    if let Some(b) = body {
        c.push_str(&format!("header = \"Content-Type: application/json\"\ndata = {}\n", cfg_quote(b)));
    }
    c
}

fn curl(info: &HubInfo, path: &str, body: Option<&str>, stream: bool) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "--config", "-"]);
    if stream {
        cmd.arg("-N");
    } else {
        cmd.args(["--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}"]);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    child.stdin.take().expect("piped stdin").write_all(curl_config(info, path, body).as_bytes())?;
    Ok(child)
}

/// What one ack attempt got. Only `Retry` is tried again: the hub did not record the answer (no connection, a 5xx such
/// as "could not record the ack; send it again"). 2xx is done; any other status (409: the hub holds another answer, 404:
/// it does not know the request) will not change by asking again.
#[derive(Debug, PartialEq)]
pub enum AckTry {
    Done,
    Final(String),
    Retry(String),
}

fn classify(code: &str) -> AckTry {
    match code.trim().as_bytes().first() {
        Some(b'2') => AckTry::Done,
        Some(b'5') => AckTry::Retry(format!("hub answered {code}")),
        // curl prints 000 when it got no answer at all.
        _ if code.trim() == "000" || code.trim().is_empty() => AckTry::Retry("no answer from the hub".into()),
        _ => AckTry::Final(format!("hub answered {code}")),
    }
}

// The hub drops a launch that has no ack in 15 s, so the retries stay inside that time: 10 tries, 1 s apart.
const ACK_TRIES: u32 = 10;
const ACK_PAUSE: Duration = Duration::from_secs(1);

/// Sends the same answer until the hub records it. The outcome is kept by the caller: a lost ack must never make the
/// shell act again (a launch must not spawn a second time).
pub fn ack_with(mut send: impl FnMut() -> AckTry, tries: u32, pause: Duration, what: &str) -> bool {
    for n in 1..=tries {
        match send() {
            AckTry::Done => return true,
            AckTry::Final(why) => {
                eprintln!("[launches] {what}: {why}");
                return false;
            }
            AckTry::Retry(why) => {
                eprintln!("[launches] {what}: {why} (try {n} of {tries})");
                if n < tries {
                    std::thread::sleep(pause);
                }
            }
        }
    }
    false
}

fn ack_once(info: &HubInfo, id: &str, body: &Value) -> AckTry {
    let path = format!("/launches/{id}/ack");
    match curl(info, &path, Some(&body.to_string()), false).and_then(|c| c.wait_with_output()) {
        Ok(o) => classify(&String::from_utf8_lossy(&o.stdout)),
        Err(e) => AckTry::Retry(format!("curl failed: {e}")),
    }
}

/// Does the work once, then reports it. The work is never repeated because an ack failed.
pub fn run_and_ack<E>(work: impl FnOnce() -> Result<(), E>, mut send: impl FnMut(&Value) -> AckTry, tries: u32, pause: Duration, what: &str)
where
    E: std::fmt::Display,
{
    let body = launch_ack(work().map_err(|e| e.to_string()));
    ack_with(|| send(&body), tries, pause, what);
}

async fn launch(app: &AppHandle, r: Request) -> Result<(), String> {
    let Request::Launch { stage_id, session, role, room, harness, cwd, prompt, .. } = r else { unreachable!() };
    let cwd = cwd.ok_or("the launch has no working folder")?;
    pty::pty_spawn(
        app.clone(),
        app.state::<pty::PtyRegistry>(),
        session,
        cwd,
        None,
        Some(room),
        Some(harness),
        Some(role),
        None,
        None,
        None,
        None,
        Some(stage_id),
        Some(prompt),
    )
    .await
}

/// What the process knows about a close request id: it waits in the queue, or it ran and this is its ack body.
enum CloseSeen {
    Queued,
    Done(Value),
}

/// The one place that closes sessions. ONE worker for the whole process (never one per stream connection): after a
/// reconnect the hub sends again every close without an ack, and a second worker would run a close that the first one
/// still holds, or one that already completed and whose name was reused. The map of request id to outcome makes a
/// repeated id reuse the stored outcome: the session is killed once, only the ack is sent again.
pub struct Closer {
    tx: Sender<Request>,
    seen: Arc<Mutex<HashMap<String, CloseSeen>>>,
}

impl Closer {
    pub fn new(
        kill: impl Fn(&str) -> Result<bool, String> + Send + 'static,
        send_ack: impl Fn(&str, &Value) -> AckTry + Send + 'static,
        tries: u32,
        pause: Duration,
    ) -> Closer {
        let (tx, rx) = channel::<Request>();
        let seen: Arc<Mutex<HashMap<String, CloseSeen>>> = Arc::default();
        let map = seen.clone();
        std::thread::spawn(move || {
            for r in rx {
                let Request::Close { id, session } = r else { continue };
                let stored = match map.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
                    Some(CloseSeen::Done(b)) => Some(b.clone()),
                    _ => None,
                };
                let body = stored.unwrap_or_else(|| {
                    let outcome = kill(&session);
                    let b = close_ack(outcome.clone());
                    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
                    match outcome {
                        // Final: killed, or tmux says there is no such session. Never kill again for this id.
                        Ok(_) => { m.insert(id.clone(), CloseSeen::Done(b.clone())); }
                        // A tmux failure is not final: forget the id, so the hub's next request kills again.
                        Err(_) => { m.remove(&id); }
                    }
                    b
                });
                ack_with(|| send_ack(&id, &body), tries, pause, &format!("ack {id}"));
            }
        });
        Closer { tx, seen }
    }

    /// Queues a close unless the same id already waits in the queue. Returns at once.
    pub fn submit(&self, r: Request) {
        let Request::Close { ref id, .. } = r else { return };
        {
            let mut m = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(m.get(id), Some(CloseSeen::Queued)) {
                return; // already waiting: the hub's repeat adds nothing
            }
            m.entry(id.clone()).or_insert(CloseSeen::Queued);
        }
        if self.tx.send(r).is_err() {
            eprintln!("[launches] the close worker is gone");
        }
    }
}

// The hub address can change when the hub restarts; the single worker reads the newest one on every ack try.
static LATEST_HUB: Mutex<Option<HubInfo>> = Mutex::new(None);
static CLOSER: OnceLock<Closer> = OnceLock::new();

fn closer() -> &'static Closer {
    CLOSER.get_or_init(|| {
        Closer::new(
            pty::close_session,
            |id, body| match LATEST_HUB.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                Some(info) => ack_once(&info, id, body),
                None => AckTry::Retry("no hub address yet".into()),
            },
            ACK_TRIES,
            ACK_PAUSE,
        )
    })
}

/// Sends each request where it is handled, and returns at once: the stream reader must never wait. A close goes to the
/// process-wide close worker; a launch is started by `launch`, which does its own work off this thread.
fn route(r: Request, closer: &Closer, launch: impl FnOnce(Request)) {
    match r {
        Request::Close { .. } => closer.submit(r),
        Request::Launch { .. } => launch(r),
    }
}

fn start_launch(app: &AppHandle, info: &HubInfo, r: Request) {
    let Request::Launch { ref id, .. } = r else { return };
    let (app, info, id) = (app.clone(), info.clone(), id.clone());
    tauri::async_runtime::spawn(async move {
        // The launch runs once, here. Only its answer is sent again if the hub does not record it.
        let done = launch(&app, r).await;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            run_and_ack(|| done, |b| ack_once(&info, &id, b), ACK_TRIES, ACK_PAUSE, &format!("ack {id}"))
        })
        .await;
    });
}

/// Reads the stream until it ends. Returns when curl exits (hub down or restarting).
fn read_stream(app: &AppHandle, info: &HubInfo) {
    let Ok(mut child) = curl(info, "/launches/stream", None, true) else { return };
    let Some(out) = child.stdout.take() else { return };
    *LATEST_HUB.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.clone());
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        let Some(data) = line.strip_prefix("data: ") else { continue };
        match parse_request(data) {
            Ok(r) => route(r, closer(), |r| start_launch(app, info, r)),
            Err(e) => eprintln!("[launches] ignored a request: {e}"),
        }
    }
    let _ = child.wait();
}

/// Starts the reader thread. It reconnects for as long as the app runs: the hub sends again every request that has no ack.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let info = app.state::<HubState>().info.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(info) = info {
            read_stream(&app, &info);
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_launch_and_a_close() {
        let l = parse_request(r#"{"id":"l_1","kind":"launch","stage_id":"s_0123456789abcdef","session":"worker-1","role":"worker","room":"cubilot","harness":"claude","cwd":"/w","prompt":"p","env":{}}"#).unwrap();
        assert_eq!(l, Request::Launch { id: "l_1".into(), stage_id: "s_0123456789abcdef".into(), session: "worker-1".into(), role: "worker".into(), room: "cubilot".into(), harness: "claude".into(), cwd: Some("/w".into()), prompt: "p".into() });
        let c = parse_request(r#"{"id":"l_2","kind":"close","session":"worker-1"}"#).unwrap();
        assert_eq!(c, Request::Close { id: "l_2".into(), session: "worker-1".into() });
        assert!(parse_request(r#"{"id":"l_3","kind":"nope"}"#).is_err());
        assert!(parse_request("not json").is_err());
    }

    #[test]
    fn close_acks_say_killed_absent_or_failed() {
        assert_eq!(close_ack(Ok(true)), json!({ "result": "spawned" }));
        assert_eq!(close_ack(Ok(false))["absent"], json!(true));
        let f = close_ack(Err("tmux failed".into()));
        assert_eq!(f["result"], "error");
        assert!(f.get("absent").is_none(), "a tmux failure is not absence");
    }

    #[test]
    fn status_codes_are_sorted_into_done_final_and_retry() {
        assert_eq!(classify("200"), AckTry::Done);
        assert!(matches!(classify("500"), AckTry::Retry(_)));
        assert!(matches!(classify("000"), AckTry::Retry(_)));
        assert!(matches!(classify(""), AckTry::Retry(_)));
        assert!(matches!(classify("409"), AckTry::Final(_)));
        assert!(matches!(classify("404"), AckTry::Final(_)));
    }

    // The first ack fails (hub 500 or no connection), the second works: the launch work ran once, the answer is the same.
    #[test]
    fn a_failed_ack_is_sent_again_and_the_launch_does_not_run_twice() {
        let spawns = std::cell::Cell::new(0);
        let mut bodies: Vec<Value> = vec![];
        let mut answers = vec![AckTry::Retry("hub answered 500".into()), AckTry::Done].into_iter();
        run_and_ack(
            || { spawns.set(spawns.get() + 1); Ok::<(), String>(()) },
            |b| { bodies.push(b.clone()); answers.next().unwrap() },
            5,
            Duration::from_millis(1),
            "test",
        );
        assert_eq!(spawns.get(), 1);
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(bodies[0], json!({ "result": "spawned" }));
    }

    #[test]
    fn a_failed_launch_keeps_its_error_through_the_retries_and_a_final_answer_stops_them() {
        let mut bodies: Vec<Value> = vec![];
        let mut answers = vec![AckTry::Retry("x".into()), AckTry::Final("hub answered 409".into())].into_iter();
        run_and_ack(|| Err::<(), _>("no tmux"), |b| { bodies.push(b.clone()); answers.next().unwrap() }, 5, Duration::from_millis(1), "test");
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[1], json!({ "result": "error", "error": "no tmux" }));
        // a hub that never answers: the tries are limited
        let mut n = 0;
        assert!(!ack_with(|| { n += 1; AckTry::Retry("down".into()) }, 3, Duration::from_millis(1), "t"));
        assert_eq!(n, 3);
    }

    fn close_line(id: &str, session: &str) -> String {
        format!(r#"{{"id":"{id}","kind":"close","session":"{session}"}}"#)
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while !ok() {
            assert!(std::time::Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    // A tmux failure is not a result: the id is forgotten, the hub (which keeps the name reserved) sends the close
    // again, and the kill is retried. Only a final outcome is cached.
    #[test]
    fn a_temporary_kill_failure_is_retried_on_the_next_request_and_only_success_is_cached() {
        let kills: Arc<Mutex<Vec<String>>> = Arc::default();
        let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
        let k = kills.clone();
        let b = bodies.clone();
        let closer = Closer::new(
            move |s| {
                let mut v = k.lock().unwrap();
                v.push(s.to_string());
                if v.len() == 1 { Err("tmux unavailable".into()) } else { Ok(true) }
            },
            move |_, body| { b.lock().unwrap().push(body.clone()); AckTry::Done },
            3,
            Duration::from_millis(1),
        );
        closer.submit(parse_request(&close_line("l_A", "worker-1")).unwrap());
        wait_for("first ack", || bodies.lock().unwrap().len() == 1);
        assert_eq!(bodies.lock().unwrap()[0]["result"], "error");
        assert!(bodies.lock().unwrap()[0].get("absent").is_none(), "a failure is not absence");
        // the hub sends it again after a reconnect: the kill is tried again and works
        closer.submit(parse_request(&close_line("l_A", "worker-1")).unwrap());
        wait_for("second ack", || bodies.lock().unwrap().len() == 2);
        assert_eq!(bodies.lock().unwrap()[1], json!({ "result": "spawned" }));
        // later repeats only re-ack: no third kill
        closer.submit(parse_request(&close_line("l_A", "worker-1")).unwrap());
        wait_for("third ack", || bodies.lock().unwrap().len() == 3);
        assert_eq!(kills.lock().unwrap().len(), 2);
        assert_eq!(bodies.lock().unwrap()[2], json!({ "result": "spawned" }));
    }

    // A close whose ack keeps failing must not hold the stream reader: the launch behind it is read at once.
    #[test]
    fn a_slow_close_does_not_hold_back_the_launch_behind_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let open = Arc::new(AtomicBool::new(false));
        let o2 = open.clone();
        let closer = Closer::new(|_| Ok(true), move |_, _| if o2.load(Ordering::SeqCst) { AckTry::Done } else { AckTry::Retry("500".into()) }, 1000, Duration::from_millis(2));
        let mut launched: Vec<String> = vec![];
        let start = std::time::Instant::now();
        for data in [
            close_line("l_1", "worker-1"),
            r#"{"id":"l_2","kind":"launch","stage_id":"s_0123456789abcdef","session":"worker-2","role":"worker","room":"r","harness":"claude","cwd":"/w"}"#.to_string(),
        ] {
            route(parse_request(&data).unwrap(), &closer, |r| {
                if let Request::Launch { id, .. } = r { launched.push(id) }
            });
        }
        assert_eq!(launched, vec!["l_2".to_string()], "the launch is handled while the close ack is still open");
        assert!(start.elapsed() < Duration::from_millis(500));
        open.store(true, Ordering::SeqCst);
    }

    // Reconnect: the hub sends again every close without an ack. A queued close behind a slow ack must run once, and a
    // close that already ran must not run again (its name may be a new session by then).
    #[test]
    fn a_reconnect_does_not_run_a_close_twice() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let kills: Arc<Mutex<Vec<String>>> = Arc::default();
        let acked: Arc<Mutex<Vec<String>>> = Arc::default();
        let open_a = Arc::new(AtomicBool::new(false));
        let (k, a, oa) = (kills.clone(), acked.clone(), open_a.clone());
        let closer = Closer::new(
            move |s| { k.lock().unwrap().push(s.to_string()); Ok(true) },
            move |id, _| {
                if id == "l_A" && !oa.load(Ordering::SeqCst) {
                    return AckTry::Retry("hub answered 500".into());
                }
                a.lock().unwrap().push(id.to_string());
                AckTry::Done
            },
            100_000,
            Duration::from_millis(2),
        );
        // first connection: A is being acked (failing), B waits behind it
        closer.submit(parse_request(&close_line("l_A", "worker-1")).unwrap());
        closer.submit(parse_request(&close_line("l_B", "worker-2")).unwrap());
        wait_for("A ran", || kills.lock().unwrap().len() == 1);
        // reconnect: the hub sends both again
        closer.submit(parse_request(&close_line("l_A", "worker-1")).unwrap());
        closer.submit(parse_request(&close_line("l_B", "worker-2")).unwrap());
        open_a.store(true, Ordering::SeqCst);
        wait_for("both acked", || acked.lock().unwrap().contains(&"l_B".to_string()));
        // a late repeat of B after it completed: only the ack is sent again, no second kill
        closer.submit(parse_request(&close_line("l_B", "worker-2")).unwrap());
        wait_for("B acked again", || acked.lock().unwrap().iter().filter(|i| *i == "l_B").count() >= 2);
        assert_eq!(*kills.lock().unwrap(), vec!["worker-1".to_string(), "worker-2".to_string()]);
    }

    #[test]
    fn the_curl_config_holds_the_token_and_escapes_the_body() {
        let info = HubInfo { url: "http://127.0.0.1:1/".into(), token: "tok".into() };
        let c = curl_config(&info, "/launches/l_1/ack", Some(r#"{"error":"a \"b\""}"#));
        assert!(c.contains("url = \"http://127.0.0.1:1/launches/l_1/ack\""), "{c}");
        assert!(c.contains("Authorization: Bearer tok"));
        assert!(c.contains(r#"data = "{\"error\":\"a \\\"b\\\"\"}""#), "{c}");
    }
}
