//! Real git and executable checks through the same IPC entry points as the desktop.
use nook::{
    ipc::{dispatch, Request},
    model::*,
    store::Store,
    workspace::Service,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Command,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
const FIXTURE: &str = env!("CARGO_BIN_EXE_nook-fixture");
struct Workspace {
    root: PathBuf,
    service: Arc<Service>,
}
impl Workspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nook-verification-{}", id()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Store::open(&root.join("nook.sqlite")).unwrap();
        db.put_project(&Project {
            id: "p".into(),
            path: root.to_string_lossy().into(),
            ..Default::default()
        })
        .unwrap();
        db.put_session(&Session {
            id: "s".into(),
            project_id: "p".into(),
            cwd: root.to_string_lossy().into(),
            state: COMPLETED.into(),
            ..Default::default()
        })
        .unwrap();
        db.close().unwrap();
        let service = Service::new(&root, "", None).unwrap();
        Self { root, service }
    }
    fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        dispatch(
            &self.service,
            &Request {
                method: method.into(),
                args,
                ..Default::default()
            },
        )
    }
    fn configure(&self, args: &[&str], timeout: u64, cap: usize) -> Value {
        let argv: Vec<_> = std::iter::once(FIXTURE)
            .chain(args.iter().copied())
            .collect();
        self.call(
            "ConfigureChecks",
            vec![
                json!("p"),
                json!([{"name":"Tests","argv":argv,"timeoutSeconds":timeout,"outputCap":cap}]),
            ],
        )
        .unwrap()
    }
    fn run(&self, config: &Value, confirm: bool) -> Result<Value, String> {
        self.call("RunCheck",vec![json!({"sessionId":"s","name":"Tests","revision":config["revision"],"confirm":confirm})])
    }
    fn finished(&self) -> CheckRun {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(run) = self
                .service
                .events("s", 0)
                .unwrap()
                .iter()
                .rev()
                .find_map(|e| e.check.as_ref())
                .filter(|c| !c.finished_at.is_empty())
            {
                return run.clone();
            }
            assert!(Instant::now() < deadline, "check did not finish");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = self.service.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked and closed.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == 259 // STILL_ACTIVE
    }
}
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn confirmation_exit_code_cap_and_configuration_revision() {
    let w = Workspace::new();
    let c = w.configure(&["verify", "7", "flood"], 5, 1000);
    assert!(w.run(&c, false).unwrap_err().contains("Confirm"));
    w.run(&c, true).unwrap();
    let r = w.finished();
    assert_eq!(r.exit_code, Some(7));
    assert!(r.truncated);
    assert!(r.output.len() <= 1000);
    let events = w.service.events("s", 0).unwrap();
    assert_eq!(events.len(), 2);
    assert!(events[0].sequence < events[1].sequence);
    assert_eq!(
        events[1].recorded[0].data,
        nook::presentation::EvidenceData::Tests {
            checks: vec![nook::presentation::Check {
                name: "Tests".into(),
                result: "failed".into()
            }]
        }
    );
    assert!(
        w.call("CheckConfiguration", vec![json!("p")]).unwrap()["approved"]
            .as_bool()
            .unwrap()
    );
    let next = w.configure(&["verify", "0"], 5, 1000);
    assert!(w.run(&c, true).unwrap_err().contains("changed"));
    assert!(w.run(&next, false).is_err());
    w.run(&next, true).unwrap();
    let r = w.finished();
    assert_eq!(r.exit_code, Some(0));
    assert!(r.output.contains("verification stderr"));
    assert!(r.output.contains(w.root.to_str().unwrap()));
}
#[test]
fn cancel_timeout_and_quit_finalize_checks() {
    for mode in ["cancel", "timeout", "quit"] {
        let w = Workspace::new();
        let c = w.configure(&["tree"], if mode == "timeout" { 1 } else { 30 }, 4096);
        w.run(&c, true).unwrap();
        assert!(w.run(&c, false).unwrap_err().contains("already running"));
        // Give the fixture time to create its child; existing process tests assert descendant death.
        thread::sleep(Duration::from_millis(100));
        if mode == "cancel" {
            w.call("CancelCheck", vec![json!("s")]).unwrap();
        }
        if mode == "quit" {
            w.service.close().unwrap();
            let reopened = Service::new(&w.root, "", None).unwrap();
            let events = reopened.events("s", 0).unwrap();
            assert_eq!(
                events.last().unwrap().check.as_ref().unwrap().outcome,
                "canceled"
            );
            assert_descendant_dead(events.last().unwrap().check.as_ref().unwrap());
            reopened.close().unwrap();
        } else {
            let run = w.finished();
            assert_descendant_dead(&run);
            assert_eq!(
                run.outcome,
                if mode == "timeout" {
                    "timed out"
                } else {
                    "canceled"
                }
            );
        }
    }
}
#[test]
fn interrupted_check_is_reconciled_on_restart() {
    let w = Workspace::new();
    w.service.close().unwrap();
    let db = Store::open(&w.root.join("nook.sqlite")).unwrap();
    let run = CheckRun {
        id: "interrupted".into(),
        outcome: "running".into(),
        ..Default::default()
    };
    db.set_setting("check.running.s", &serde_json::to_string(&run).unwrap())
        .unwrap();
    db.close().unwrap();
    let service = Service::new(&w.root, "", None).unwrap();
    let events = service.events("s", 0).unwrap();
    assert_eq!(
        events.last().unwrap().check.as_ref().unwrap().outcome,
        "interrupted"
    );
    service.close().unwrap();
}
#[test]
fn native_git_evidence_is_revision_bound() {
    let w = Workspace::new();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&w.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q"]);
    git(&["config", "user.name", "Fixture"]);
    git(&["config", "user.email", "fixture@example.invalid"]);
    std::fs::write(w.root.join("tracked.txt"), "old\n").unwrap();
    git(&["add", "tracked.txt"]);
    git(&["commit", "-qm", "Fixture"]);
    std::fs::write(w.root.join("tracked.txt"), "new\nsecond\n").unwrap();
    std::fs::write(w.root.join("untracked.txt"), "new\n").unwrap();
    w.call("CaptureEvidence", vec![json!("s")]).unwrap();
    let events = w.service.events("s", 0).unwrap();
    let revision = events.last().unwrap().sequence;
    let request = json!({"sessionId":"s","revision":revision,"arrange":false});
    let before = w.call("PresentSession", vec![request.clone()]).unwrap();
    assert!(before["presentation"]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["type"] == "FileChangeList"));
    assert!(before["presentation"]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["type"] == "CodeDiff"));
    let table = before["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["label"] == "Changed files")
        .unwrap();
    assert!(table["data"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r == &json!(["tracked.txt", " M", "2", "1"])));
    std::fs::write(w.root.join("tracked.txt"), "later\n").unwrap();
    let after = w.call("PresentSession", vec![request]).unwrap();
    assert_eq!(before["evidence"], after["evidence"]);
}

fn assert_descendant_dead(run: &CheckRun) {
    let pid: u32 = run.output.trim().parse().expect("fixture descendant PID");
    let until = Instant::now() + Duration::from_secs(3);
    while alive(pid) && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(pid), "check descendant survived: {pid}");
}

#[test]
fn invalid_configuration_and_missing_executable_fail_without_running() {
    let w = Workspace::new();
    for command in [
        json!({"name":"x","argv":[],"timeoutSeconds":1,"outputCap":1}),
        json!({"name":"x","argv":["x"],"timeoutSeconds":0,"outputCap":1}),
        json!({"name":"x","argv":["x"],"timeoutSeconds":1,"outputCap":1048577}),
    ] {
        assert!(w
            .call("ConfigureChecks", vec![json!("p"), json!([command])])
            .is_err());
    }
    let c = w.call("ConfigureChecks",vec![json!("p"),json!([{"name":"Tests","argv":["nook-nonexistent-check-executable"],"timeoutSeconds":1,"outputCap":1}])]).unwrap();
    assert!(w.run(&c, true).is_err());
    assert!(w.service.events("s", 0).unwrap().is_empty());
}
