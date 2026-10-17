//! Workflow commands through IPC and the real provider adapter, using only nook-fixture.
use nook::ipc::{dispatch, Request};
use nook::model::*;
use nook::store::Store;
use nook::workspace::Service;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("nook-workflow-{}", id()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn call(s: &Arc<Service>, method: &str, arg: Value) -> Value {
    dispatch(
        s,
        &Request {
            method: method.into(),
            args: vec![arg],
            ..Default::default()
        },
    )
    .unwrap()
}
fn workflow(s: &Arc<Service>) -> Workflow {
    s.snapshot().workflows[0].clone()
}
fn action(s: &Arc<Service>, task: &str) -> Value {
    let w = workflow(s);
    json!({"workflowId": w.id, "taskId": task, "revision": w.revision})
}
fn start(s: &Arc<Service>, task: &str) -> Session {
    serde_json::from_value(call(s, "StartWorkflowTask", action(s, task))).unwrap()
}
fn finish(s: &Arc<Service>, id: &str) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = s.snapshot();
        for a in snapshot.approvals.iter().filter(|a| a.session_id == id) {
            call(
                s,
                "Respond",
                json!({"sessionId": id, "requestId": a.id, "decision": "accept", "answers": {}}),
            );
        }
        let v = snapshot.sessions.iter().find(|v| v.id == id).unwrap();
        if v.state == COMPLETED {
            return;
        }
        assert!(!matches!(v.state.as_str(), FAILED | DISCONNECTED), "{v:?}");
        assert!(Instant::now() < until, "fixture did not complete: {v:?}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn accept(s: &Arc<Service>, task: &str) -> WorkflowArtifact {
    let a: WorkflowArtifact =
        serde_json::from_value(call(s, "WorkflowEvidence", action(s, task))).unwrap();
    let mut r = action(s, task);
    r["sourceRevision"] = a.revision.into();
    r["sourceCodeRevision"] = a.code_revision.clone().into();
    call(s, "AcceptWorkflowTask", r);
    serde_json::from_value(call(s, "WorkflowEvidence", action(s, task))).unwrap()
}
#[test]
fn three_tasks_reject_retry_bounded_handoffs_and_restart() {
    let dir = Dir::new();
    let project_dir = Dir::new();
    let fixture = env!("CARGO_BIN_EXE_nook-fixture");
    let s = Service::new(&dir.0, fixture, None).unwrap();
    s.set_executable("codex", fixture).unwrap();
    let p: Project = serde_json::from_value(call(&s, "AddProject", json!(project_dir.0))).unwrap();
    call(
        &s,
        "CreateWorkflow",
        json!({"projectId": p.id, "goal": "Deliver a reviewed release", "tasks": [
            {"id":"a", "title":"Build", "prompt":"Build A", "provider":"codex", "dependsOn":[]},
            {"id":"b", "title":"Review", "prompt":"Review B", "provider":"codex", "dependsOn":["a"]},
            {"id":"c", "title":"Verify", "prompt":"Verify C", "provider":"codex", "dependsOn":["b"]}
        ]}),
    );
    let a = start(&s, "a");
    finish(&s, &a.id);
    // Large recorded output stays in the audit but cannot make B/C unstartable.
    let store = Store::open(&dir.0.join("nook.sqlite")).unwrap();
    let v = s.session(&a.id).unwrap();
    for n in 0..90 {
        let mut e = event("delta", &format!("A evidence {n}: {}", "x".repeat(7000)));
        e.session_id = v.id.clone();
        e.item_id = format!("large-{n}");
        store.commit_event(&v, &mut e).unwrap();
    }
    store.close().unwrap();
    let frozen_a = accept(&s, "a");
    assert!(frozen_a.omitted_records > 0);
    assert!(frozen_a.handoff_bytes <= 48 * 1024);
    let b1 = start(&s, "b");
    finish(&s, &b1.id);
    let mut reject = action(&s, "b");
    reject["reason"] = "Include the missing edge case".into();
    call(&s, "RejectWorkflowTask", reject);
    let b2 = start(&s, "b");
    assert_ne!(b1.id, b2.id);
    finish(&s, &b2.id);
    let b_prompt = s
        .events(&b2.id, 0)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "user")
        .unwrap()
        .text;
    assert!(b_prompt.contains("Deliver a reviewed release"));
    assert!(b_prompt.contains("Include the missing edge case"));
    let frozen_b = accept(&s, "b");
    let c = start(&s, "c");
    // Quit while C is awaiting fixture approvals. Startup must not resume it implicitly.
    let until = Instant::now() + Duration::from_secs(5);
    while s.events(&c.id, 0).unwrap().is_empty() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    }
    s.close().unwrap();
    let s = Service::new(&dir.0, fixture, None).unwrap();
    let w = workflow(&s);
    assert_eq!(w.tasks[1].attempts.len(), 2);
    assert_eq!(w.tasks[1].attempts[0].outcome, "rejected");
    assert_eq!(w.tasks[1].attempts[1].outcome, "accepted");
    assert_eq!(s.session(&c.id).unwrap().state, STOPPED);
    let prompt = s
        .events(&c.id, 0)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "user")
        .unwrap()
        .text;
    assert!(prompt.len() < 256 * 1024);
    assert!(prompt.contains("Deliver a reviewed release"));
    assert!(prompt.contains(&frozen_a.id) && prompt.contains(&frozen_b.id));
    assert!(prompt.contains("Older records omitted"));
    let still_a: WorkflowArtifact =
        serde_json::from_value(call(&s, "WorkflowEvidence", action(&s, "a"))).unwrap();
    assert_eq!(still_a, frozen_a);
    let mut reject = action(&s, "c");
    reject["reason"] = "Retry after restart".into();
    call(&s, "RejectWorkflowTask", reject);
    let c2 = start(&s, "c");
    finish(&s, &c2.id);
    accept(&s, "c");
    assert_eq!(workflow(&s).state, "completed");
    call(&s, "ArchiveWorkflow", action(&s, ""));
    s.close().unwrap();
    let s = Service::new(&dir.0, fixture, None).unwrap();
    assert!(workflow(&s).archived);
    assert_eq!(workflow(&s).tasks[2].attempts.len(), 2);
    s.close().unwrap();
}

