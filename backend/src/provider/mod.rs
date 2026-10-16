//! Installed-agent discovery and the runtime adapters for Claude Code and Codex.
mod claude;
mod codex;
mod present;

pub use claude::{permission_host, post_permission};
pub use present::arrange;

use crate::model::{
    ApprovalResponse, ProviderCapabilities, ProviderInfo, Question, Session, SessionEvent,
};
use crate::{process, Res};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

pub type Emit = Arc<dyn Fn(SessionEvent) + Send + Sync>;

pub trait Runtime: Send + Sync {
    fn send(&self, text: &str) -> Res<()>;
    fn stop(&self);
    fn respond(&self, a: &ApprovalResponse) -> Res<()>;
}
pub struct Config {
    pub info: ProviderInfo,
    pub session: Session,
    pub emit: Emit,
    pub helper: String,
}

pub fn start(c: Config) -> Res<Arc<dyn Runtime>> {
    match c.info.id.as_str() {
        "codex" => Ok(codex::start(c)?),
        "claude" => Ok(claude::start(c)?),
        _ => Err("unknown provider".into()),
    }
}

/// Searches absolute PATH entries only (never the current folder), in PATHEXT order on Windows.
fn look_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".com;.exe;.bat;.cmd".into());
        pathext
            .split(';')
            .filter(|e| !e.is_empty())
            .map(str::to_lowercase)
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|d| d.is_absolute())
        .find_map(|dir| {
            exts.iter()
                .map(|ext| dir.join(format!("{name}{ext}")))
                .find(|p| executable(p))
        })
}
fn executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| {
        #[cfg(unix)]
        let runnable = std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0;
        #[cfg(not(unix))]
        let runnable = true;
        m.is_file() && runnable
    })
}

pub fn discover(overrides: &HashMap<String, String>) -> Vec<ProviderInfo> {
    let home = PathBuf::from(
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    );
    ["claude", "codex"]
        .into_iter()
        .map(|id| {
            let mut p = ProviderInfo {
                id: id.into(),
                name: if id == "claude" { "Claude Code" } else { "Codex" }.into(),
                capabilities: ProviderCapabilities { resume: true, interrupt: true, approvals: true, questions: true, sandbox: "Provider-managed; inspect provider configuration".into() },
                ..Default::default()
            };
            if cfg!(windows) && id == "claude" {
                p.capabilities.sandbox = "Tool permissions only. No native Windows OS sandbox.".into();
            }
            let mut candidates: Vec<PathBuf> = vec![];
            match overrides.get(id).filter(|o| !o.is_empty()) {
                Some(o) => candidates.push(o.into()),
                None => {
                    candidates.extend(look_path(id));
                    let name = if cfg!(windows) { format!("{id}.exe") } else { id.to_string() };
                    candidates.extend([home.join(".local").join("bin"), home.join(".cargo").join("bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()].map(|d| d.join(&name)));
                    if cfg!(windows) {
                        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default());
                        candidates.push(local.join("Microsoft").join("WinGet").join("Links").join(&name));
                    }
                }
            }
            for path in candidates {
                if !std::fs::metadata(&path).is_ok_and(|m| !m.is_dir()) {
                    continue;
                }
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if ext == "cmd" || ext == "bat" {
                    p.problem = "Select the native .exe installation; shell wrappers are not supported.".into();
                    continue;
                }
                match process::output(Command::new(&path).arg("--version"), Duration::from_secs(5)) {
                    Ok(out) if out.status.success() => {
                        p.path = path.to_string_lossy().into_owned();
                        p.version = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
                        p.available = true;
                        break;
                    }
                    _ => p.problem = "Cannot run this executable. Check installation and permissions.".into(),
                }
            }
            if !p.available && p.problem.is_empty() {
                p.problem = "Not installed or not found. Install and sign in, then refresh or select the executable.".into();
            }
            if p.available && id == "claude" && !at_least(&p.version, [2, 1, 295]) {
                p.available = false;
                p.problem = "Claude Code 2.1.295 or newer is required for hooks that block on connection failure.".into();
            }
            p
        })
        .collect()
}

/// Compares the first `major.minor.patch` found in `v`.
fn at_least(v: &str, want: [i64; 3]) -> bool {
    for token in v.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let parts: Vec<&str> = token.split('.').collect();
        if let Some(w) = parts.windows(3).find(|w| w.iter().all(|p| !p.is_empty())) {
            let got: Vec<i64> = w.iter().map(|p| p.parse().unwrap_or(0)).collect();
            return got.as_slice() >= want.as_slice();
        }
    }
    false
}

pub fn explain_error(s: &str) -> String {
    let l = s.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    if has(&[
        "401",
        "authenticat",
        "oauth session expired",
        "not logged",
        "login",
    ]) {
        "Authentication is unavailable or expired. Sign in to the installed agent and resume."
            .into()
    } else if has(&["policy", "organization"]) {
        "The provider or organization policy blocked this action. Review the provider settings."
            .into()
    } else if has(&["rate limit", "429"]) {
        "The provider usage limit was reached. Wait for it to reset, then resume.".into()
    } else {
        s.into()
    }
}

/// Reads a string member, or "" when absent.
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
/// Reads an object member, or Null when absent.
fn o<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).filter(|x| x.is_object()).unwrap_or(&Value::Null)
}
fn questions(p: &Value, claude: bool) -> Vec<Question> {
    let items = p
        .get("questions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    items
        .iter()
        .map(|m| {
            let text = s(m, "question").to_string();
            let id = s(m, "id");
            let options = m
                .get("options")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            Question {
                id: if claude || id.is_empty() {
                    text.clone()
                } else {
                    id.into()
                },
                text,
                options: options.iter().map(|o| s(o, "label").to_string()).collect(),
                multi: m
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_boundary() {
        for v in ["2.1.294", "garbage", "1.9.999"] {
            assert!(!at_least(v, [2, 1, 295]), "{v}");
        }
        assert!(at_least("2.1.295 (Claude Code)", [2, 1, 295]));
        assert!(at_least("codex-cli 10.0.0", [2, 1, 295]));
    }

    #[test]
    fn errors_are_explained() {
        assert!(explain_error("HTTP 429 Too Many Requests").contains("usage limit"));
        assert_eq!(explain_error("boom"), "boom");
    }
}
