//! SQLite persistence. Rows hold JSON bodies so the schema survives wire-contract additions.
use crate::model::{decode, Project, Session, SessionEvent, Workflow, WorkflowArtifact};
use crate::presentation::Arrangement;
use crate::{err, lock, private_dir, private_file, Res};
use rusqlite::{params, Connection, OptionalExtension, Params};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::OpenOptions;
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    db: Mutex<Option<Connection>>,
}

const SCHEMA: &str = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_session ON events(session_id,sequence);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflow_artifacts(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS presentations(key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
 PRAGMA user_version=3;";

/// Cached arrangements kept per session; older revisions are pruned on write.
const KEPT_PRESENTATIONS: i64 = 20;

fn body<T: Serialize>(v: &T) -> Res<String> {
    serde_json::to_string(v).map_err(err)
}
fn parse<T: DeserializeOwned>(b: &str) -> Res<T> {
    decode(serde_json::from_str(b).map_err(err)?)
}
fn bodies<T: DeserializeOwned>(db: &Connection, sql: &str, p: impl Params) -> Res<Vec<T>> {
    let mut stmt = db.prepare(sql).map_err(err)?;
    let rows = stmt.query_map(p, |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|b| parse(&b.map_err(err)?)).collect()
}

impl Store {
    pub fn open(path: &Path) -> Res<Store> {
        if let Some(dir) = path.parent() {
            private_dir(dir).map_err(err)?;
        }
        private_file(path, OpenOptions::new().create(true).append(true)).map_err(err)?;
        let db = Connection::open(path).map_err(err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version > 3 {
            return Err("database is newer than this Nook version".into());
        }
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(Store {
            db: Mutex::new(Some(db)),
        })
    }
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Res<T>) -> Res<T> {
        match lock(&self.db).as_mut() {
            Some(db) => f(db),
            None => Err("sql: database is closed".into()),
        }
    }
    pub fn close(&self) -> Res<()> {
        match lock(&self.db).take() {
            Some(db) => db.close().map_err(|(_, e)| err(e)),
            None => Ok(()),
        }
    }
    pub fn put_project(&self, p: &Project) -> Res<()> {
        let b = body(p)?;
        self.with(|db| db.execute("INSERT INTO projects VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![p.id, b]).map(drop).map_err(err))
    }
    pub fn put_session(&self, v: &Session) -> Res<()> {
        let b = body(v)?;
        self.with(|db| db.execute("INSERT INTO sessions VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![v.id, b]).map(drop).map_err(err))
    }
    /// Session mutation and event insertion share one transaction.
    pub fn commit_event(&self, v: &Session, e: &mut SessionEvent) -> Res<()> {
        let (session, event) = (body(v)?, body(e)?);
        self.with(|db| {
            let tx = db.transaction().map_err(err)?;
            tx.execute(
                "UPDATE sessions SET body=?1 WHERE id=?2",
                params![session, v.id],
            )
            .map_err(err)?;
            tx.execute(
                "INSERT INTO events(session_id,body) VALUES(?1,?2)",
                params![v.id, event],
            )
            .map_err(err)?;
            e.sequence = tx.last_insert_rowid();
            tx.commit().map_err(err)
        })
    }
    pub fn load(&self) -> Res<(Vec<Project>, Vec<Session>)> {
        self.with(|db| {
            Ok((
                bodies(db, "SELECT body FROM projects ORDER BY rowid", [])?,
                bodies(db, "SELECT body FROM sessions ORDER BY rowid", [])?,
            ))
        })
    }
    pub fn events(&self, id: &str, after: i64) -> Res<Vec<SessionEvent>> {
        self.with(|db| {
            let mut stmt = db.prepare("SELECT sequence,body FROM events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 1000").map_err(err)?;
            let rows = stmt.query_map(params![id, after], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
            rows.map(|row| {
                let (sequence, b) = row.map_err(err)?;
                let mut e: SessionEvent = parse(&b)?;
                e.sequence = sequence;
                Ok(e)
            })
            .collect()
        })
    }
    pub fn setting(&self, k: &str) -> String {
        self.with(|db| {
            db.query_row("SELECT value FROM settings WHERE key=?1", [k], |r| r.get(0))
                .optional()
                .map_err(err)
        })
        .ok()
        .flatten()
        .unwrap_or_default()
    }
    pub fn set_setting(&self, k: &str, v: &str) -> Res<()> {
        self.with(|db| db.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]).map(drop).map_err(err))
    }
    /// Workflow mutation, session allocation and accepted evidence commit atomically.
    pub fn commit_workflow(
        &self,
        w: &Workflow,
        expected: i64,
        session: Option<&Session>,
        artifact: Option<&WorkflowArtifact>,
    ) -> Res<()> {
        let b = body(w)?;
        let session = session
            .map(|v| Ok::<_, String>((v.id.clone(), body(v)?)))
            .transpose()?;
        let artifact = artifact
            .map(|a| Ok::<_, String>((a.id.clone(), body(a)?)))
            .transpose()?;
        self.with(|db| {
            let tx = db.transaction().map_err(err)?;
            if expected == 0 {
                tx.execute(
                    "INSERT INTO workflows(id,revision,body) VALUES(?1,?2,?3)",
                    params![w.id, w.revision, b],
                )
                .map_err(err)?;
            } else if tx
                .execute(
                    "UPDATE workflows SET revision=?1,body=?2 WHERE id=?3 AND revision=?4",
                    params![w.revision, b, w.id, expected],
                )
                .map_err(err)?
                != 1
            {
                return Err("Workflow changed; refresh before trying again".into());
            }
            if let Some((id, b)) = session {
                tx.execute(
                    "INSERT INTO sessions(id,body) VALUES(?1,?2)",
                    params![id, b],
                )
                .map_err(err)?;
            }
            if let Some((id, b)) = artifact {
                tx.execute(
                    "INSERT INTO workflow_artifacts(id,workflow_id,body) VALUES(?1,?2,?3)",
                    params![id, w.id, b],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)
        })
    }
    pub fn workflows(&self) -> Res<Vec<Workflow>> {
        self.with(|db| bodies(db, "SELECT body FROM workflows ORDER BY rowid", []))
    }
    pub fn workflow_artifact(&self, workflow_id: &str, id: &str) -> Res<WorkflowArtifact> {
        let b: String = self.with(|db| {
            db.query_row(
                "SELECT body FROM workflow_artifacts WHERE workflow_id=?1 AND id=?2",
                [workflow_id, id],
                |r| r.get(0),
            )
            .map_err(err)
        })?;
        parse(&b)
    }
    pub fn presentation(&self, key: &str) -> Res<Option<Arrangement>> {
        let b: Option<String> = self.with(|db| {
            db.query_row("SELECT body FROM presentations WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)
        })?;
        b.map(|b| parse(&b)).transpose()
    }
    /// Stores an arrangement and drops all but the newest few of the session's.
    pub fn put_presentation(&self, session_id: &str, key: &str, a: &Arrangement) -> Res<()> {
        let b = body(a)?;
        self.with(|db| {
            let tx = db.transaction().map_err(err)?;
            tx.execute("INSERT INTO presentations(key,session_id,body) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET body=excluded.body", params![key, session_id, b]).map_err(err)?;
            tx.execute("DELETE FROM presentations WHERE session_id=?1 AND rowid NOT IN (SELECT rowid FROM presentations WHERE session_id=?1 ORDER BY rowid DESC LIMIT ?2)", params![session_id, KEPT_PRESENTATIONS]).map_err(err)?;
            tx.commit().map_err(err)
        })
    }
    #[cfg(test)]
    pub(crate) fn exec(&self, sql: &str) -> Res<()> {
        self.with(|db| db.execute_batch(sql).map_err(err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::WORKING;
    use crate::TempDir;

    #[test]
    fn restart_and_ordered_events() {
        let dir = TempDir::new();
        let path = dir.0.join("space ü").join("nook.sqlite");
        let s = Store::open(&path).unwrap();
        let v = Session {
            id: "s".into(),
            state: WORKING.into(),
            provider_id: "provider-session".into(),
            ..Default::default()
        };
        s.put_session(&v).unwrap();
        for i in 0..20 {
            let mut e = SessionEvent {
                session_id: "s".into(),
                kind: "delta".into(),
                text: "hello".into(),
                ..Default::default()
            };
            s.commit_event(&v, &mut e).unwrap();
            assert_eq!(e.sequence, i + 1);
        }
        s.close().unwrap();
        let s = Store::open(&path).unwrap();
        let (_, sessions) = s.load().unwrap();
        assert_eq!(sessions[0].provider_id, "provider-session");
        let events = s.events("s", 10).unwrap();
        assert_eq!((events.len(), events[0].sequence), (10, 11));
    }

    #[test]
    fn reject_future_schema() {
        let dir = TempDir::new();
        let path = dir.0.join("nook.sqlite");
        let s = Store::open(&path).unwrap();
        s.exec("PRAGMA user_version=99").unwrap();
        s.close().unwrap();
        assert!(Store::open(&path).is_err(), "future schema was opened");
    }

    #[test]
    fn workflow_migration_preserves_v1_data() {
        let dir = TempDir::new();
        let path = dir.0.join("old.sqlite");
        let s = Store::open(&path).unwrap();
        s.put_session(&Session {
            id: "old".into(),
            title: "Keep me".into(),
            ..Default::default()
        })
        .unwrap();
        s.exec("DROP TABLE workflow_artifacts; DROP TABLE workflows; PRAGMA user_version=1")
            .unwrap();
        s.close().unwrap();
        let s = Store::open(&path).unwrap();
        let (_, sessions) = s.load().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Keep me");
        assert!(s.workflows().unwrap().is_empty());
        let version: i64 = s
            .with(|db| {
                db.query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(err)
            })
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn presentation_cache_round_trips_and_prunes_per_session() {
        use crate::presentation::{Presentation, Source};
        let dir = TempDir::new();
        let s = Store::open(&dir.0.join("cache.sqlite")).unwrap();
        for id in ["a", "b"] {
            s.put_session(&Session {
                id: id.into(),
                ..Default::default()
            })
            .unwrap();
        }
        let arrangement = |p: &str| Arrangement {
            provider: p.into(),
            presentation: Presentation {
                schema_version: "nook.presentation.v1".into(),
                catalog_version: "1".into(),
                source: Source::default(),
                template_version: "agent-1".into(),
                generated_at: String::new(),
                blocks: vec![],
            },
        };
        assert!(s.presentation("missing").unwrap().is_none());
        s.put_presentation("b", "kept", &arrangement("other"))
            .unwrap();
        for i in 0..25 {
            s.put_presentation("a", &format!("k{i}"), &arrangement("claude"))
                .unwrap();
        }
        assert!(s.presentation("k0").unwrap().is_none(), "oldest not pruned");
        assert_eq!(s.presentation("k24").unwrap().unwrap().provider, "claude");
        assert!(s.presentation("k5").unwrap().is_some());
        assert!(
            s.presentation("kept").unwrap().is_some(),
            "pruned another session"
        );
        s.put_presentation("a", "k24", &arrangement("updated"))
            .unwrap();
        assert_eq!(s.presentation("k24").unwrap().unwrap().provider, "updated");
    }

    #[test]
    fn workflow_commit_rolls_back_all_writes() {
        let dir = TempDir::new();
        let s = Store::open(&dir.0.join("atomic.sqlite")).unwrap();
        let mut w = Workflow {
            id: "w".into(),
            revision: 1,
            goal: "Original".into(),
            ..Default::default()
        };
        s.commit_workflow(&w, 0, None, None).unwrap();
        let v = Session {
            id: "session".into(),
            ..Default::default()
        };
        s.put_session(&v).unwrap();
        w.revision = 2;
        w.goal = "Must roll back".into();
        assert!(
            s.commit_workflow(&w, 1, Some(&v), None).is_err(),
            "duplicate session inserted"
        );
        let loaded = s.workflows().unwrap();
        assert_eq!(
            (loaded[0].revision, loaded[0].goal.as_str()),
            (1, "Original")
        );
    }

    #[test]
    fn reads_go_written_null_lists() {
        let dir = TempDir::new();
        let s = Store::open(&dir.0.join("go.sqlite")).unwrap();
        s.exec(r#"INSERT INTO sessions VALUES('g','{"id":"g","seen":true,"context":null,"avatar":{"shape":1,"color":2,"name":"x"}}')"#).unwrap();
        let (_, sessions) = s.load().unwrap();
        assert_eq!(
            (sessions[0].id.as_str(), sessions[0].avatar.color),
            ("g", 2)
        );
    }
}
