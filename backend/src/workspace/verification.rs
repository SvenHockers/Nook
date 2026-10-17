//! Explicit user-run commands. Configuration and consent are scoped to a project revision.
use super::*;
use crate::presentation::{Check, EvidenceData as Data, Recorded};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Configuration {
    pub revision: String,
    pub commands: Vec<VerificationCommand>,
    pub approved: bool,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunRequest {
    pub session_id: String,
    pub name: String,
    pub revision: String,
    pub confirm: bool,
}
pub(super) struct Running {
    child: Arc<process::Child>,
    reason: AtomicU8,
}
impl Running {
    fn cancel(&self, reason: u8) {
        let _ = self
            .reason
            .compare_exchange(0, reason, Ordering::SeqCst, Ordering::SeqCst);
        self.child.stop();
    }
}
fn validate(commands: &[VerificationCommand]) -> Res<()> {
    if commands.len() > 20 {
        return Err("Configure at most 20 checks".into());
    }
    let mut names = HashSet::new();
    for c in commands {
        if c.name.trim().is_empty()
            || c.name.len() > 100
            || !names.insert(&c.name)
            || c.argv.is_empty()
            || c.argv[0].is_empty()
            || c.argv.len() > 100
            || c.argv.iter().any(|a| a.contains('\0') || a.len() > 8192)
            || !(1..=3600).contains(&c.timeout_seconds)
            || !(1..=1024 * 1024).contains(&c.output_cap)
        {
            return Err("Checks need a unique name, argv, a 1–3600 second timeout and a 1–1048576 byte output cap".into());
        }
    }
    Ok(())
}
pub(super) fn records(run: &CheckRun) -> Vec<Recorded> {
    let result = if run.finished_at.is_empty() {
        "running"
    } else if run.outcome == "exited" {
        if run.exit_code == Some(0) {
            "passed"
        } else if run.exit_code.is_some() {
            "failed"
        } else {
            "unknown"
        }
    } else {
        "unknown"
    };
    vec![
        Recorded {
            label: "Verification".into(),
            data: Data::Tests {
                checks: vec![Check {
                    name: run.command.name.clone(),
                    result: result.into(),
                }],
            },
        },
        Recorded {
            label: "Check output".into(),
            data: Data::Text {
                text: format!(
                    "argv: {}\nStarted: {}\nFinished: {}\nOutcome: {}\nExit code: {:?}\n{}{}",
                    json!(run.command.argv),
                    run.started_at,
                    run.finished_at,
                    run.outcome,
                    run.exit_code,
                    run.output,
                    if run.truncated {
                        "\n[Output truncated]"
                    } else {
                        ""
                    }
                ),
            },
        },
        Recorded {
            label: "Check duration".into(),
            data: Data::Metric {
                value: run.duration_ms as f64,
                unit: "ms".into(),
            },
        },
    ]
}
impl Service {
    pub fn check_configuration(&self, project: &str) -> Res<Configuration> {
        if !lock(&self.st).projects.iter().any(|p| p.id == project) {
            return Err("Project not found".into());
        }
        Ok(
            serde_json::from_str(&self.db.setting(&format!("checks.{project}")))
                .unwrap_or_default(),
        )
    }
    pub fn configure_checks(
        &self,
        project: &str,
        commands: Vec<VerificationCommand>,
    ) -> Res<Configuration> {
        validate(&commands)?;
        let st = lock(&self.st);
        if st.closed || !st.projects.iter().any(|p| p.id == project) {
            return Err("Project unavailable".into());
        }
        let c = Configuration {
            revision: id(),
            commands,
            approved: false,
        };
        self.db.set_setting(
            &format!("checks.{project}"),
            &serde_json::to_string(&c).map_err(err)?,
        )?;
        Ok(c)
    }
    fn record_check(&self, session: &Session, run: &CheckRun) -> Res<()> {
        let mut e = SessionEvent {
            session_id: session.id.clone(),
            kind: "check".into(),
            time: now(),
            check: Some(run.clone()),
            recorded: records(run),
            ..Default::default()
        };
        self.db.commit_event(session, &mut e)
    }
    pub fn run_check(self: &Arc<Self>, req: RunRequest) -> Res<()> {
        let st = lock(&self.st);
        if st.closed || st.stopping.contains(&req.session_id) {
            return Err("Session is stopping".into());
        }
        let session = st
            .sessions
            .iter()
            .find(|s| s.id == req.session_id)
            .cloned()
            .ok_or("Session not found")?;
        if st.workflows.iter().any(|w| {
            (w.canceled || w.archived)
                && w.tasks.iter().any(|t| {
                    t.session_id == session.id
                        || t.attempts.iter().any(|a| a.session_id == session.id)
                })
        }) {
            return Err("This workflow is canceled or archived".into());
        }
        if session.archived {
            return Err("Session is archived".into());
        }
        let key = format!("checks.{}", session.project_id);
        let mut config: Configuration =
            serde_json::from_str(&self.db.setting(&key)).map_err(|_| "Configure checks first")?;
        if config.revision != req.revision {
            return Err("Check configuration changed; review the commands again".into());
        }
        validate(&config.commands)?;
        let command = config
            .commands
            .iter()
            .find(|c| c.name == req.name)
            .cloned()
            .ok_or("Check not found")?;
        if !config.approved {
            if !req.confirm {
                return Err(
                    "Confirm the exact project commands before first use; they are not sandboxed"
                        .into(),
                );
            }
            config.approved = true;
            self.db
                .set_setting(&key, &serde_json::to_string(&config).map_err(err)?)?;
        }
        let mut checking = lock(&self.checking);
        if checking.contains_key(&session.id) {
            return Err("A check is already running in this session".into());
        }
        let (child, stdout, stderr) = process::start_check(&command.argv, &session.cwd)?;
        let begun = Instant::now();
        let running = Arc::new(Running {
            child: child.clone(),
            reason: AtomicU8::new(0),
        });
        let mut run = CheckRun {
            id: id(),
            command,
            started_at: now(),
            outcome: "running".into(),
            process_id: child.pid as i64,
            ..Default::default()
        };
        let setup = process::identity(child.pid).and_then(|birth| {
            run.process_birth = birth;
            self.db.set_setting(
                &format!("check.running.{}", session.id),
                &serde_json::to_string(&run).map_err(err)?,
            )?;
            self.record_check(&session, &run)
        });
        if let Err(e) = setup {
            child.stop();
            let _ = child.wait();
            return Err(e);
        }
        checking.insert(session.id.clone(), running.clone());
        self.wg.add();
        let service = self.clone();
        thread::spawn(move || {
            let _done = OnDrop(|| service.wg.done());
            // Drain both streams even after the cap. Otherwise a full pipe can deadlock a check.
            let output = Arc::new(Mutex::new((Vec::<u8>::new(), false)));
            fn drain(
                mut pipe: impl Read + Send + 'static,
                output: Arc<Mutex<(Vec<u8>, bool)>>,
                cap: usize,
            ) -> thread::JoinHandle<()> {
                thread::spawn(move || {
                    let mut buf = [0; 8192];
                    loop {
                        match pipe.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let mut out = lock(&output);
                                let keep = n.min(cap.saturating_sub(out.0.len()));
                                out.0.extend_from_slice(&buf[..keep]);
                                out.1 |= keep < n;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                })
            }
            let out = drain(stdout, output.clone(), run.command.output_cap);
            let errs = drain(stderr, output.clone(), run.command.output_cap);
            let (tx, rx) = mpsc::channel();
            let timer = running.clone();
            let limit = run.command.timeout_seconds;
            let timeout = thread::spawn(move || {
                if matches!(
                    rx.recv_timeout(Duration::from_secs(limit)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    timer.cancel(2);
                }
            });
            // Waiting concurrently with drains also kills descendants retaining stdout after root exit.
            let status = child.wait();
            let _ = tx.send(());
            let _ = timeout.join();
            let _ = out.join();
            let _ = errs.join();
            run.duration_ms = begun.elapsed().as_millis() as u64;
            run.finished_at = now();
            run.exit_code = status.as_ref().ok().and_then(|s| s.code());
            run.outcome = match running.reason.load(Ordering::SeqCst) {
                1 => "canceled",
                2 => "timed out",
                _ if status.is_ok() => "exited",
                _ => "wait failed",
            }
            .into();
            let output = lock(&output);
            run.output = String::from_utf8_lossy(&output.0).into_owned();
            run.truncated = output.1 || run.output.len() > run.command.output_cap;
            truncate(&mut run.output, run.command.output_cap);
            let mut st = lock(&service.st);
            let result = st
                .sessions
                .iter()
                .find(|s| s.id == session.id)
                .ok_or("Session not found".into())
                .and_then(|s| service.record_check(s, &run))
                .and_then(|()| {
                    service
                        .db
                        .set_setting(&format!("check.running.{}", session.id), "")
                });
            if let Err(e) = result {
                st.fault = e;
            }
            lock(&service.checking).remove(&session.id);
            drop(st);
            service.signal("changed", Value::Null);
        });
        drop(checking);
        drop(st);
        self.signal("changed", Value::Null);
        Ok(())
    }
    pub fn cancel_check(&self, session: &str) -> Res<()> {
        let run = lock(&self.checking).get(session).cloned();
        if let Some(run) = run {
            run.cancel(1);
        }
        Ok(())
    }
    pub(super) fn cancel_checks(&self) {
        let runs: Vec<_> = lock(&self.checking).values().cloned().collect();
        for r in runs {
            r.cancel(1);
        }
    }
    pub(super) fn recover_checks(&self) -> Res<()> {
        let st = lock(&self.st);
        for s in &st.sessions {
            let key = format!("check.running.{}", s.id);
            if let Ok(mut run) = serde_json::from_str::<CheckRun>(&self.db.setting(&key)) {
                process::recover(run.process_id, &run.process_birth)?;
                run.finished_at = now();
                run.outcome = "interrupted".into();
                run.exit_code = None;
                self.record_check(s, &run)?;
                self.db.set_setting(&key, "")?;
            }
        }
        Ok(())
    }
}
