//! Claude Code: one structured `--print` process per turn, session-scoped HTTP hooks on loopback,
//! and an MCP permission host that Claude runs as its child.
use super::{explain_error, o, questions, s, Config, Emit, Runtime};
use crate::model::{event, id, uuid, ApprovalRequest, ApprovalResponse, SessionEvent};
use crate::{err, lock, private_file, process, read_line, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::ChildStdout;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tiny_http::{Method, Request, Response, Server};

const MB: usize = 1024 * 1024;

pub(super) struct Claude {
    c: Config,
    st: Arc<Mutex<State>>,
    server: Server,
    url: String,
    token: String,
    settings: PathBuf,
}
#[derive(Default)]
struct State {
    child: Option<Arc<process::Child>>,
    pending: HashMap<String, SyncSender<ApprovalResponse>>,
    session: String,
    resume: bool,
    closed: bool,
    busy: bool,
}

pub(super) fn start(c: Config) -> Res<Arc<Claude>> {
    let server = Server::http("127.0.0.1:0").map_err(err)?;
    let url = format!(
        "http://{}",
        server
            .server_addr()
            .to_ip()
            .ok_or("Hook server has no TCP address")?
    );
    let hook = |path: &str| json!({"type": "http", "url": format!("{url}{path}"), "headers": {"Authorization": "Bearer $NOOK_SESSION_TOKEN"}, "allowedEnvVars": ["NOOK_SESSION_TOKEN"], "timeout": 600, "onFailure": "block"});
    let settings = json!({"hooks": {"PreToolUse": [{"matcher": "AskUserQuestion|ExitPlanMode", "hooks": [hook("/question")]}]}});
    let path = std::env::temp_dir().join(format!("nook-session-{}.json", id()));
    private_file(&path, OpenOptions::new().write(true).create_new(true))
        .and_then(|mut f| f.write_all(settings.to_string().as_bytes()))
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            err(e)
        })?;
    let resume = !c.session.provider_id.is_empty();
    let session = if resume {
        c.session.provider_id.clone()
    } else {
        uuid()
    };
    let r = Arc::new(Claude {
        st: Arc::new(Mutex::new(State {
            session,
            resume,
            ..Default::default()
        })),
        server,
        url,
        token: id() + &id(),
        settings: path,
        c,
    });
    let hooks = r.clone();
    thread::spawn(move || loop {
        match hooks.server.recv() {
            Ok(rq) => {
                let h = hooks.clone();
                thread::spawn(move || h.hook(rq));
            }
            Err(_) if lock(&hooks.st).closed => break,
            Err(_) => {}
        }
    });
    Ok(r)
}

fn drain_and_wait(child: Arc<process::Child>, mut stdout: ChildStdout) {
    thread::spawn(move || {
        let _ = io::copy(&mut stdout, &mut io::sink());
        let _ = child.wait();
    });
}
fn decline_all(pending: &mut HashMap<String, SyncSender<ApprovalResponse>>) {
    for (_, tx) in pending.drain() {
        let _ = tx.try_send(ApprovalResponse {
            decision: "decline".into(),
            ..Default::default()
        });
    }
}
fn delta(text: &str, item: &str) -> SessionEvent {
    SessionEvent {
        kind: "delta".into(),
        text: text.into(),
        item_id: item.into(),
        ..Default::default()
    }
}

