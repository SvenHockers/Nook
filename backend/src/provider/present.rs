//! One-shot, tool-less model calls that arrange a presentation. The call runs with every tool
//! disabled, no saved session and no extra servers, so the evidence it reads cannot make it act.
//! It also ignores user settings, so plugins and hooks cannot add text to a JSON-only reply; the
//! stored sign-in still applies, but sign-in configured through settings (such as a cloud
//! provider's environment) does not, and then arranging falls back to the standard layout.
use crate::model::ProviderInfo;
use crate::{process, Res};
use serde_json::Value;
use std::io::Read;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

const SYSTEM: &str = "You plan how a coding session's recorded output is laid out. You have no tools and never act: reply only with the JSON object requested.";
const MAX_REPLY: usize = 1024 * 1024;

/// Runs Claude Code once and returns its final text. `attach` receives the child so the caller can
/// cancel it; returning false abandons the call before any prompt is written.
pub fn arrange(
    info: &ProviderInfo,
    prompt: &str,
    cwd: &str,
    limit: Duration,
    attach: impl FnOnce(Arc<process::Child>) -> bool,
) -> Res<String> {
    if info.id != "claude" {
        return Err(format!("{} cannot arrange views yet", info.name));
    }
    let args: Vec<String> = [
        "--print",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "project",
        "--system-prompt",
        SYSTEM,
    ]
    .map(String::from)
    .into();
    let (child, mut stdout) = process::start(&info.path, &args, cwd, &[])?;
    let (tx, rx) = mpsc::channel();
    let reader = {
        let child = child.clone();
        thread::spawn(move || {
            let (mut reply, mut chunk) = (Vec::new(), [0u8; 8192]);
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reply.extend_from_slice(&chunk[..n]),
                }
                if reply.len() > MAX_REPLY {
                    child.stop();
                    break;
                }
            }
            let ok = child.wait().is_ok_and(|s| s.success());
            let _ = tx.send((reply, ok));
        })
    };
    let attached = attach(child.clone());
    if attached {
        if let Err(e) = child.write(prompt.as_bytes()) {
            child.stop();
            let _ = reader.join();
            return Err(e);
        }
        child.close_stdin();
    } else {
        child.stop();
    }
    let outcome = rx.recv_timeout(limit);
    if outcome.is_err() {
        child.stop();
    }
    let _ = reader.join();
    if !attached {
        return Err("Arranging was cancelled".into());
    }
    let Ok((reply, ok)) = outcome else {
        return Err("The assistant took too long to arrange this view".into());
    };
    final_result(&reply, ok)
}

/// Claude Code prints one result object, or (when its verbose setting is on) an array of every
/// message that ends with it. Either way only the final result counts.
fn final_result(raw: &[u8], ok: bool) -> Res<String> {
    let v: Value = serde_json::from_slice(raw).unwrap_or_default();
    let last = match &v {
        Value::Array(items) => items.iter().rev().find(|m| m["type"] == "result"),
        other => Some(other),
    };
    let text = last.and_then(|m| m["result"].as_str());
    if !ok || last.is_some_and(|m| m["is_error"].as_bool().unwrap_or(false)) {
        return Err(text
            .unwrap_or("The assistant could not arrange this view")
            .into());
    }
    text.map(String::from)
        .ok_or_else(|| "The assistant returned no result".into())
}

#[cfg(test)]
mod tests {
    use super::final_result;

    #[test]
    fn reads_the_result_from_either_output_shape() {
        let object = br#"{"type":"result","is_error":false,"result":"{\"blocks\":[]}"}"#;
        let array = br#"[{"type":"system","subtype":"init"},{"type":"assistant","message":{}},{"type":"result","is_error":false,"result":"{\"blocks\":[]}"}]"#;
        for raw in [&object[..], &array[..]] {
            assert_eq!(final_result(raw, true).unwrap(), r#"{"blocks":[]}"#);
        }
    }

    #[test]
    fn errors_surface_their_message() {
        let object = br#"{"type":"result","is_error":true,"result":"HTTP 429"}"#;
        let array = br#"[{"type":"system"},{"type":"result","is_error":true,"result":"HTTP 429"}]"#;
        for raw in [&object[..], &array[..]] {
            assert_eq!(final_result(raw, false).unwrap_err(), "HTTP 429");
            assert_eq!(final_result(raw, true).unwrap_err(), "HTTP 429");
        }
        assert!(final_result(b"not json", false)
            .unwrap_err()
            .contains("could not arrange"));
    }

    #[test]
    fn a_missing_result_is_an_error_not_an_empty_layout() {
        for raw in [&b"not json"[..], b"[]", br#"[{"type":"assistant"}]"#, b""] {
            assert!(final_result(raw, true).is_err(), "{raw:?}");
        }
    }
}
