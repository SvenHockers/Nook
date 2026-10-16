//! Codex: the installed `codex app-server` speaking JSON-RPC over stdio.
use super::{explain_error, o, questions, s, Config, Runtime};
use crate::model::{event, id, ApprovalRequest, ApprovalResponse, SessionEvent};
use crate::{lock, process, read_line, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufReader;
use std::process::ChildStdout;
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub(super) struct Codex {
    c: Config,
    child: Arc<process::Child>,
    st: Mutex<State>,
}
#[derive(Default)]
struct State {
    next: u64,
    calls: HashMap<String, SyncSender<Value>>,
    approvals: HashMap<String, Pending>,
    thread: String,
    turn: String,
    closed: bool,
}
struct Pending {
    wire_id: Value,
    method: String,
}

pub(super) fn start(c: Config) -> Res<Arc<Codex>> {
    let args = ["app-server", "--listen", "stdio://"].map(String::from);
    let (child, stdout) = process::start(&c.info.path, &args, &c.session.cwd, &[])?;
    let r = Arc::new(Codex {
        c,
        child,
        st: Mutex::default(),
    });
    let reader = r.clone();
    thread::spawn(move || reader.read(stdout));
    let fail = |e: String| {
        r.stop();
        Err(e)
    };
    let birth = match process::identity(r.child.pid) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    (r.c.emit)(event(
        "process",
        &json!({"pid": r.child.pid, "birth": birth}).to_string(),
    ));
    if let Err(e) = r.call(
        "initialize",
        json!({"clientInfo": {"name": "nook", "version": "0.1.0"}, "capabilities": {}}),
    ) {
        return fail(format!("Codex initialization failed: {e}"));
    }
    if let Err(e) = r.write(json!({"method": "initialized"})) {
        return fail(e);
    }
    let mut params = json!({"cwd": r.c.session.cwd});
    let method = if r.c.session.provider_id.is_empty() {
        "thread/start"
    } else {
        params["threadId"] = r.c.session.provider_id.clone().into();
        "thread/resume"
    };
    let thread = match r.call(method, params) {
        Ok(v) => s(o(&v, "thread"), "id").to_string(),
        Err(e) => return fail(e),
    };
    if thread.is_empty() {
        return fail("Codex returned no thread ID".into());
    }
    lock(&r.st).thread = thread.clone();
    (r.c.emit)(event("provider_id", &thread));
    Ok(r)
}

impl Codex {
    fn write(&self, v: Value) -> Res<()> {
        self.child.write((v.to_string() + "\n").as_bytes())
    }
    fn call(&self, method: &str, params: Value) -> Res<Value> {
        let (tx, rx) = sync_channel(1);
        let n = {
            let mut st = lock(&self.st);
            if st.closed {
                return Err("Codex disconnected".into());
            }
            st.next += 1;
            let n = st.next;
            st.calls.insert(n.to_string(), tx);
            n
        };
        let result = self
            .write(json!({"id": n, "method": method, "params": params}))
            .and_then(|()| match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(m) => match m.get("error").filter(|e| !e.is_null()) {
                    Some(e) => Err(format!("Codex: {e}")),
                    None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
                },
                // The reader drops every pending call when Codex exits.
                Err(RecvTimeoutError::Disconnected) => Err("Codex disconnected".into()),
                Err(RecvTimeoutError::Timeout) => Err(format!("Codex {method} timed out")),
            });
        lock(&self.st).calls.remove(&n.to_string());
        result
    }
    fn interrupt(&self) -> Res<()> {
        let (thread, turn) = {
            let st = lock(&self.st);
            (st.thread.clone(), st.turn.clone())
        };
        if turn.is_empty() {
            return Err("No active turn to interrupt".into());
        }
        self.call(
            "turn/interrupt",
            json!({"threadId": thread, "turnId": turn}),
        )
        .map(drop)
    }
    fn read(&self, stdout: ChildStdout) {
        let mut reader = BufReader::new(stdout);
        let read_err = loop {
            let line = match read_line(&mut reader, 8 * 1024 * 1024) {
                Ok(Some(l)) => l,
                Ok(None) => break None,
                Err(e) => break Some(e.to_string()),
            };
            let m = match serde_json::from_slice::<Value>(&line) {
                Ok(m) if m.is_object() => m,
                _ => {
                    (self.c.emit)(event("error", "Invalid JSON received from Codex"));
                    continue;
                }
            };
            let wire_id = m.get("id").filter(|v| !v.is_null());
            if s(&m, "method").is_empty() && wire_id.is_some() {
                let tx = wire_id.and_then(|id| lock(&self.st).calls.get(&id.to_string()).cloned());
                if let Some(tx) = tx {
                    let _ = tx.try_send(m);
                }
                continue;
            }
            self.handle(&m);
        };
        let status = self.child.wait();
        let stopped = {
            let mut st = lock(&self.st);
            st.calls.clear();
            std::mem::replace(&mut st.closed, true)
        };
        if !stopped {
            let msg = match (read_err, status) {
                (Some(e), _) => e,
                (None, Ok(status)) if status.success() => {
                    "Codex disconnected. Resume to continue.".into()
                }
                (None, Ok(status)) => format!("Codex process exited: {status}"),
                (None, Err(e)) => format!("Codex process exited: {e}"),
            };
            (self.c.emit)(event("disconnected", &msg));
        }
    }
    fn handle(&self, m: &Value) {
        let emit = &self.c.emit;
        let method = s(m, "method");
        let p = m.get("params").unwrap_or(&Value::Null);
        if let Some(wire_id) = m.get("id").filter(|v| !v.is_null()) {
            let mut a = ApprovalRequest {
                id: id(),
                kind: "approval".into(),
                title: "Permission requested".into(),
                detail: m.get("params").map(Value::to_string).unwrap_or_default(),
                decisions: vec!["accept".into(), "decline".into()],
                ..Default::default()
            };
            match method {
                "item/commandExecution/requestApproval" => {
                    a.title = "Run a command".into();
                    if !s(p, "command").is_empty() {
                        a.detail = s(p, "command").into();
                    }
                }
                "item/fileChange/requestApproval" => a.title = "Apply file changes".into(),
                "item/tool/requestUserInput" => {
                    a.kind = "question".into();
                    a.title = "Your input is needed".into();
                    a.questions = questions(p, false);
                    a.decisions = vec!["answer".into(), "cancel".into()];
                }
                _ => {
                    let _ = self.write(json!({"id": wire_id, "error": {"code": -32601, "message": "Nook does not support this request; no permission was granted"}}));
                    emit(event(
                        "activity",
                        &format!("Unsupported provider request was declined: {method}"),
                    ));
                    return;
                }
            }
            lock(&self.st).approvals.insert(
                a.id.clone(),
                Pending {
                    wire_id: wire_id.clone(),
                    method: method.into(),
                },
            );
            emit(SessionEvent {
                kind: "approval".into(),
                approval: Some(a),
                ..Default::default()
            });
            return;
        }
        match method {
            "thread/started" => {
                let id = s(o(p, "thread"), "id");
                if !id.is_empty() {
                    emit(event("provider_id", id));
                }
            }
            "turn/started" => {
                lock(&self.st).turn = s(o(p, "turn"), "id").into();
                emit(event("working", "Working on your task"));
            }
            "item/agentMessage/delta" | "item/commandExecution/outputDelta" => {
                let kind = if method == "item/agentMessage/delta" {
                    "delta"
                } else {
                    "output"
                };
                emit(SessionEvent {
                    kind: kind.into(),
                    text: s(p, "delta").into(),
                    item_id: s(p, "itemId").into(),
                    ..Default::default()
                });
            }
            "item/started" => {
                let label = match s(o(p, "item"), "type") {
                    "reasoning" => "Thinking",
                    "commandExecution" => "Running a command",
                    "fileChange" => "Editing files",
                    "mcpToolCall" => "Using a connected tool",
                    "webSearch" => "Searching the web",
                    _ => "Working",
                };
                emit(event("activity", label));
            }
            "turn/completed" => {
                {
                    let mut st = lock(&self.st);
                    st.turn.clear();
                    st.approvals.clear();
                }
                let turn = o(p, "turn");
                match s(turn, "status") {
                    "failed" => emit(event(
                        "error",
                        &explain_error(s(o(turn, "error"), "message")),
                    )),
                    "interrupted" => emit(event("stopped", "Turn interrupted")),
                    _ => emit(event("completed", "Ready for your next thought")),
                }
            }
            "serverRequest/resolved" => {
                let request = p.get("requestId").unwrap_or(&Value::Null);
                let resolved = {
                    let mut st = lock(&self.st);
                    let key = st
                        .approvals
                        .iter()
                        .find(|(_, v)| v.wire_id == *request)
                        .map(|(k, _)| k.clone());
                    if let Some(k) = &key {
                        st.approvals.remove(k);
                    }
                    key
                };
                if let Some(id) = resolved {
                    emit(SessionEvent {
                        kind: "resolved".into(),
                        item_id: id,
                        ..Default::default()
                    });
                }
            }
            "error" => emit(event("error", &explain_error(s(o(p, "error"), "message")))),
            _ => {}
        }
    }
}

impl Runtime for Codex {
    fn send(&self, text: &str) -> Res<()> {
        let thread = lock(&self.st).thread.clone();
        self.call(
            "turn/start",
            json!({"threadId": thread, "input": [{"type": "text", "text": text}]}),
        )
        .map(drop)
    }
    fn stop(&self) {
        lock(&self.st).closed = true;
        self.child.stop();
    }
    fn respond(&self, a: &ApprovalResponse) -> Res<()> {
        let p = lock(&self.st)
            .approvals
            .remove(&a.request_id)
            .ok_or("This request has expired")?;
        let result = if p.method == "item/tool/requestUserInput" {
            if a.decision == "cancel" {
                return self.interrupt();
            }
            let answers: serde_json::Map<String, Value> = a
                .answers
                .iter()
                .map(|(k, v)| (k.clone(), json!({"answers": v})))
                .collect();
            json!({"answers": answers})
        } else {
            if a.decision != "accept" && a.decision != "decline" {
                return Err("Invalid decision".into());
            }
            json!({"decision": a.decision})
        };
        self.write(json!({"id": p.wire_id, "result": result}))
    }
}
