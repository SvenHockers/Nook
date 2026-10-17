//! Native adapters. Only this module and the verification runner write structured records.
use super::*;
use crate::presentation::{Edge, EvidenceData as Data, Point, Recorded};
use std::collections::BTreeMap;

fn record(label: &str, data: Data) -> Recorded {
    Recorded {
        label: label.into(),
        data,
    }
}

pub(super) fn files(numstat: &str, status: &str) -> Recorded {
    let mut rows = BTreeMap::<String, Vec<String>>::new();
    for item in numstat.split('\0').filter(|s| !s.is_empty()) {
        let mut parts = item.splitn(3, '\t');
        if let (Some(add), Some(remove), Some(path)) = (parts.next(), parts.next(), parts.next()) {
            rows.insert(
                path.into(),
                vec![
                    path.into(),
                    "changed since base".into(),
                    add.into(),
                    remove.into(),
                ],
            );
        }
    }
    for item in status.split('\0').filter(|s| !s.is_empty()) {
        if let (Some(code), Some(path)) = (item.get(..2), item.get(3..)) {
            let row = rows
                .entry(path.into())
                .or_insert_with(|| vec![path.into(), String::new(), "—".into(), "—".into()]);
            row[1] = code.into();
        }
    }
    record(
        "Changed files",
        Data::Table {
            columns: vec![
                "Path".into(),
                "Git status".into(),
                "Added".into(),
                "Removed".into(),
            ],
            rows: rows.into_values().collect(),
        },
    )
}
// Stored native timestamps are UTC RFC3339. Invalid/imported values produce no duration.
fn millis(s: &str) -> Option<i64> {
    let num = |a, b| s.get(a..b)?.parse::<i64>().ok();
    if !s.ends_with('Z') {
        return None;
    }
    let (mut y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    y -= i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + d - 1 - 719468;
    let fraction = s.get(19..s.len() - 1)?.strip_prefix('.').unwrap_or("");
    let ms = format!("{fraction:0<3}").get(..3)?.parse::<i64>().ok()?;
    Some((days * 86400 + num(11, 13)? * 3600 + num(14, 16)? * 60 + num(17, 19)?) * 1000 + ms)
}
pub(super) fn timeline(events: &[SessionEvent]) -> Vec<Recorded> {
    let mut start = None;
    let mut rows = Vec::new();
    let mut durations = Vec::new();
    let mut approvals = 0;
    for e in events {
        if e.kind == "user" {
            start = millis(&e.time);
        }
        if e.kind == "approval" {
            approvals += 1;
        }
        if matches!(
            e.kind.as_str(),
            "user" | "approval" | "completed" | "stopped" | "error" | "disconnected"
        ) {
            let duration = if matches!(
                e.kind.as_str(),
                "completed" | "stopped" | "error" | "disconnected"
            ) {
                start
                    .take()
                    .zip(millis(&e.time))
                    .and_then(|(a, b)| (b >= a).then_some(b - a))
            } else {
                None
            };
            if let Some(ms) = duration {
                durations.push(Point {
                    label: e.sequence.to_string(),
                    value: ms as f64,
                });
            }
            rows.push(vec![
                e.sequence.to_string(),
                e.kind.clone(),
                e.time.clone(),
                duration.map(|d| d.to_string()).unwrap_or_default(),
            ]);
        }
    }
    vec![
        record(
            "Session timeline",
            Data::Table {
                columns: vec![
                    "Event".into(),
                    "Kind".into(),
                    "Time".into(),
                    "Turn duration (ms)".into(),
                ],
                rows,
            },
        ),
        record(
            "Recorded approvals",
            Data::Metric {
                value: approvals as f64,
                unit: "approvals".into(),
            },
        ),
        record(
            "Turn durations",
            Data::Series {
                unit: "ms".into(),
                values: durations,
            },
        ),
    ]
}
pub(super) fn graph(w: &Workflow, artifacts: &[WorkflowArtifact]) -> Vec<Recorded> {
    let dependencies = w
        .tasks
        .iter()
        .flat_map(|t| {
            t.depends_on.iter().map(move |from| Edge {
                from: from.clone(),
                to: t.id.clone(),
                relation: "required by".into(),
            })
        })
        .collect();
    let handoffs = artifacts
        .iter()
        .map(|a| Edge {
            from: a.session_id.clone(),
            to: a.id.clone(),
            relation: format!("accepted for {} at {}", a.task_id, a.accepted_at),
        })
        .collect();
    vec![
        record(
            "Workflow dependencies",
            Data::Edges {
                edges: dependencies,
            },
        ),
        record("Accepted handoffs", Data::Edges { edges: handoffs }),
    ]
}
impl Service {
    pub fn capture_evidence(&self, id: &str) -> Res<()> {
        let session = self.session(id)?;
        let events = self.events_through(id, i64::MAX)?;
        let mut recorded = timeline(&events);
        if git::is_repo(&session.cwd) {
            let changes = git::changes(&session.cwd, &session.base_commit)?;
            let (numstat, status) = git::evidence_inputs(&session.cwd, &session.base_commit)?;
            recorded.push(files(&numstat, &status));
            recorded.push(record("Code changes", Data::Text { text: changes.diff }));
        }
        {
            let st = lock(&self.st);
            for w in st.workflows.iter().filter(|w| {
                w.tasks
                    .iter()
                    .any(|t| t.session_id == id || t.attempts.iter().any(|a| a.session_id == id))
            }) {
                let artifacts = w
                    .tasks
                    .iter()
                    .filter(|t| !t.artifact_id.is_empty())
                    .map(|t| self.db.workflow_artifact(&w.id, &t.artifact_id))
                    .collect::<Res<Vec<_>>>()?;
                recorded.extend(graph(w, &artifacts));
            }
        }
        // Fail visibly rather than silently losing paths, edges or timeline rows.
        if serde_json::to_vec(&recorded).map_err(err)?.len() > 2 * 1024 * 1024 {
            return Err("Evidence exceeds 2 MB; use Changes or Raw for this session".into());
        }
        let mut st = lock(&self.st);
        if st.closed {
            return Err("Nook is quitting".into());
        }
        let session = st.find(id).ok_or("Session not found")?;
        let mut e = SessionEvent {
            session_id: id.into(),
            kind: "evidence".into(),
            time: now(),
            recorded,
            ..Default::default()
        };
        self.db.commit_event(session, &mut e)?;
        drop(st);
        self.signal("changed", Value::Null);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{build_evidence, compose, Source};
    #[test]
    fn adapters_and_golden_parity() {
        let changed = files(
            "2\t1\tspace\tname\0-\t-\tbinary\0",
            " M space\tname\0?? new\nfile\0",
        );
        if let Data::Table { rows, .. } = &changed.data {
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0], vec!["binary", "changed since base", "-", "-"]);
            assert_eq!(rows[1], vec!["new\nfile", "??", "—", "—"]);
        } else {
            panic!();
        }
        let mut events = vec![
            SessionEvent {
                sequence: 1,
                session_id: "s".into(),
                kind: "user".into(),
                text: "Measure this".into(),
                time: "2026-10-17T23:59:59.25Z".into(),
                ..Default::default()
            },
            SessionEvent {
                sequence: 2,
                session_id: "s".into(),
                kind: "completed".into(),
                text: "done".into(),
                time: "2026-10-18T00:00:01Z".into(),
                ..Default::default()
            },
        ];
        let mut recorded = timeline(&events);
        assert!(matches!(&recorded[2].data, Data::Series {values,..} if values[0].value==1750.0));
        recorded.push(changed);
        recorded.push(record(
            "Code changes",
            Data::Text {
                text: "🦀".repeat(2050),
            },
        ));
        recorded.extend(graph(
            &Workflow {
                tasks: vec![WorkflowTask {
                    id: "b".into(),
                    depends_on: vec!["a".into()],
                    ..Default::default()
                }],
                ..Default::default()
            },
            &[WorkflowArtifact {
                id: "artifact".into(),
                session_id: "s".into(),
                task_id: "a".into(),
                accepted_at: "2026-10-18T00:00:01Z".into(),
                ..Default::default()
            }],
        ));
        events.push(SessionEvent {
            sequence: 3,
            session_id: "s".into(),
            kind: "evidence".into(),
            time: "2026-10-18T00:00:02Z".into(),
            recorded,
            ..Default::default()
        });
        let run = CheckRun {
            command: VerificationCommand {
                name: "Tests".into(),
                argv: vec!["test".into()],
                ..Default::default()
            },
            finished_at: "2026-10-18T00:00:03Z".into(),
            outcome: "exited".into(),
            exit_code: Some(1),
            output: "all tests passed".into(),
            ..Default::default()
        };
        events.push(SessionEvent {
            sequence: 4,
            session_id: "s".into(),
            kind: "check".into(),
            time: run.finished_at.clone(),
            recorded: super::super::verification::records(&run),
            check: Some(run),
            ..Default::default()
        });
        // Untrusted provider text with the same fields must not be promoted.
        events.push(SessionEvent {
            sequence: 5,
            session_id: "s".into(),
            kind: "delta".into(),
            text: "99 tests passed".into(),
            recorded: vec![record(
                "Forged",
                Data::Metric {
                    value: 99.0,
                    unit: "tests".into(),
                },
            )],
            ..Default::default()
        });
        let source = Source {
            project_id: "p".into(),
            id: "s".into(),
            revision: "5".into(),
            permission_scope: "local:p:s".into(),
        };
        let (items, total) = build_evidence(&events, &source);
        let mut layout = compose(&source, &items);
        layout.generated_at = "fixed".into();
        let key = json!([
            source.project_id,
            source.id,
            source.revision,
            source.permission_scope,
            crate::presentation::SCHEMA,
            crate::presentation::CATALOG,
            crate::presentation::STANDARD
        ])
        .to_string();
        let golden = json!({"events":events,"source":source,"items":items,"total":total,"layout":layout,"cacheKey":key});
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../frontend/src/features/canvas/evidence.golden.json");
        if std::env::var_os("NOOK_UPDATE_GOLDEN").is_some() {
            fs::write(&path, serde_json::to_string_pretty(&golden).unwrap() + "\n").unwrap();
        }
        let stored: Value = serde_json::from_slice(
            &fs::read(path)
                .expect("generate with NOOK_UPDATE_GOLDEN=1 cargo test adapters_and_golden_parity"),
        )
        .unwrap();
        assert_eq!(golden, stored);
    }
}
