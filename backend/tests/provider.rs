// Provider contracts against the fake agents in src/bin/nook-fixture.rs; no live account is used.
use nook::model::{ApprovalResponse, ProviderInfo, Session, SessionEvent};
use nook::provider::{self, Config};
use std::sync::{mpsc, Arc};
use std::time::Duration;

const FIXTURE: &str = env!("CARGO_BIN_EXE_nook-fixture");

fn config(id: &str, tx: mpsc::Sender<SessionEvent>) -> Config {
    Config {
        info: ProviderInfo {
            id: id.into(),
            path: FIXTURE.into(),
            ..Default::default()
        },
        session: Session {
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            ..Default::default()
        },
        emit: Arc::new(move |e| drop(tx.send(e))),
        helper: FIXTURE.into(),
    }
}
fn wait(rx: &mpsc::Receiver<SessionEvent>, kind: &str) -> SessionEvent {
    loop {
        let e = rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("timed out waiting for {kind}"));
        if e.kind == kind {
            return e;
        }
    }
}
fn accept(id: &str) -> ApprovalResponse {
    ApprovalResponse {
        request_id: id.into(),
        decision: "accept".into(),
        ..Default::default()
    }
}

#[test]
fn codex_concurrent_approvals_and_streaming() {
    let (tx, rx) = mpsc::channel();
    let rt = provider::start(config("codex", tx)).unwrap();
    rt.send("Hello").unwrap();
    let a = wait(&rx, "approval").approval.unwrap();
    let b = wait(&rx, "approval").approval.unwrap();
    assert_ne!(a.id, b.id, "request collision");
    for v in [&b, &a] {
        rt.respond(&accept(&v.id)).unwrap();
    }
    assert!(
        rt.respond(&accept(&a.id)).is_err(),
        "duplicate approval accepted"
    );
    let (x, y) = (wait(&rx, "delta"), wait(&rx, "delta"));
    assert_eq!(x.text + &y.text, "Hello world");
    wait(&rx, "completed");
    rt.stop();
}

#[test]
fn claude_bridge_and_resume() {
    let (tx, rx) = mpsc::channel();
    let rt = provider::start(config("claude", tx)).unwrap();
    for flag in ["--session-id", "--resume"] {
        rt.send("Hi").unwrap();
        let a = wait(&rx, "approval").approval.unwrap();
        rt.respond(&accept(&a.id)).unwrap();
        assert_eq!(
            wait(&rx, "delta").text,
            format!("Done {flag}"),
            "second turn must resume the first"
        );
        wait(&rx, "completed");
        wait(&rx, "process_clear");
    }
    rt.stop();
}

mod presenter {
    use super::FIXTURE;
    use nook::model::ProviderInfo;
    use nook::process::Child;
    use nook::provider;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn info(id: &str) -> ProviderInfo {
        ProviderInfo {
            id: id.into(),
            name: "Claude Code".into(),
            path: FIXTURE.into(),
            ..Default::default()
        }
    }
    fn prompt(focus: &str) -> String {
        format!(
            "FOCUS (from the user; may be empty): {}\n\nEVIDENCE:\n[{{\"id\":\"a\"}},{{\"id\":\"b\"}}]\n",
            serde_json::json!(focus)
        )
    }
    fn cwd() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }
    fn arrange(focus: &str, limit: Duration) -> Result<String, String> {
        provider::arrange(&info("claude"), &prompt(focus), &cwd(), limit, |_| true)
    }

    #[test]
    fn runs_tool_less_and_returns_the_reply() {
        // The fixture exits 5 unless it was started with --tools "" and --no-session-persistence.
        let text = arrange("", Duration::from_secs(10)).unwrap();
        assert!(text.contains(r#""evidenceId":"b""#), "{text}");
    }

    #[test]
    fn provider_errors_are_reported() {
        let e = arrange("fixture:error", Duration::from_secs(10)).unwrap_err();
        assert!(e.contains("429"), "{e}");
    }

    #[test]
    fn a_slow_model_times_out_and_is_killed() {
        let start = Instant::now();
        let e = arrange("fixture:sleep", Duration::from_millis(500)).unwrap_err();
        assert!(e.contains("too long"), "{e}");
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "process kept running"
        );
    }

    #[test]
    fn cancelling_stops_the_process() {
        let slot: Arc<Mutex<Option<Arc<Child>>>> = Arc::default();
        let canceller = {
            let slot = slot.clone();
            thread::spawn(move || loop {
                let child = slot.lock().unwrap().clone();
                if let Some(child) = child {
                    thread::sleep(Duration::from_millis(300));
                    return child.stop();
                }
                thread::sleep(Duration::from_millis(10));
            })
        };
        let start = Instant::now();
        let r = provider::arrange(
            &info("claude"),
            &prompt("fixture:sleep"),
            &cwd(),
            Duration::from_secs(60),
            |child| {
                *slot.lock().unwrap() = Some(child);
                true
            },
        );
        canceller.join().unwrap();
        assert!(r.is_err(), "a cancelled call returned a layout");
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "stop did not end the call"
        );
    }

    #[test]
    fn a_refused_attach_never_sends_the_prompt() {
        let r = provider::arrange(
            &info("claude"),
            &prompt("fixture:sleep"),
            &cwd(),
            Duration::from_secs(60),
            |_| false,
        );
        assert!(r.unwrap_err().contains("cancelled"));
    }

    #[test]
    fn only_claude_code_arranges() {
        let r = provider::arrange(
            &info("codex"),
            &prompt(""),
            &cwd(),
            Duration::from_secs(5),
            |_| true,
        );
        assert!(r.is_err());
    }
}
