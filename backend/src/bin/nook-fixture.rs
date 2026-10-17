// Test fixture, never packaged: fakes Codex's app-server and Claude's stream-json CLI,
// and spawns a small process tree for supervision tests.
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::process::exit;
use std::time::Duration;

/// Writes one JSON line in two chunks so readers must reassemble fragments.
fn send(v: Value) {
    let b = v.to_string().into_bytes();
    let (head, tail) = b.split_at(b.len() / 2);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(head).and_then(|()| out.flush());
    let _ = out
        .write_all(tail)
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("verify") => {
            println!("all tests passed (untrusted prose)");
            eprintln!("verification stderr");
            println!("cwd={}", std::env::current_dir().unwrap().display());
            if args.iter().any(|s| s == "flood") {
                print!("{}", "x".repeat(100_000));
            }
            exit(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0));
        }
        Some("app-server") => codex(),
        Some("--print") if args.iter().any(|a| a == "--tools") => presenter(&args),
        Some("--print") => claude(&args),
        Some("--version") => println!("2.1.295 (test provider)"),
        Some("tree") => {
            let me = std::env::current_exe().unwrap_or_else(|_| exit(2));
            let mut leaf = std::process::Command::new(me)
                .arg("sleep")
                .spawn()
                .unwrap_or_else(|_| exit(2));
            println!("{}", leaf.id());
            let _ = std::io::stdout().flush();
            let _ = leaf.wait();
        }
        Some("sleep") => std::thread::sleep(Duration::from_secs(30)),
        _ => exit(2),
    }
}

fn codex() {
    let mut approvals = 0;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let m: Value = serde_json::from_str(&line).unwrap_or_default();
        let id = m["id"].clone();
        match m["method"].as_str().unwrap_or("") {
            "initialize" => send(json!({"id": id, "result": {}})),
            "thread/start" | "thread/resume" => {
                send(json!({"id": id, "result": {"thread": {"id": "test-thread"}}}))
            }
            "turn/start" => {
                send(json!({"method": "turn/started", "params": {"turn": {"id": "t1"}}}));
                send(json!({"id": id, "result": {}}));
                for approval in ["approve-1", "approve-2"] {
                    send(
                        json!({"id": approval, "method": "item/commandExecution/requestApproval", "params": {"command": "echo harmless", "threadId": "test-thread", "turnId": "t1"}}),
                    );
                }
            }
            "turn/interrupt" => send(json!({"id": id, "result": {}})),
            _ if m.get("result").is_some() => {
                approvals += 1;
                if approvals == 2 {
                    send(
                        json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": "Hello "}}),
                    );
                    send(
                        json!({"method": "item/agentMessage/delta", "params": {"itemId": "m1", "delta": "world"}}),
                    );
                    send(
                        json!({"method": "turn/completed", "params": {"turn": {"id": "t1", "status": "completed"}}}),
                    );
                }
            }
            _ => {}
        }
    }
}

/// Fakes `claude --print --output-format json` as used to arrange presentations. A test picks the
/// behaviour with the focus text, which reaches this process inside the prompt on stdin.
fn presenter(args: &[String]) {
    let mut prompt = String::new();
    let _ = std::io::stdin().read_to_string(&mut prompt);
    let has = |flag: &str, value: Option<&str>| {
        args.windows(2)
            .any(|w| w[0] == flag && value.is_none_or(|v| w[1] == v))
    };
    // The call must be tool-less and leave no session behind.
    if !has("--tools", Some(""))
        || !has("--setting-sources", Some("project"))
        || !args.iter().any(|a| a == "--no-session-persistence")
    {
        exit(5);
    }
    let focus = prompt
        .lines()
        .find_map(|l| l.strip_prefix("FOCUS (from the user; may be empty): "))
        .and_then(|s| serde_json::from_str::<String>(s).ok())
        .unwrap_or_default();
    let ids: Vec<String> = prompt
        .lines()
        .skip_while(|l| *l != "EVIDENCE:")
        .nth(1)
        .and_then(|l| serde_json::from_str::<Vec<Value>>(l).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| e["id"].as_str().map(String::from))
        .collect();
    let blocks = |ids: &[String]| -> Vec<Value> {
        ids.iter()
            .enumerate()
            .map(|(i, id)| {
                let kind = if i == 0 { "Finding" } else { "Summary" };
                json!({"evidenceId": id, "type": kind})
            })
            .collect()
    };
    let reply = |is_error: bool, result: String| {
        println!(
            "{}",
            json!({"type": "result", "subtype": "success", "is_error": is_error, "result": result})
        );
    };
    match focus.as_str() {
        "fixture:garbage" => reply(false, "I cannot help with that.".into()),
        "fixture:unknown" => reply(
            false,
            json!({"blocks": [{"evidenceId": "nope", "type": "Summary"}]}).to_string(),
        ),
        "fixture:error" => {
            reply(true, "HTTP 429 Too Many Requests".into());
            exit(1);
        }
        "fixture:sleep" => std::thread::sleep(Duration::from_secs(30)),
        _ => {
            let reversed: Vec<String> = ids.into_iter().rev().collect();
            let text = format!("Here you go:\n{}", json!({"blocks": blocks(&reversed)}));
            reply(false, text);
        }
    }
}

fn claude(args: &[String]) {
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    let flag = args
        .iter()
        .position(|a| a == "--session-id" || a == "--resume");
    let (mode, id) = flag
        .and_then(|i| Some((args[i].clone(), args.get(i + 1)?.clone())))
        .unwrap_or_default();
    send(json!({"type": "system", "session_id": id}));
    let url = std::env::var("NOOK_PERMISSION_URL").unwrap_or_default();
    let token = std::env::var("NOOK_SESSION_TOKEN").unwrap_or_default();
    let body = br#"{"tool_name":"Write","input":{"file_path":"example.txt","content":"hello"}}"#;
    let Some(answer) = nook::provider::post_permission(&url, &token, body) else {
        exit(3)
    };
    if !String::from_utf8_lossy(&answer).contains("allow") {
        exit(4);
    }
    send(
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": format!("Done {mode}")}]}}),
    );
    send(json!({"type": "result", "session_id": id, "is_error": false}));
}