impl Runtime for Claude {
    fn send(&self, text: &str) -> Res<()> {
        let mut st = lock(&self.st);
        if st.closed {
            return Err("Claude session is stopped".into());
        }
        if st.busy {
            return Err("Claude is already working".into());
        }
        let mcp = json!({"mcpServers": {"nook": {"command": self.c.helper, "args": ["--permission-host"]}}}).to_string();
        let mut args: Vec<String> = [
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--settings",
        ]
        .map(String::from)
        .into();
        args.push(self.settings.to_string_lossy().into_owned());
        args.extend([
            "--mcp-config".into(),
            mcp,
            "--permission-prompt-tool".into(),
            "mcp__nook__approve".into(),
        ]);
        args.extend([
            if st.resume {
                "--resume"
            } else {
                "--session-id"
            }
            .into(),
            st.session.clone(),
        ]);
        let permission = format!("{}/approve", self.url);
        let (child, stdout) = process::start(
            &self.c.info.path,
            &args,
            &self.c.session.cwd,
            &[
                ("NOOK_SESSION_TOKEN", &self.token),
                ("NOOK_PERMISSION_URL", &permission),
            ],
        )?;
        let birth = match process::identity(child.pid) {
            Ok(b) => b,
            Err(e) => {
                drain_and_wait(child.clone(), stdout);
                child.stop();
                return Err(e);
            }
        };
        (self.c.emit)(event(
            "process",
            &json!({"pid": child.pid, "birth": birth}).to_string(),
        ));
        st.child = Some(child.clone());
        st.busy = true;
        let line = json!({"type": "user", "message": {"role": "user", "content": text}})
            .to_string()
            + "\n";
        if let Err(e) = child.write(line.as_bytes()) {
            drain_and_wait(child.clone(), stdout);
            child.stop();
            st.busy = false;
            return Err(e);
        }
        child.close_stdin();
        let (state, emit) = (self.st.clone(), self.c.emit.clone());
        thread::spawn(move || read(state, emit, child, stdout));
        Ok(())
    }
    fn stop(&self) {
        let child = {
            let mut st = lock(&self.st);
            st.closed = true;
            decline_all(&mut st.pending);
            st.child.clone()
        };
        self.server.unblock();
        if let Some(child) = child {
            child.stop();
        }
        let _ = std::fs::remove_file(&self.settings);
    }
    fn respond(&self, a: &ApprovalResponse) -> Res<()> {
        let tx = lock(&self.st)
            .pending
            .remove(&a.request_id)
            .ok_or("This request has expired")?;
        let _ = tx.try_send(a.clone());
        Ok(())
    }
}

fn read(st: Arc<Mutex<State>>, emit: Emit, child: Arc<process::Child>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let (mut complete, mut streamed, mut item) = (false, false, id());
    let read_err = loop {
        let line = match read_line(&mut reader, 8 * MB) {
            Ok(Some(l)) => l,
            Ok(None) => break None,
            Err(e) => break Some(e.to_string()),
        };
        let Ok(m) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let sid = s(&m, "session_id");
        if !sid.is_empty() {
            let first = {
                let mut st = lock(&st);
                let first = !st.resume;
                st.session = sid.into();
                st.resume = true;
                first
            };
            if first {
                emit(event("provider_id", sid));
            }
        }
        match s(&m, "type") {
            "stream_event" => {
                let e = o(&m, "event");
                match s(e, "type") {
                    "message_start" => {
                        streamed = false;
                        item = id();
                    }
                    "content_block_delta" => match s(o(e, "delta"), "type") {
                        "text_delta" => {
                            streamed = true;
                            emit(delta(s(o(e, "delta"), "text"), &item));
                        }
                        "thinking_delta" => emit(event("activity", "Thinking")),
                        _ => {}
                    },
                    "content_block_start" if s(o(e, "content_block"), "type") == "tool_use" => {
                        emit(event(
                            "activity",
                            &format!("Using {}", s(o(e, "content_block"), "name")),
                        ));
                    }
                    _ => {}
                }
            }
            "assistant" => {
                for b in o(&m, "message")
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if s(b, "type") == "text" && !streamed {
                        emit(delta(s(b, "text"), &item));
                    }
                    if s(b, "type") == "tool_use" {
                        emit(event("activity", &format!("Using {}", s(b, "name"))));
                    }
                }
            }
            "result" => {
                complete = true;
                if m.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    let mut msg = s(&m, "result").to_string();
                    if msg.is_empty() {
                        msg = m.get("errors").map(Value::to_string).unwrap_or_default();
                    }
                    emit(event("error", &explain_error(&msg)));
                } else {
                    emit(event("completed", "Ready for your next thought"));
                }
            }
            _ => {}
        }
    };
    let status = child.wait();
    let stopped = {
        let mut st = lock(&st);
        st.busy = false;
        st.child = None;
        decline_all(&mut st.pending);
        st.closed
    };
    emit(event("process_clear", ""));
    if !complete && !stopped {
        let msg = match (read_err, status) {
            (Some(e), _) => e,
            (None, Ok(status)) if status.success() => "Claude stopped before completing the turn. Resume to continue.".into(),
            (None, Ok(status)) => format!("Claude exited before completing the turn ({status}). Check sign-in, provider version, and organization settings."),
            (None, Err(e)) => format!("Claude exited before completing the turn ({e}). Check sign-in, provider version, and organization settings."),
        };
        emit(event("disconnected", &msg));
    }
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}
fn reply(rq: Request, code: u16, text: &str) {
    let _ = rq.respond(Response::from_string(text).with_status_code(code));
}

