//! The workspace owns projects, sessions, runtimes and pending approvals.
//! A runtime generation scopes incoming events: output from a stopped or replaced process
//! can never update the new generation.
mod presentation;
mod workflow;

use crate::model::{self, event, id, now, *};
use crate::provider::{self, Config, Runtime};
use crate::store::Store;
use crate::{err, git, lock, process, truncate, Gate, OnDrop, Res};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

pub type Notify = Box<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone, Default)]
struct RuntimeEntry {
    ready: Option<Arc<Gate>>,
    generation: String,
    runtime: Option<Arc<dyn Runtime>>,
}
#[derive(Default)]
struct State {
    projects: Vec<Project>,
    sessions: Vec<Session>,
    workflows: Vec<Workflow>,
    providers: Vec<ProviderInfo>,
    runtimes: HashMap<String, RuntimeEntry>,
    approvals: HashMap<String, ApprovalRequest>,
    stopping: HashSet<String>,
    closed: bool,
    fault: String,
}
impl State {
    fn find(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|v| v.id == id)
    }
}

pub struct Service {
    st: Mutex<State>,
    db: Store,
    root: PathBuf,
    helper: String,
    wg: Gate,
    notify: Option<Notify>,
    presenting: Mutex<HashMap<String, Arc<presentation::Presenting>>>,
}

/// Resolves symlinks without Windows' `\\?\` prefix, which agents and Git mishandle.
fn real_path(p: &Path) -> std::io::Result<PathBuf> {
    let p = fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}").into());
        }
        if let Some(local) = s.strip_prefix(r"\\?\") {
            return Ok(local.into());
        }
    }
    Ok(p)
}
fn same_path(a: &str, b: &Path) -> bool {
    matches!((real_path(Path::new(a)), real_path(b)), (Ok(x), Ok(y)) if x == y)
}
fn provider_info(providers: &[ProviderInfo], id: &str) -> Res<ProviderInfo> {
    match providers.iter().find(|p| p.id == id) {
        Some(p) if !p.available => Err(p.problem.clone()),
        Some(p) => Ok(p.clone()),
        None => Err("Provider not found".into()),
    }
}

fn context_prompt(v: &Session, prompt: &str) -> Res<String> {
    let mut b = String::new();
    for c in v.context.iter().filter(|c| c.enabled) {
        // Writing to a String cannot fail.
        match c.kind.as_str() {
            "note" => {
                let _ = write!(b, "\nProject note ({}):\n{}\n", c.name, c.value);
            }
            "file" => {
                let meta = fs::metadata(&c.value)
                    .map_err(|_| format!("Context file {} is unavailable", c.name))?;
                if meta.len() > 256 * 1024 {
                    return Err(format!(
                        "Context file {} exceeds 256 KB; choose a smaller text file",
                        c.name
                    ));
                }
                let data = fs::read(&c.value).map_err(err)?;
                if data.contains(&0) {
                    return Err(format!("Context file {} is not a text file", c.name));
                }
                let _ = write!(
                    b,
                    "\nAttached reference ({}):\n{}\n",
                    c.name,
                    String::from_utf8_lossy(&data)
                );
            }
            "folder" => {
                let _ = write!(
                    b,
                    "\nReference folder: {} (access remains subject to provider permissions).\n",
                    c.value
                );
            }
            _ => {}
        }
        if b.len() > 512 * 1024 {
            return Err("Selected context exceeds 512 KB".into());
        }
    }
    if b.is_empty() {
        return Ok(prompt.into());
    }
    Ok(format!(
        "Project context supplied by the user:\n{b}\nCurrent task:\n{prompt}"
    ))
}

