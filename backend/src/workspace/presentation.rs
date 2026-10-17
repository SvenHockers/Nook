//! The Presentation Agent: serves revision-bound evidence and, only when asked, lets the session's
//! own provider arrange it. Any failure leaves the deterministic layout with a reason.
use super::Service;
use crate::model::SessionEvent;
use crate::presentation::{
    arrangement, build_evidence, cache_key, compose, prompt, validate, Arrangement, PresentRequest,
    PresentResult, Source, MAX_FOCUS,
};
use crate::{err, lock, private_dir, process, provider, OnDrop, Res};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Stays below the desktop shell's 90 second call limit so failures arrive as our own message.
const ARRANGE_LIMIT: Duration = Duration::from_secs(75);
const MAX_EVENTS: usize = 20_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// A running arrangement that can be cancelled before or after its process exists.
#[derive(Default)]
pub(super) struct Presenting {
    cancelled: AtomicBool,
    child: Mutex<Option<Arc<process::Child>>>,
}
impl Presenting {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    /// False when cancelled first, so the call is abandoned before it can send anything.
    fn attach(&self, child: Arc<process::Child>) -> bool {
        let mut slot = lock(&self.child);
        if self.cancelled() {
            return false;
        }
        *slot = Some(child);
        true
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let child = lock(&self.child).clone();
        if let Some(child) = child {
            child.stop();
        }
    }
}

impl Service {
    /// Evidence for exactly `revision`: the caller must name an event it has seen.
    pub(super) fn events_through(&self, id: &str, revision: i64) -> Res<Vec<SessionEvent>> {
        if revision < 0 {
            return Err("Invalid revision".into());
        }
        let (mut out, mut after, mut bytes) = (Vec::new(), 0, 0);
        loop {
            let batch = self.db.events(id, after)?;
            let full = batch.len() == 1000;
            for e in batch {
                if e.sequence > revision {
                    return Ok(out);
                }
                after = e.sequence;
                bytes += serde_json::to_vec(&e).map_err(err)?.len();
                if bytes > MAX_BYTES || out.len() >= MAX_EVENTS {
                    return Err("This session is too large to arrange; use Chat or Raw".into());
                }
                out.push(e);
            }
            if !full {
                return Ok(out);
            }
        }
    }

    pub fn present_session(&self, req: PresentRequest) -> Res<PresentResult> {
        let focus = req.focus.trim().to_string();
        if focus.chars().count() > MAX_FOCUS {
            return Err(format!("Keep the focus under {MAX_FOCUS} characters"));
        }
        let (session, providers) = {
            let st = lock(&self.st);
            if st.closed {
                return Err("Nook is quitting".into());
            }
            (
                st.sessions.iter().find(|v| v.id == req.session_id).cloned(),
                st.providers.clone(),
            )
        };
        let session = session.ok_or("Session not found")?;
        let events = self.events_through(&session.id, req.revision)?;
        if req.revision > 0 && events.last().map(|e| e.sequence) != Some(req.revision) {
            return Err("Unknown revision; refresh the view".into());
        }
        let source = Source {
            project_id: session.project_id.clone(),
            id: session.id.clone(),
            revision: req.revision.to_string(),
            permission_scope: format!("local:{}:{}", session.project_id, session.id),
        };
        let (evidence, total) = build_evidence(&events, &source);
        let mut result = PresentResult {
            presentation: compose(&source, &evidence),
            source,
            evidence,
            total,
            mode: "standard".into(),
            provider: String::new(),
            focus,
            reason: String::new(),
            cached: false,
        };
        if !req.arrange {
            return Ok(result);
        }
        // Session content goes only to the provider the person already chose for this session.
        let Some(info) = providers
            .iter()
            .find(|p| p.id == session.provider && p.id == "claude" && p.available)
        else {
            result.reason = if session.provider == "claude" {
                "Claude Code is not available. Install and sign in, then refresh your agents."
                    .into()
            } else {
                "Arranging is available for Claude Code sessions.".into()
            };
            return Ok(result);
        };
        let key = cache_key(&result.source, &info.id, &result.focus);
        if let Some(a) = self.db.presentation(&key)? {
            if validate(&a.presentation, &result.source, &result.evidence).is_ok() {
                (result.presentation, result.provider) = (a.presentation, a.provider);
                (result.mode, result.cached) = ("model".into(), true);
                return Ok(result);
            }
        }
        let slot = Arc::new(Presenting::default());
        {
            let mut running = lock(&self.presenting);
            if running.contains_key(&session.id) {
                return Err("Already arranging this view".into());
            }
            running.insert(session.id.clone(), slot.clone());
        }
        let _clear = OnDrop(|| {
            lock(&self.presenting).remove(&session.id);
        });
        // Registered first, so a concurrent close() either sees this slot or is seen here.
        if lock(&self.st).closed {
            return Err("Nook is quitting".into());
        }
        let dir = self.root.join("presenter");
        private_dir(&dir).map_err(err)?;
        let reply = provider::arrange(
            info,
            &prompt(&result.evidence, &result.focus),
            &dir.to_string_lossy(),
            ARRANGE_LIMIT,
            |child| slot.attach(child),
        );
        if slot.cancelled() {
            return Err("Arranging was cancelled".into());
        }
        match reply.and_then(|r| arrangement(&r, &result.source, &result.evidence)) {
            Ok(presentation) => {
                let a = Arrangement {
                    presentation,
                    provider: info.name.clone(),
                };
                self.db.put_presentation(&session.id, &key, &a)?;
                (result.presentation, result.provider) = (a.presentation, a.provider);
                result.mode = "model".into();
            }
            Err(e) => result.reason = provider::explain_error(&e),
        }
        Ok(result)
    }

    pub fn cancel_presentation(&self, id: &str) -> Res<()> {
        let slot = lock(&self.presenting).get(id).cloned();
        if let Some(slot) = slot {
            slot.cancel();
        }
        Ok(())
    }
    /// Stops every running arrangement, so quitting never waits for a model.
    pub fn cancel_presentations(&self) {
        let all: Vec<_> = lock(&self.presenting).values().cloned().collect();
        for slot in all {
            slot.cancel();
        }
    }
}