#[test]
fn cancel_stops_fixture_and_cannot_be_resumed_or_started() {
    let dir = Dir::new();
    let project_dir = Dir::new();
    let fixture = env!("CARGO_BIN_EXE_nook-fixture");
    let s = Service::new(&dir.0, fixture, None).unwrap();
    s.set_executable("codex", fixture).unwrap();
    let p: Project = serde_json::from_value(call(&s, "AddProject", json!(project_dir.0))).unwrap();
    call(
        &s,
        "CreateWorkflow",
        json!({"projectId":p.id,"goal":"Cancel fixture", "tasks":[{"id":"a","title":"Wait","prompt":"Wait for approval", "provider":"codex","dependsOn":[]}]}),
    );
    let session = start(&s, "a");
    let deadline = Instant::now() + Duration::from_secs(5);
    while s.snapshot().approvals.is_empty() {
        assert!(
            Instant::now() < deadline,
            "Fixture never requested approval"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let running = s.session(&session.id).unwrap();
    assert!(running.process_id > 0);
    call(&s, "CancelWorkflow", action(&s, ""));
    assert_ne!(
        nook::process::identity(running.process_id as u32).ok(),
        Some(running.process_birth)
    );
    assert_eq!(s.session(&session.id).unwrap().state, STOPPED);
    assert!(s.snapshot().approvals.is_empty());
    assert_eq!(workflow(&s).state, "canceled");
    assert!(s.send(&session.id, "resume").is_err());
    assert!(dispatch(
        &s,
        &Request {
            method: "StartWorkflowTask".into(),
            args: vec![action(&s, "a")],
            ..Default::default()
        }
    )
    .is_err());
    s.close().unwrap();
}

/// Opt-in real-provider gate. No tools are approved and no repository contents are sent.
#[test]
#[ignore = "uses the installed Codex account; run explicitly for live validation"]
fn live_codex_two_task_workflow() {
    let dir = Dir::new();
    let project_dir = Dir::new();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Nook validation",
            "-c",
            "user.email=validation@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Validation baseline",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&project_dir.0)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    let s = Service::new(&dir.0, "", None).unwrap();
    let provider = s
        .snapshot()
        .providers
        .into_iter()
        .find(|p| p.id == "codex")
        .unwrap();
    assert!(provider.available, "Codex unavailable: {provider:?}");
    println!("Live provider: {} {}", provider.name, provider.version);
    let p: Project = serde_json::from_value(call(&s, "AddProject", json!(project_dir.0))).unwrap();
    call(
        &s,
        "CreateWorkflow",
        json!({"projectId": p.id, "goal": "Validate a two-task handoff without using tools or changing files", "tasks": [
            {"id":"a","title":"Produce marker","provider":"codex","dependsOn":[],"prompt":"This is a connection validation. Do not use any tools or inspect files. Reply with exactly NOOK_HANDOFF_ALPHA."},
            {"id":"b","title":"Read marker","provider":"codex","dependsOn":["a"],"prompt":"This is a handoff validation. Do not use any tools or inspect files. Reply with the exact marker the upstream agent returned. Return only that marker."}
        ]}),
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for task in ["a", "b"] {
            let v = start(&s, task);
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                let snap = s.snapshot();
                assert!(
                    snap.approvals.is_empty(),
                    "Live check requested approval; no tools will be approved"
                );
                let session = snap.sessions.iter().find(|s| s.id == v.id).unwrap();
                assert!(
                    !matches!(session.state.as_str(), FAILED | DISCONNECTED),
                    "Provider failed: {}",
                    session.error
                );
                if session.state == COMPLETED {
                    break;
                }
                assert!(Instant::now() < deadline, "Live provider timed out");
                thread::sleep(Duration::from_millis(100));
            }
            let output: String = s
                .events(&v.id, 0)
                .unwrap()
                .into_iter()
                .filter(|e| e.kind == "delta")
                .map(|e| e.text)
                .collect();
            assert_eq!(output.trim(), "NOOK_HANDOFF_ALPHA");
            let a = accept(&s, task);
            assert!(!a.head_commit.is_empty());
            assert!(a.changes.as_ref().unwrap().diff.is_empty());
            println!("Task {task}: completed, exact marker verified, code snapshot inspected, accepted at revision {} ({} handoff bytes)", a.revision, a.handoff_bytes);
        }
        assert_eq!(workflow(&s).state, "completed");
    }));
    s.close().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
