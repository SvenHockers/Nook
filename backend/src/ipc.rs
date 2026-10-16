//! The private newline-delimited desktop protocol: `{id, method, args}` in, `{id, result, error}`
//! and `{event, result}` out. stdin EOF is ownership loss: it always stops Nook's agent processes.
use crate::model::decode;
use crate::workspace::Service;
use crate::{desktop, err, lock, private_file, read_line, Gate, OnDrop, Res};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Request {
    pub id: u64,
    pub method: String,
    pub args: Vec<Value>,
}

fn reply(id: u64, r: Res<Value>) -> Value {
    let mut v = match r {
        Ok(result) => json!({"result": result}),
        Err(e) => json!({"result": null, "error": e}),
    };
    if id != 0 {
        v["id"] = id.into();
    }
    v
}

pub fn serve(
    mut input: impl BufRead,
    out: impl Write + Send + 'static,
    root: &Path,
    helper: &str,
) -> Res<()> {
    let out = Mutex::new(out);
    let write = Arc::new(move |v: Value| {
        let mut out = lock(&out);
        let _ = writeln!(out, "{v}").and_then(|()| out.flush());
    });
    let events = write.clone();
    let service = Service::new(
        root,
        helper,
        Some(Box::new(move |event: &str, data: Value| {
            events(json!({"event": format!("nook:{event}"), "result": data}))
        })),
    )?;
    let wg = Arc::new(Gate::default());
    let read_err = loop {
        let line = match read_line(&mut input, 2 * 1024 * 1024) {
            Ok(Some(line)) => line,
            Ok(None) => break None,
            Err(e) => break Some(e.to_string()),
        };
        let Some(req) = serde_json::from_slice(&line)
            .ok()
            .and_then(|v| decode::<Request>(v).ok())
        else {
            write(reply(0, Err("Malformed request".into())));
            continue;
        };
        if req.method == "Shutdown" {
            // An arrangement may be waiting on a model; quitting must not.
            service.cancel_presentations();
            wg.wait();
            let closed = service.close();
            write(reply(req.id, closed.clone().map(|()| true.into())));
            return closed;
        }
        // Independent requests may run concurrently, especially approvals and stop.
        wg.add();
        let (service, write, wg) = (service.clone(), write.clone(), wg.clone());
        thread::spawn(move || {
            let _done = OnDrop(|| wg.done());
            write(reply(req.id, dispatch(&service, &req)));
        });
    };
    service.cancel_presentations();
    wg.wait();
    let closed = service.close();
    read_err.map_or(closed, Err)
}

fn arg<T: DeserializeOwned + Default>(r: &Request, i: usize) -> Res<T> {
    match r.args.get(i) {
        None => Err("Missing argument".into()),
        Some(Value::Null) => Ok(T::default()),
        Some(v) => decode(v.clone()),
    }
}
fn ok<T: Serialize>(r: Res<T>) -> Res<Value> {
    r.and_then(|v| serde_json::to_value(v).map_err(err))
}