impl Service {
    pub fn new(root: &Path, helper: &str, notify: Option<Notify>) -> Res<Arc<Service>> {
        let db = Store::open(&root.join("nook.sqlite"))?;
        let (projects, mut sessions) = db.load()?;
        for v in &mut sessions {
            match process::recover(v.process_id, &v.process_birth) {
                Err(e) => {
                    v.state = DISCONNECTED.into();
                    v.error = format!("Could not reconcile the previous process: {e}");
                }
                Ok(()) => {
                    v.process_id = 0;
                    v.process_birth.clear();
                }
            }
            if model::active(&v.state) {
                v.state = DISCONNECTED.into();
                v.activity = "Nook was interrupted. Resume when ready.".into();
                v.updated_at = now();
            }
            db.put_session(v)?;
        }
        let workflows = db.workflows()?;
        let s = Service::with(db, root, helper, notify);
        {
            let mut st = lock(&s.st);
            (st.projects, st.sessions, st.workflows) = (projects, sessions, workflows);
        }
        s.refresh_providers();
        Ok(s)
    }
    fn with(db: Store, root: &Path, helper: &str, notify: Option<Notify>) -> Arc<Service> {
        Arc::new(Service {
            st: Mutex::default(),
            db,
            root: root.into(),
            helper: helper.into(),
            wg: Gate::default(),
            notify,
            presenting: Mutex::default(),
        })
    }
    fn signal(&self, name: &str, v: Value) {
        if let Some(notify) = &self.notify {
            notify(name, v);
        }
    }
    pub fn refresh_providers(&self) -> Vec<ProviderInfo> {
        let overrides: HashMap<_, _> = ["claude", "codex"]
            .map(|id| (id.to_string(), self.db.setting(&format!("provider.{id}"))))
            .into();
        let ps = provider::discover(&overrides);
        lock(&self.st).providers = ps.clone();
        self.signal("changed", Value::Null);
        ps
    }
    pub fn set_executable(&self, id: &str, path: &str) -> Res<()> {
        if id != "claude" && id != "codex" {
            return Err("Unknown provider".into());
        }
        let path = if path.is_empty() {
            String::new()
        } else {
            std::path::absolute(path)
                .map_err(err)?
                .to_string_lossy()
                .into_owned()
        };
        self.db.set_setting(&format!("provider.{id}"), &path)?;
        self.refresh_providers();
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        let st = lock(&self.st);
        Snapshot {
            workflows: st
                .workflows
                .iter()
                .map(|w| workflow::project(&st.sessions, w))
                .collect(),
            problem: st.fault.clone(),
            projects: st.projects.clone(),
            sessions: st.sessions.clone(),
            providers: st.providers.clone(),
            approvals: st.approvals.values().cloned().collect(),
        }
    }
    pub fn add_project(&self, path: &str) -> Res<Project> {
        let path = real_path(&std::path::absolute(path).map_err(err)?).map_err(err)?;
        if !path.is_dir() {
            return Err("Choose an existing folder".into());
        }
        let mut st = lock(&self.st);
        if let Some(p) = st.projects.iter().find(|p| same_path(&p.path, &path)) {
            return Ok(p.clone());
        }
        let full = path.to_string_lossy().into_owned();
        let name = path
            .file_name()
            .map_or_else(|| full.clone(), |n| n.to_string_lossy().into_owned());
        let p = Project {
            id: id(),
            name,
            git: git::is_repo(&full),
            path: full,
            context: vec![],
        };
        self.db.put_project(&p)?;
        st.projects.push(p.clone());
        Ok(p)
    }
    pub fn launch(self: &Arc<Self>, req: LaunchRequest) -> Res<Session> {
        let r = self.launch_locked(&mut lock(&self.st), req, |_, v| self.db.put_session(v));
        self.signal("changed", Value::Null);
        r
    }
    fn launch_locked(
        self: &Arc<Self>,
        st: &mut State,
        req: LaunchRequest,
        persist: impl FnOnce(&mut State, &Session) -> Res<()>,
    ) -> Res<Session> {
        if req.prompt.trim().is_empty() {
            return Err("Describe the task first".into());
        }
        if req.prompt.len() > 256 * 1024 {
            return Err("Prompt is too large".into());
        }
        if st.closed {
            return Err("Nook is quitting".into());
        }
        let p = st
            .projects
            .iter()
            .find(|p| p.id == req.project_id)
            .cloned()
            .ok_or("Project not found")?;
        let info = provider_info(&st.providers, &req.provider)?;
        let mut v = Session {
            id: id(),
            project_id: p.id.clone(),
            provider: req.provider.clone(),
            title: req.title.trim().into(),
            cwd: p.path.clone(),
            created_at: now(),
            updated_at: now(),
            state: STARTING.into(),
            activity: "Preparing a place to work".into(),
            context: p.context.clone(),
            capabilities: info.capabilities.clone(),
            ..Default::default()
        };
        if v.title.is_empty() {
            v.title = req.prompt.clone();
            if v.title.chars().count() > 64 {
                v.title = v.title.chars().take(64).collect::<String>() + "…";
            }
        }
        let n = st.sessions.len() as i64;
        v.avatar = Avatar {
            shape: n % 5,
            color: n % 6,
            name: v.title.clone(),
        };
        if p.git && !req.shared {
            (v.cwd, v.branch, v.base_commit) =
                git::create(&p.path, &self.root.join("worktrees"), &v.id)?;
            v.isolated = true;
        }
        persist(st, &v)?;
        st.sessions.push(v.clone());
        self.start_locked(st, v.clone(), info, req.prompt);
        Ok(v)
    }
    fn start_locked(
        self: &Arc<Self>,
        st: &mut State,
        v: Session,
        info: ProviderInfo,
        prompt: String,
    ) {
        let generation = id();
        let ready = Arc::new(Gate::new(1));
        st.runtimes.insert(
            v.id.clone(),
            RuntimeEntry {
                ready: Some(ready.clone()),
                generation: generation.clone(),
                runtime: None,
            },
        );
        self.wg.add();
        let s = self.clone();
        thread::spawn(move || {
            let _done = OnDrop(|| {
                ready.done();
                s.wg.done();
            });
            s.run(v, info, &prompt, &generation);
        });
    }
    fn run(self: &Arc<Self>, v: Session, info: ProviderInfo, prompt: &str, generation: &str) {
        let emit: provider::Emit = {
            let (s, id, generation) = (Arc::downgrade(self), v.id.clone(), generation.to_string());
            Arc::new(move |e| {
                if let Some(s) = s.upgrade() {
                    s.ingest(&id, &generation, e);
                }
            })
        };
        if fs::metadata(&v.cwd).is_err() {
            return emit(event(
                "error",
                "The working folder is unavailable. Restore it before resuming.",
            ));
        }
        let rt = match provider::start(Config {
            info,
            session: v.clone(),
            emit: emit.clone(),
            helper: self.helper.clone(),
        }) {
            Ok(rt) => rt,
            Err(e) => return emit(event("error", &provider::explain_error(&e))),
        };
        let current = {
            let mut st = lock(&self.st);
            let closed = st.closed;
            match st.runtimes.get_mut(&v.id) {
                Some(entry) if !closed && entry.generation == generation => {
                    entry.runtime = Some(rt.clone());
                    true
                }
                _ => false,
            }
        };
        if !current {
            return rt.stop();
        }
        let full = match context_prompt(&v, prompt) {
            Ok(full) => full,
            Err(e) => {
                emit(event("error", &e));
                return rt.stop();
            }
        };
        emit(SessionEvent {
            kind: "user".into(),
            text: prompt.into(),
            item_id: id(),
            ..Default::default()
        });
        emit(event("working", "Working on your task"));
        if let Err(e) = rt.send(&full) {
            emit(event("error", &provider::explain_error(&e)));
        }
    }
    fn ingest(&self, id: &str, generation: &str, mut e: SessionEvent) {
        let mut guard = lock(&self.st);
        if guard.closed
            || guard
                .runtimes
                .get(id)
                .is_none_or(|r| r.generation != generation)
        {
            return;
        }
        let st = &mut *guard;
        let Some(v) = st.sessions.iter_mut().find(|v| v.id == id) else {
            return;
        };
        e.session_id = id.into();
        e.time = now();
        if e.text.len() > 1024 * 1024 {
            truncate(&mut e.text, 1024 * 1024);
            e.text += "\n[Truncated]";
        }
        v.updated_at = e.time.clone();
        let mut attention = false;
        match e.kind.as_str() {
            "process" => {
                let identity: Value = serde_json::from_str(&e.text).unwrap_or_default();
                if identity.is_object() {
                    v.process_id = identity["pid"].as_i64().unwrap_or(0);
                    v.process_birth = identity["birth"].as_str().unwrap_or("").into();
                }
            }
            "process_clear" => {
                v.process_id = 0;
                v.process_birth.clear();
            }
            "provider_id" => v.provider_id = e.text.clone(),
            "working" => {
                v.state = WORKING.into();
                v.error.clear();
                v.activity = e.text.clone();
            }
            "activity" => v.activity = e.text.clone(),
            "approval" => {
                if let Some(a) = e.approval.as_mut() {
                    a.session_id = id.into();
                    st.approvals.insert(a.id.clone(), a.clone());
                    v.state = WAITING.into();
                    v.activity = a.title.clone();
                    attention = true;
                }
            }
            "resolved" => {
                st.approvals.remove(&e.item_id);
                if v.state == WAITING && !st.approvals.values().any(|a| a.session_id == id) {
                    v.state = WORKING.into();
                    v.activity = "Continuing your task".into();
                }
            }
            "completed" => {
                v.state = COMPLETED.into();
                v.activity = e.text.clone();
            }
            "stopped" => {
                v.state = STOPPED.into();
                v.activity = e.text.clone();
            }
            "error" | "disconnected" => {
                let disconnected = e.kind == "disconnected";
                v.state = if disconnected { DISCONNECTED } else { FAILED }.into();
                v.error = e.text.clone();
                v.activity = if disconnected {
                    "Connection lost"
                } else {
                    "Needs your attention"
                }
                .into();
                attention = true;
            }
            _ => {}
        }
        if !model::active(&v.state) {
            st.approvals.retain(|_, a| a.session_id != id);
        }
        let title = v.title.clone();
        if let Err(err) = self.db.commit_event(v, &mut e) {
            st.fault = format!("Could not save session activity: {err}");
        }
        drop(guard);
        self.signal("changed", Value::Null);
        if attention {
            self.signal(
                "attention",
                json!({"sessionId": id, "title": title, "body": e.text}),
            );
        }
    }
    pub fn send(self: &Arc<Self>, id: &str, text: &str) -> Res<()> {
        if text.trim().is_empty() {
            return Err("Write a message first".into());
        }
        if text.len() > 256 * 1024 {
            return Err("Message is too large".into());
        }
        let (old, copy, info, handoff) = {
            let mut guard = lock(&self.st);
            let st = &mut *guard;
            let Some(v) = st.sessions.iter_mut().find(|v| v.id == id) else {
                return Err("Session not found".into());
            };
            if model::active(&v.state) || st.stopping.contains(id) {
                return Err("Wait for the turn to finish or stop it first".into());
            }
            if st.closed {
                return Err("Nook is quitting".into());
            }
            let info = provider_info(&st.providers, &v.provider)?;
            let old = st.runtimes.get(id).cloned().unwrap_or_default();
            if old.runtime.is_none() && v.process_id > 0 {
                process::recover(v.process_id, &v.process_birth)?;
                v.process_id = 0;
                v.process_birth.clear();
            }
            st.runtimes.remove(id);
            v.state = STARTING.into();
            v.error.clear();
            v.archived = false;
            let copy = v.clone();
            self.db.put_session(&copy)?;
            let handoff = model::id();
            st.runtimes.insert(
                id.into(),
                RuntimeEntry {
                    generation: handoff.clone(),
                    ..Default::default()
                },
            );
            (old, copy, info, handoff)
        };
        if let Some(rt) = &old.runtime {
            rt.stop();
        }
        if let Some(ready) = &old.ready {
            ready.wait();
        }
        let mut st = lock(&self.st);
        if st.closed || st.runtimes.get(id).is_none_or(|e| e.generation != handoff) {
            return Err("Session was stopped before resuming".into());
        }
        self.start_locked(&mut st, copy, info, text.into());
        Ok(())
    }
    pub fn stop(&self, id: &str) -> Res<()> {
        let entry = {
            let mut guard = lock(&self.st);
            let st = &mut *guard;
            let Some(v) = st.sessions.iter_mut().find(|v| v.id == id) else {
                return Err("Session not found".into());
            };
            if st.closed || st.stopping.contains(id) {
                return Err("Session is already stopping".into());
            }
            st.stopping.insert(id.into());
            self.wg.add();
            st.approvals.retain(|_, a| a.session_id != id);
            if model::active(&v.state) {
                v.activity = "Stopping agent".into();
            }
            st.runtimes.remove(id).unwrap_or_default()
        };
        let _done = OnDrop(|| self.wg.done());
        if let Some(rt) = &entry.runtime {
            rt.stop();
        }
        // A launch still initializing must finish its generation check and clean up.
        if let Some(ready) = &entry.ready {
            ready.wait();
        }
        let mut st = lock(&self.st);
        let r = match st.find(id) {
            Some(v) => {
                if model::active(&v.state) {
                    v.state = STOPPED.into();
                    v.activity = "Stopped. Your work is saved.".into();
                }
                v.process_id = 0;
                v.process_birth.clear();
                v.updated_at = now();
                self.db.put_session(v)
            }
            None => Err("Session not found".into()),
        };
        st.stopping.remove(id);
        drop(st);
        self.signal("changed", Value::Null);
        r
    }
    pub fn respond(&self, a: ApprovalResponse) -> Res<()> {
        let (rt, generation) = {
            let mut st = lock(&self.st);
            let entry = st.runtimes.get(&a.session_id).cloned().unwrap_or_default();
            let pending = st
                .approvals
                .get(&a.request_id)
                .filter(|p| p.session_id == a.session_id);
            let (Some(pending), Some(rt)) = (pending, entry.runtime) else {
                return Err("This request is no longer active".into());
            };
            if !pending.decisions.contains(&a.decision) {
                return Err("Invalid decision".into());
            }
            if a.decision == "answer"
                && pending
                    .questions
                    .iter()
                    .any(|q| a.answers.get(&q.id).is_none_or(Vec::is_empty))
            {
                return Err("Answer every question".into());
            }
            st.approvals.remove(&a.request_id);
            (rt, entry.generation)
        };
        if let Err(e) = rt.respond(&a) {
            self.ingest(&a.session_id, &generation, event("error", &e));
            return Err(e);
        }
        self.ingest(
            &a.session_id,
            &generation,
            SessionEvent {
                kind: "resolved".into(),
                item_id: a.request_id,
                ..Default::default()
            },
        );
        Ok(())
    }
    pub fn events(&self, id: &str, after: i64) -> Res<Vec<SessionEvent>> {
        self.db.events(id, after)
    }
    pub fn context(&self, id: &str, mut items: Vec<ContextAssignment>, project: bool) -> Res<()> {
        for c in &mut items {
            if !matches!(c.kind.as_str(), "note" | "file" | "folder") {
                return Err("Unknown context type".into());
            }
            if c.value.len() > 256 * 1024 {
                return Err("Context item is too large".into());
            }
            if c.id.is_empty() {
                c.id = model::id();
            }
            if c.kind != "note" {
                let abs = std::path::absolute(&c.value).map_err(err)?;
                let meta = fs::metadata(&abs).map_err(err)?;
                c.value = abs.to_string_lossy().into_owned();
                if (c.kind == "folder") != meta.is_dir() {
                    return Err("Context type does not match the selected path".into());
                }
            }
        }
        let mut st = lock(&self.st);
        if project {
            if let Some(p) = st.projects.iter_mut().find(|p| p.id == id) {
                p.context = items;
                return self.db.put_project(p);
            }
        } else if let Some(v) = st.find(id) {
            v.context = items;
            return self.db.put_session(v);
        }
        Err("Not found".into())
    }
    pub fn archive(&self, id: &str) -> Res<()> {
        self.stop(id)?;
        let mut st = lock(&self.st);
        let v = st.find(id).ok_or("Session not found")?;
        v.archived = true;
        self.db.put_session(v)
    }
    pub fn rename(&self, id: &str, title: &str) -> Res<()> {
        let mut st = lock(&self.st);
        let v = st.find(id).ok_or("Session not found")?;
        let title = title.trim();
        if title.is_empty() {
            return Err("A name is required".into());
        }
        v.title = title.into();
        v.avatar.name = title.into();
        self.db.put_session(v)
    }
    pub fn session(&self, id: &str) -> Res<Session> {
        lock(&self.st)
            .find(id)
            .cloned()
            .ok_or_else(|| "Session not found".into())
    }
    pub fn changes(&self, id: &str) -> Res<Changes> {
        let v = self.session(id)?;
        if !git::is_repo(&v.cwd) {
            return Ok(Changes {
                status: "This is not a Git project.".into(),
                ..Default::default()
            });
        }
        git::changes(&v.cwd, &v.base_commit)
    }
    pub fn patch(&self, id: &str) -> Res<Vec<u8>> {
        let v = self.session(id)?;
        git::patch(&v.cwd, &v.base_commit)
    }
    pub fn save_navigation(&self, v: &str) -> Res<()> {
        if v.len() > 512 * 1024 {
            return Err("Navigation state is too large".into());
        }
        self.db.set_setting("navigation", v)
    }
    pub fn navigation(&self) -> String {
        self.db.setting("navigation")
    }
    /// Stops every owned process and flushes state; work never continues after quit.
    pub fn close(&self) -> Res<()> {
        let entries = {
            let mut st = lock(&self.st);
            st.closed = true;
            std::mem::take(&mut st.runtimes)
        };
        // After `closed`, a late arrangement refuses to start; earlier ones are cancelled here.
        self.cancel_presentations();
        for rt in entries.values().filter_map(|e| e.runtime.as_ref()) {
            rt.stop();
        }
        self.wg.wait();
        let mut guard = lock(&self.st);
        let st = &mut *guard;
        for v in st.sessions.iter_mut().filter(|v| model::active(&v.state)) {
            v.state = STOPPED.into();
            v.activity = "Stopped when Nook quit".into();
            v.updated_at = now();
            if let Err(e) = self.db.put_session(v) {
                st.fault = e;
            }
        }
        self.db.close()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TempDir;

    pub(super) fn test_service(dir: &TempDir) -> Arc<Service> {
        Service::with(
            Store::open(&dir.0.join("nook.sqlite")).unwrap(),
            Path::new(""),
            "",
            None,
        )
    }

    #[test]
    fn fifteen_sessions_and_stale_events() {
        let dir = TempDir::new();
        let s = test_service(&dir);
        for i in 0..15 {
            let v = Session {
                id: i.to_string(),
                state: WORKING.into(),
                ..Default::default()
            };
            s.db.put_session(&v).unwrap();
            let mut st = lock(&s.st);
            st.runtimes.insert(
                v.id.clone(),
                RuntimeEntry {
                    generation: "current".into(),
                    ..Default::default()
                },
            );
            st.sessions.push(v);
        }
        let workers: Vec<_> = (0..15)
            .map(|i| {
                let s = s.clone();
                thread::spawn(move || {
                    let id = i.to_string();
                    for _ in 0..30 {
                        s.ingest(&id, "current", event("delta", "hello"));
                    }
                    s.ingest(&id, "current", event("completed", "done"));
                    s.ingest(&id, "old-generation", event("error", "stale"));
                })
            })
            .collect();
        workers.into_iter().for_each(|w| w.join().unwrap());
        for v in s.snapshot().sessions {
            assert_eq!(v.state, COMPLETED, "{v:?}");
            assert_eq!(s.events(&v.id, 0).unwrap().len(), 31);
        }
        s.close().unwrap();
    }

    #[test]
    fn archive_preserves_terminal_outcomes_and_stops_active_sessions() {
        let dir = TempDir::new();
        let s = test_service(&dir);
        for state in [
            COMPLETED,
            FAILED,
            STOPPED,
            DISCONNECTED,
            STARTING,
            WORKING,
            WAITING,
        ] {
            let v = Session {
                id: state.into(),
                state: state.into(),
                activity: "Recorded outcome".into(),
                ..Default::default()
            };
            s.db.put_session(&v).unwrap();
            lock(&s.st).sessions.push(v);
            s.archive(state).unwrap();
            let archived = s.session(state).unwrap();
            assert!(archived.archived);
            assert_eq!(
                archived.state,
                if model::active(state) { STOPPED } else { state }
            );
            if !model::active(state) {
                assert_eq!(archived.activity, "Recorded outcome");
            }
        }
        s.close().unwrap();
        let restored = Service::new(&dir.0, "", None).unwrap();
        assert_eq!(restored.session(COMPLETED).unwrap().state, COMPLETED);
        assert!(restored.session(COMPLETED).unwrap().archived);
        restored.close().unwrap();
    }

    #[test]
    fn stop_invalidates_approval() {
        let dir = TempDir::new();
        let s = test_service(&dir);
        let v = Session {
            id: "one".into(),
            state: WAITING.into(),
            ..Default::default()
        };
        s.db.put_session(&v).unwrap();
        {
            let mut st = lock(&s.st);
            st.sessions.push(v.clone());
            st.runtimes.insert(
                v.id.clone(),
                RuntimeEntry {
                    generation: "a".into(),
                    ..Default::default()
                },
            );
            st.approvals.insert(
                "p".into(),
                ApprovalRequest {
                    id: "p".into(),
                    session_id: v.id.clone(),
                    ..Default::default()
                },
            );
        }
        s.stop(&v.id).unwrap();
        s.ingest(&v.id, "a", event("completed", ""));
        let stale = ApprovalResponse {
            session_id: v.id.clone(),
            request_id: "p".into(),
            decision: "accept".into(),
            ..Default::default()
        };
        assert!(s.respond(stale).is_err(), "stale approval accepted");
        assert_eq!(
            s.snapshot().sessions[0].state,
            STOPPED,
            "late event changed stopped state"
        );
        s.close().unwrap();
    }

    #[test]
    fn context_uses_only_assigned_items() {
        let dir = TempDir::new();
        let p = dir.0.join("note ü.txt");
        fs::write(&p, "reference").unwrap();
        let file = p.to_string_lossy().into_owned();
        let v = Session {
            context: vec![
                ContextAssignment {
                    kind: "note".into(),
                    name: "Private".into(),
                    value: "hidden".into(),
                    enabled: false,
                    ..Default::default()
                },
                ContextAssignment {
                    kind: "file".into(),
                    name: "Brief".into(),
                    value: file,
                    enabled: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let out = context_prompt(&v, "task").unwrap();
        assert!(
            !out.contains("hidden") && out.contains("reference"),
            "{out}"
        );
        fs::remove_file(&p).unwrap();
        assert!(context_prompt(&v, "task").is_err(), "missing file ignored");
    }
}