impl Claude {
    /// Cancellation, timeout, bad authentication and bridge disconnection never grant approval.
    fn hook(&self, mut rq: Request) {
        let auth = rq
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.to_string())
            .unwrap_or_default();
        if *rq.method() != Method::Post
            || !same(auth.as_bytes(), format!("Bearer {}", self.token).as_bytes())
        {
            return reply(rq, 403, "Forbidden\n");
        }
        let mut raw = Vec::new();
        let body: Value = match rq.as_reader().take(MB as u64 + 1).read_to_end(&mut raw) {
            Ok(_) if raw.len() <= MB => serde_json::from_slice(&raw).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        if !body.is_object() {
            return reply(rq, 400, "Invalid request\n");
        }
        let input = [body.get("tool_input"), body.get("input")]
            .into_iter()
            .flatten()
            .find(|v| v.is_object())
            .cloned()
            .unwrap_or(Value::Null);
        let tool = s(&body, "tool_name").to_string();
        let mut a = ApprovalRequest {
            id: id(),
            kind: "approval".into(),
            title: format!("Allow {tool}?"),
            detail: serde_json::to_string_pretty(&input).unwrap_or_default(),
            decisions: vec!["accept".into(), "decline".into()],
            ..Default::default()
        };
        let question = rq.url().split('?').next() == Some("/question");
        if question {
            match tool.as_str() {
                "AskUserQuestion" => {
                    a.kind = "question".into();
                    a.title = "Your input is needed".into();
                    a.questions = questions(&input, true);
                    a.decisions = vec!["answer".into(), "cancel".into()];
                }
                "ExitPlanMode" => {
                    a.title = "Approve this plan".into();
                    a.detail = s(&input, "plan").into();
                }
                _ => return reply(rq, 400, "Unsupported question\n"),
            }
        }
        let (tx, rx) = sync_channel(1);
        {
            let mut st = lock(&self.st);
            if st.closed {
                drop(st);
                return reply(rq, 410, "Session stopped\n");
            }
            st.pending.insert(a.id.clone(), tx);
        }
        let approval = a.id.clone();
        (self.c.emit)(SessionEvent {
            kind: "approval".into(),
            approval: Some(a),
            ..Default::default()
        });
        let declined = || ApprovalResponse {
            decision: "decline".into(),
            ..Default::default()
        };
        let answer = rx
            .recv_timeout(Duration::from_secs(590))
            .unwrap_or_else(|_| declined());
        let allow = answer.decision == "accept" || answer.decision == "answer";
        let out = if question {
            let mut out = json!({"hookEventName": "PreToolUse", "permissionDecision": if allow { "allow" } else { "deny" }});
            if allow {
                let mut input = if input.is_object() { input } else { json!({}) };
                if tool == "AskUserQuestion" {
                    input["answers"] = answer
                        .answers
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::from(v.join(", "))))
                        .collect::<serde_json::Map<_, _>>()
                        .into();
                }
                out["updatedInput"] = input;
            }
            json!({"hookSpecificOutput": out})
        } else if allow {
            json!({"behavior": "allow", "updatedInput": input})
        } else {
            json!({"behavior": "deny", "message": "The user declined, or the request expired."})
        };
        let header = "Content-Type: application/json"
            .parse::<tiny_http::Header>()
            .expect("static header");
        let _ = rq.respond(Response::from_string(out.to_string() + "\n").with_header(header));
        lock(&self.st).pending.remove(&approval);
        (self.c.emit)(SessionEvent {
            kind: "resolved".into(),
            item_id: approval,
            ..Default::default()
        });
    }
}

