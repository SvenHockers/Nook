// The Presentation Agent through the real service against the fake Claude in src/bin/nook-fixture.rs;
// no live account is used.
use nook::model::{Session, SessionEvent};
use nook::presentation::PresentRequest;
use nook::store::Store;
use nook::workspace::Service;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE: &str = env!("CARGO_BIN_EXE_nook-fixture");

struct Dir(PathBuf);
impl Dir {
    fn new() -> Dir {
        let p = std::env::temp_dir().join(format!("nook-it-{}", nook::model::id()));
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A database with one finished session, opened as a running service. Returns the sequence of each
/// event: you, agent (two chunks), completed.
fn service(dir: &Dir, provider: &str) -> (Arc<Service>, [i64; 4]) {
    let store = Store::open(&dir.0.join("nook.sqlite")).unwrap();
    let v = Session {
        id: "s1".into(),
        project_id: "p1".into(),
        provider: provider.into(),
        ..Default::default()
    };
    store.put_session(&v).unwrap();
    let mut seq = [0; 4];
    let events = [
        ("user", "u", "Fix the bug"),
        ("delta", "m", "Looking "),
        ("delta", "m", "at it"),
        ("completed", "", "Done"),
    ];
    for (i, (kind, item, text)) in events.into_iter().enumerate() {
        let mut e = SessionEvent {
            session_id: "s1".into(),
            kind: kind.into(),
            item_id: item.into(),
            text: text.into(),
            time: "t".into(),
            ..Default::default()
        };
        store.commit_event(&v, &mut e).unwrap();
        seq[i] = e.sequence;
    }
    store.close().unwrap();
    let s = Service::new(&dir.0, FIXTURE, None).unwrap();
    s.set_executable("claude", FIXTURE).unwrap();
    (s, seq)
}
fn req(revision: i64, focus: &str, arrange: bool) -> PresentRequest {
    PresentRequest {
        session_id: "s1".into(),
        revision,
        focus: focus.into(),
        arrange,
    }
}

#[test]
fn an_arranged_layout_is_validated_cached_and_bound_to_its_focus() {
    let dir = Dir::new();
    let (s, seq) = service(&dir, "claude");
    let r = s.present_session(req(seq[3], "", true)).unwrap();
    assert_eq!(
        (r.mode.as_str(), r.provider.as_str(), r.cached),
        ("model", "Claude Code", false),
        "{}",
        r.reason
    );
    // Records: you (seq 0), one agent message (seq 1), completed (seq 3). The fixture reverses them.
    assert_eq!(r.total, 3);
    let ids: Vec<_> = r
        .presentation
        .blocks
        .iter()
        .map(|b| b.evidence_id.clone())
        .collect();
    let want: Vec<_> = [seq[3], seq[1], seq[0]]
        .iter()
        .map(|n| format!("s1:{n}"))
        .collect();
    assert_eq!(ids, want);
    assert_eq!(r.presentation.blocks[0].kind, "Finding");
    assert_eq!(r.presentation.source.permission_scope, "local:p1:s1");
    let again = s.present_session(req(seq[3], "", true)).unwrap();
    assert!(again.cached, "the same view must not call the model twice");
    assert_eq!(again.presentation, r.presentation);
    let focused = s.present_session(req(seq[3], "errors only", true)).unwrap();
    assert!(!focused.cached, "a new focus is a new arrangement");
    s.close().unwrap();
}

#[test]
fn bad_replies_and_provider_errors_leave_the_standard_layout_with_a_reason() {
    let dir = Dir::new();
    let (s, seq) = service(&dir, "claude");
    let cases = [
        ("fixture:garbage", "did not return a layout"),
        ("fixture:unknown", "does not exist"),
        ("fixture:error", "usage limit"),
    ];
    for (focus, reason) in cases {
        let r = s.present_session(req(seq[3], focus, true)).unwrap();
        assert_eq!(r.mode, "standard", "{focus}");
        assert!(r.reason.contains(reason), "{focus}: {}", r.reason);
        assert_eq!(r.presentation.template_version, "deterministic-1");
        assert_eq!(r.presentation.blocks.len(), 3);
        assert!(!r.cached);
    }
    s.close().unwrap();
}

#[test]
fn views_are_bound_to_a_seen_revision_session_and_provider() {
    let dir = Dir::new();
    let (s, seq) = service(&dir, "claude");
    let standard = s.present_session(req(seq[3], "", false)).unwrap();
    assert_eq!(standard.mode, "standard");
    assert!(standard.reason.is_empty() && !standard.cached);
    assert_eq!(standard.source.revision, seq[3].to_string());
    let early = s.present_session(req(seq[1], "", false)).unwrap();
    assert_eq!(
        early.total, 2,
        "later events leaked into an earlier revision"
    );
    let e = s.present_session(req(seq[3] + 1, "", false)).unwrap_err();
    assert!(e.contains("revision"), "{e}");
    let missing = PresentRequest {
        session_id: "nope".into(),
        ..req(1, "", false)
    };
    assert!(s.present_session(missing).is_err());
    let e = s.present_session(req(seq[3], &"x".repeat(201), true));
    assert!(e.unwrap_err().contains("focus"));
    s.close().unwrap();

    let dir = Dir::new();
    let (s, seq) = service(&dir, "codex");
    let r = s.present_session(req(seq[3], "", true)).unwrap();
    assert_eq!(r.mode, "standard");
    assert!(r.reason.contains("Claude Code sessions"), "{}", r.reason);
    s.close().unwrap();
}

#[test]
fn cancelling_stops_a_running_arrangement_and_only_one_runs_per_session() {
    let dir = Dir::new();
    let (s, seq) = service(&dir, "claude");
    // Two requests race for the session; whichever registers second is refused, the other runs.
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let s = s.clone();
            thread::spawn(move || s.present_session(req(seq[3], "fixture:sleep", true)))
        })
        .collect();
    let start = Instant::now();
    // The refused request returns at once; only then is it certain the other one is the runner.
    while !workers.iter().any(|w| w.is_finished()) {
        thread::sleep(Duration::from_millis(20));
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "no request was refused"
        );
    }
    while !workers.iter().all(|w| w.is_finished()) {
        s.cancel_presentation("s1").unwrap();
        thread::sleep(Duration::from_millis(50));
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "cancel did not end the arrangement"
        );
    }
    let mut errors: Vec<String> = workers
        .into_iter()
        .map(|w| w.join().unwrap().unwrap_err())
        .collect();
    errors.sort();
    assert!(errors[0].contains("Already arranging"), "{errors:?}");
    assert!(errors[1].contains("cancelled"), "{errors:?}");
    s.close().unwrap();
}

#[test]
fn quitting_does_not_wait_for_a_model() {
    let dir = Dir::new();
    let (s, seq) = service(&dir, "claude");
    let worker = {
        let s = s.clone();
        thread::spawn(move || s.present_session(req(seq[3], "fixture:sleep", true)))
    };
    thread::sleep(Duration::from_millis(800));
    let start = Instant::now();
    s.close().unwrap();
    let e = worker.join().unwrap().unwrap_err();
    assert!(
        e.contains("cancelled") || e.contains("quitting"),
        "unexpected: {e}"
    );
    assert!(start.elapsed() < Duration::from_secs(20), "close waited");
}