pub fn dispatch(s: &Arc<Service>, r: &Request) -> Res<Value> {
    match r.method.as_str() {
        "Snapshot" => return ok(Ok(s.snapshot())),
        "RefreshProviders" => return ok(Ok(s.refresh_providers())),
        "Navigation" => return ok(Ok(s.navigation())),
        "AddProject" => return ok(s.add_project(&arg::<String>(r, 0)?)),
        "CreateWorkflow" => return ok(s.create_workflow(arg(r, 0)?)),
        "StartWorkflowTask" => return ok(s.start_workflow_task(arg(r, 0)?)),
        "AcceptWorkflowTask" => return ok(s.accept_workflow_task(arg(r, 0)?)),
        "WorkflowEvidence" => return ok(s.workflow_evidence(arg(r, 0)?)),
        "PresentSession" => return ok(s.present_session(arg(r, 0)?)),
        "Launch" => return ok(s.launch(arg(r, 0)?)),
        "Respond" => return ok(s.respond(arg(r, 0)?)),
        "SaveNavigation" => return ok(s.save_navigation(&arg::<String>(r, 0)?)),
        _ => {}
    }
    if !matches!(
        r.method.as_str(),
        "Stop"
            | "Archive"
            | "CancelPresentation"
            | "Changes"
            | "Reveal"
            | "Send"
            | "Rename"
            | "SetExecutable"
            | "Events"
            | "Context"
            | "ExportPatch"
    ) {
        return Err(format!("Unknown method: {}", r.method));
    }
    let id: String = arg(r, 0)?;
    match r.method.as_str() {
        "Stop" => ok(s.stop(&id)),
        "Archive" => ok(s.archive(&id)),
        "CancelPresentation" => ok(s.cancel_presentation(&id)),
        "Changes" => ok(s.changes(&id)),
        "Reveal" => ok(s.session(&id).and_then(|v| desktop::reveal(&v.cwd))),
        "Send" => ok(s.send(&id, &arg::<String>(r, 1)?)),
        "Rename" => ok(s.rename(&id, &arg::<String>(r, 1)?)),
        "SetExecutable" => ok(s.set_executable(&id, &arg::<String>(r, 1)?)),
        "Events" => ok(s.events(&id, arg(r, 1)?)),
        "Context" => ok(s.context(&id, arg(r, 1)?, arg(r, 2)?)),
        "ExportPatch" => {
            let path: String = arg(r, 1)?;
            if !Path::new(&path).is_absolute() {
                return Err("Choose an absolute export path".into());
            }
            let patch = s.patch(&id)?;
            private_file(
                Path::new(&path),
                OpenOptions::new().write(true).create(true).truncate(true),
            )
            .and_then(|mut f| f.write_all(&patch))
            .map_err(err)?;
            Ok(path.into())
        }
        _ => Err(format!("Unknown method: {}", r.method)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CreateWorkflowRequest, Project, Workflow, WorkflowAction, WorkflowTask};
    use crate::TempDir;

    /// Collects serve() output in memory.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn replies(sink: &Sink) -> Vec<Value> {
        let out = lock(&sink.0).clone();
        out.split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice::<Value>(l).unwrap())
            .filter(|v| v.get("event").is_none())
            .collect()
    }

    #[test]
    fn malformed_and_unknown_requests_do_not_crash_runtime() {
        let dir = TempDir::new();
        let sink = Sink::default();
        let input = "{bad}\n{\"id\":1,\"method\":\"UntrustedCommand\",\"args\":[\"anything\"]}\n{\"id\":2,\"method\":\"Shutdown\",\"args\":[]}\n";
        serve(input.as_bytes(), sink.clone(), &dir.0, "").unwrap();
        let by_id = |id: u64| {
            replies(&sink)
                .into_iter()
                .find(|r| r["id"].as_u64().unwrap_or(0) == id)
                .unwrap()
        };
        assert_eq!(by_id(0)["error"], "Malformed request");
        assert!(by_id(1)["error"]
            .as_str()
            .unwrap()
            .contains("Unknown method"));
        assert!(by_id(2).get("error").is_none());
    }

    #[test]
    fn standard_presentation_round_trips_through_stdio() {
        let dir = TempDir::new();
        let db = crate::store::Store::open(&dir.0.join("nook.sqlite")).unwrap();
        db.put_session(&crate::model::Session {
            id: "recorded".into(),
            state: crate::model::COMPLETED.into(),
            ..Default::default()
        })
        .unwrap();
        db.close().unwrap();
        let sink = Sink::default();
        let input = concat!(
            "{\"id\":1,\"method\":\"PresentSession\",\"args\":[{\"sessionId\":\"recorded\",\"revision\":0,\"arrange\":false}]}\n",
            "{\"id\":2,\"method\":\"Shutdown\",\"args\":[]}\n"
        );
        serve(input.as_bytes(), sink.clone(), &dir.0, "").unwrap();
        let reply = replies(&sink).into_iter().find(|r| r["id"] == 1).unwrap();
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(reply["result"]["mode"], "standard");
        assert_eq!(reply["result"]["source"]["id"], "recorded");
        assert!(reply["result"]["evidence"].is_array());
    }

    #[test]
    fn unknown_method_with_no_arguments_is_not_a_validation_error() {
        let dir = TempDir::new();
        let s = Service::new(&dir.0, "", None).unwrap();
        let result = dispatch(
            &s,
            &Request {
                method: "MissingCommand".into(),
                ..Default::default()
            },
        );
        assert_eq!(result.unwrap_err(), "Unknown method: MissingCommand");
        s.close().unwrap();
    }

    #[test]
    fn eof_closes_database_and_retains_state() {
        let dir = TempDir::new();
        serve(&b"{\"id\":1,\"method\":\"SaveNavigation\",\"args\":[\"{\\\"theme\\\":\\\"dark\\\"}\"]}\n"[..], Sink::default(), &dir.0, "").unwrap();
        let sink = Sink::default();
        serve(
            &b"{\"id\":2,\"method\":\"Navigation\",\"args\":[]}\n"[..],
            sink.clone(),
            &dir.0,
            "",
        )
        .unwrap();
        let reply = replies(&sink)
            .into_iter()
            .find(|r| r["id"] == 2)
            .expect("missing navigation response");
        assert_eq!(reply["result"], "{\"theme\":\"dark\"}");
    }

    #[test]
    fn workflow_commands_reach_service_and_enforce_dependencies() {
        let dir = TempDir::new();
        let s = Service::new(&dir.0, "", None).unwrap();
        let req = |method: &str, arg: Value| Request {
            method: method.into(),
            args: vec![arg],
            ..Default::default()
        };
        let project_dir = TempDir::new();
        let p: Project =
            serde_json::from_value(dispatch(&s, &req("AddProject", json!(project_dir.0))).unwrap())
                .unwrap();
        let task = |id: &str, deps: &[&str]| WorkflowTask {
            id: id.into(),
            title: id.into(),
            prompt: id.into(),
            provider: "codex".into(),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            ..Default::default()
        };
        let create = CreateWorkflowRequest {
            project_id: p.id,
            goal: "Review a handoff".into(),
            tasks: vec![task("a", &[]), task("b", &["a"])],
        };
        let w: Workflow = serde_json::from_value(
            dispatch(
                &s,
                &req("CreateWorkflow", serde_json::to_value(create).unwrap()),
            )
            .unwrap(),
        )
        .unwrap();
        let start = WorkflowAction {
            workflow_id: w.id,
            task_id: "b".into(),
            revision: w.revision,
            ..Default::default()
        };
        let e = dispatch(
            &s,
            &req("StartWorkflowTask", serde_json::to_value(start).unwrap()),
        )
        .unwrap_err();
        assert!(e.contains("dependency"), "{e}");
        s.close().unwrap();
    }
}