/// A small stdio MCP server run by Claude as a child of Nook.
/// Tokens arrive only through the environment, never command arguments or disk.
pub fn permission_host(mut input: impl BufRead, mut out: impl Write) -> io::Result<()> {
    while let Some(line) = read_line(&mut input, MB)? {
        let Ok(msg) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let result = match s(&msg, "method") {
            "initialize" => {
                json!({"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "nook", "version": "0.1.0"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                json!({"tools": [{"name": "approve", "description": "Ask the user for permission in Nook", "inputSchema": {"type": "object", "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"}}, "required": ["tool_name", "input"]}}]})
            }
            "tools/call" => {
                let args = msg
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .map(Value::to_string)
                    .unwrap_or_default();
                let (url, token) = (
                    std::env::var("NOOK_PERMISSION_URL").unwrap_or_default(),
                    std::env::var("NOOK_SESSION_TOKEN").unwrap_or_default(),
                );
                let response =
                    post_permission(&url, &token, args.as_bytes()).filter(|b| !b.is_empty());
                let text = response.map_or_else(
                    || r#"{"behavior":"deny","message":"Nook is unavailable"}"#.into(),
                    |b| String::from_utf8_lossy(&b).into_owned(),
                );
                json!({"content": [{"type": "text", "text": text}]})
            }
            _ => {
                writeln!(
                    out,
                    "{}",
                    json!({"id": id, "jsonrpc": "2.0", "error": {"code": -32601, "message": "Unsupported method"}})
                )?;
                out.flush()?;
                continue;
            }
        };
        writeln!(
            out,
            "{}",
            json!({"id": id, "jsonrpc": "2.0", "result": result})
        )?;
        out.flush()?;
    }
    Ok(())
}

/// POSTs to the loopback hook server and returns the body of a 200 response.
/// HTTP/1.0 keeps the response unchunked and closes the connection when done.
pub fn post_permission(url: &str, token: &str, body: &[u8]) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("http://")?;
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let path = if path.is_empty() { "/" } else { path };
    let addr = host.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(595)))
        .ok()?;
    let head = format!("POST {path} HTTP/1.0\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len());
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .ok()?;
    let mut raw = Vec::new();
    stream
        .take((MB + 64 * 1024) as u64)
        .read_to_end(&mut raw)
        .ok()?;
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let status = std::str::from_utf8(&raw[..end]).ok()?.split(' ').nth(1)?;
    (status == "200").then(|| raw[end + 4..].iter().take(MB).copied().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ProviderInfo, Session};

    #[test]
    fn rejects_unauthenticated_hook() {
        let c = Config {
            info: ProviderInfo::default(),
            session: Session::default(),
            emit: Arc::new(|_| {}),
            helper: String::new(),
        };
        let r = start(c).unwrap();
        let host = r.url.trim_start_matches("http://").to_string();
        let mut stream = TcpStream::connect(&host).unwrap();
        stream
            .write_all(b"POST /question HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(
            response.starts_with("HTTP/1.0 403") || response.starts_with("HTTP/1.1 403"),
            "{response}"
        );
        assert!(post_permission(&format!("{}/approve", r.url), "wrong-token", b"{}").is_none());
        r.stop();
    }
}
