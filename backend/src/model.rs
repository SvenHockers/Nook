//! The wire contract, mirrored by `frontend/src/types.ts`.
use crate::{err, Res};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub const STARTING: &str = "starting";
pub const WORKING: &str = "working";
pub const WAITING: &str = "waiting";
pub const COMPLETED: &str = "completed";
pub const STOPPED: &str = "stopped";
pub const FAILED: &str = "failed";
pub const DISCONNECTED: &str = "disconnected";

pub fn active(state: &str) -> bool {
    matches!(state, STARTING | WORKING | WAITING)
}

fn random() -> [u8; 16] {
    let mut b = [0; 16];
    getrandom::fill(&mut b).expect("system random source is unavailable");
    b
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn id() -> String {
    hex(&random())
}
pub fn uuid() -> String {
    let mut b = random();
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
pub fn now() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    rfc3339(t.as_secs() as i64, t.subsec_nanos())
}
/// UTC RFC 3339 with trailing fractional zeros trimmed, matching the timestamps already stored.
fn rfc3339(secs: i64, nanos: u32) -> String {
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let frac = if nanos == 0 {
        String::new()
    } else {
        format!(".{nanos:09}").trim_end_matches('0').to_string()
    };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{frac}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

/// Treats JSON null as the zero value: rows written by the earlier Go runtime hold `null` lists.
pub fn decode<T: DeserializeOwned>(mut v: Value) -> Res<T> {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(m) => {
                m.retain(|_, x| !x.is_null());
                m.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut v);
    serde_json::from_value(v).map_err(err)
}

pub fn event(kind: &str, text: &str) -> SessionEvent {
    SessionEvent {
        kind: kind.into(),
        text: text.into(),
        ..Default::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub git: bool,
    pub context: Vec<ContextAssignment>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextAssignment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub value: String,
    pub enabled: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Avatar {
    pub shape: i64,
    pub color: i64,
    pub name: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub process_id: i64,
    pub process_birth: String,
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub provider: String,
    pub state: String,
    pub activity: String,
    pub error: String,
    pub cwd: String,
    pub branch: String,
    pub base_commit: String,
    pub isolated: bool,
    pub provider_id: String,
    pub avatar: Avatar,
    pub context: Vec<ContextAssignment>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub capabilities: ProviderCapabilities,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderCapabilities {
    pub resume: bool,
    pub interrupt: bool,
    pub approvals: bool,
    pub questions: bool,
    pub sandbox: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub version: String,
    pub available: bool,
    pub problem: String,
    pub capabilities: ProviderCapabilities,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Question {
    pub id: String,
    pub text: String,
    pub options: Vec<String>,
    pub multi: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub questions: Vec<Question>,
    pub decisions: Vec<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalResponse {
    pub session_id: String,
    pub request_id: String,
    pub decision: String,
    pub answers: HashMap<String, Vec<String>>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionEvent {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recorded: Vec<crate::presentation::Recorded>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<CheckRun>,
    pub sequence: i64,
    pub session_id: String,
    pub kind: String,
    pub text: String,
    pub item_id: String,
    pub time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalRequest>,
}
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub workflows: Vec<Workflow>,
    pub problem: String,
    pub projects: Vec<Project>,
    pub sessions: Vec<Session>,
    pub providers: Vec<ProviderInfo>,
    pub approvals: Vec<ApprovalRequest>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchRequest {
    pub project_id: String,
    pub provider: String,
    pub title: String,
    pub prompt: String,
    pub shared: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Changes {
    pub status: String,
    pub diff: String,
    pub truncated: bool,
}

/// Workflow task acceptance is a human decision, separate from provider turn completion.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskAttempt {
    pub session_id: String,
    pub outcome: String,
    pub reason: String,
    pub started_at: String,
    pub finished_at: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub provider: String,
    pub depends_on: Vec<String>,
    pub session_id: String,
    pub artifact_id: String,
    pub attempts: Vec<TaskAttempt>,
    pub state: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowEvent {
    pub id: String,
    pub time: String,
    pub task_id: String,
    pub kind: String,
    pub text: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workflow {
    pub canceled: bool,
    pub archived: bool,
    pub id: String,
    pub project_id: String,
    pub goal: String,
    pub revision: i64,
    pub state: String,
    pub tasks: Vec<WorkflowTask>,
    pub history: Vec<WorkflowEvent>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateWorkflowRequest {
    pub project_id: String,
    pub goal: String,
    pub tasks: Vec<WorkflowTask>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowAction {
    pub workflow_id: String,
    pub task_id: String,
    pub revision: i64,
    pub source_revision: i64,
    pub source_code_revision: String,
    pub reason: String,
    pub shared: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditWorkflowRequest {
    pub workflow_id: String,
    pub revision: i64,
    pub goal: String,
    pub tasks: Vec<WorkflowTask>,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowArtifact {
    pub id: String,
    pub workflow_id: String,
    pub project_id: String,
    pub task_id: String,
    pub session_id: String,
    pub revision: i64,
    pub accepted_at: String,
    pub handoff: String,
    pub handoff_bytes: usize,
    pub omitted_records: usize,
    pub head_commit: String,
    pub changes: Option<Changes>,
    pub diff_stat: String,
    pub code_revision: String,
    pub events: Vec<SessionEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_match_stored_format() {
        assert_eq!(rfc3339(0, 0), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339(1_700_000_000, 500_000_000),
            "2023-11-14T22:13:20.5Z"
        );
        assert_eq!(rfc3339(951_782_400, 1), "2000-02-29T00:00:00.000000001Z");
    }

    #[test]
    fn null_members_decode_as_zero_values() {
        let v: Session =
            decode(serde_json::json!({"id": "s", "context": null, "title": null})).unwrap();
        assert_eq!(
            (v.id.as_str(), v.title.as_str(), v.context.len()),
            ("s", "", 0)
        );
        assert_eq!(uuid().len(), 36);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VerificationCommand {
    pub name: String,
    pub argv: Vec<String>,
    pub timeout_seconds: u64,
    pub output_cap: usize,
}
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckRun {
    pub id: String,
    pub command: VerificationCommand,
    pub started_at: String,
    pub finished_at: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub outcome: String,
    pub output: String,
    pub truncated: bool,
    pub process_id: i64,
    pub process_birth: String,
}
