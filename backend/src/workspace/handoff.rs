//! Bounded downstream references. Full events remain in the immutable audit artifact.
use crate::model::WorkflowArtifact;
use crate::presentation::{build_evidence, EvidenceData, Source};
use crate::{err, truncate, Res};
use serde_json::json;

pub const HANDOFF_LIMIT: usize = 48 * 1024;
pub const REFERENCE_BUDGET: usize = 128 * 1024;
const OMITTED: &str = "[Older records omitted]\n";

pub fn curate(a: &mut WorkflowArtifact) {
    let events: Vec<_> = a
        .events
        .iter()
        .filter(|e| {
            matches!(
                e.kind.as_str(),
                "user" | "delta" | "completed" | "stopped" | "error" | "disconnected"
            )
        })
        .cloned()
        .collect();
    let source = Source {
        id: a.session_id.clone(),
        project_id: a.project_id.clone(),
        revision: a.revision.to_string(),
        ..Default::default()
    };
    let (items, total) = build_evidence(&events, &source);
    let mut records = Vec::new();
    let mut size = 0;
    for e in items.iter().rev() {
        if let EvidenceData::Text { text } = &e.data {
            let record = format!("{} ({}): {}\n", e.label, e.attribution, text);
            if size + record.len() + OMITTED.len() > HANDOFF_LIMIT {
                break;
            }
            size += record.len();
            records.push(record);
        }
    }
    a.omitted_records = total - records.len();
    records.reverse();
    a.handoff = if a.omitted_records > 0 {
        OMITTED.into()
    } else {
        String::new()
    };
    a.handoff += &records.concat();
    a.handoff_bytes = a.handoff.len();
}

/// Reserve a fair share for every dependency, including JSON escaping and metadata.
pub fn reference(a: &WorkflowArtifact, budget: usize) -> Res<String> {
    let mut handoff = a.handoff.clone();
    // Old artifacts predate curated handoffs.
    if handoff.is_empty() {
        let mut old = a.clone();
        curate(&mut old);
        handoff = old.handoff;
    }
    let mut stat = a.diff_stat.clone();
    truncate(&mut stat, 1024);
    loop {
        let value = serde_json::to_string(&json!({
            "taskId": a.task_id, "sessionId": a.session_id, "artifactId": a.id,
            "sourceRevision": a.revision, "headCommit": a.head_commit,
            "diffStat": stat, "handoff": handoff,
            "code": "Frozen diff is available in the accepted handoff. Files are not merged."
        }))
        .map_err(err)?;
        if value.len() <= budget {
            return Ok(value);
        }
        // Keep recent output; preserve UTF-8 and explicitly disclose any further omission.
        if handoff.len() <= OMITTED.len() {
            return Err("Handoff metadata exceeds its budget".into());
        }
        if handoff.len() <= 2 * OMITTED.len() + 4 {
            handoff = OMITTED.into();
            continue;
        }
        let mut start = handoff.len() / 2;
        while !handoff.is_char_boundary(start) {
            start += 1;
        }
        handoff = format!("{OMITTED}{}", &handoff[start..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SessionEvent, WorkflowArtifact};

    #[test]
    fn verbose_unicode_and_escaped_records_fit_every_dependency_budget() {
        let mut a = WorkflowArtifact {
            session_id: "session".into(),
            ..Default::default()
        };
        a.events = (1..=400)
            .map(|n| SessionEvent {
                session_id: "session".into(),
                sequence: n,
                kind: if n % 2 == 0 { "delta" } else { "working" }.into(),
                text: format!("record {n}: {}", "🦀\"\n".repeat(800)),
                item_id: n.to_string(),
                ..Default::default()
            })
            .collect();
        curate(&mut a);
        assert!(a.handoff_bytes <= HANDOFF_LIMIT);
        assert!(a.omitted_records > 0);
        assert!(a.handoff.contains("Older records omitted"));
        assert!(a.handoff.contains("record 400"));
        assert!(!a.handoff.contains("record 399"));
        for count in 1..=30 {
            let serialized = reference(&a, REFERENCE_BUDGET / count).unwrap();
            assert!(serialized.len() * count <= REFERENCE_BUDGET);
            assert!(serde_json::from_str::<serde_json::Value>(&serialized).is_ok());
        }
        assert!(reference(&a, 1).is_err());
    }
}
