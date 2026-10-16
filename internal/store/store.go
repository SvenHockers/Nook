package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	_ "modernc.org/sqlite"
	"nook/internal/model"
	"os"
	"path/filepath"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		db.Close()
		return nil, err
	}
	if version > 2 {
		db.Close()
		return nil, fmt.Errorf("database is newer than this Nook version")
	}
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_session ON events(session_id,sequence);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflow_artifacts(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), body TEXT NOT NULL);
 PRAGMA user_version=2;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) PutProject(p model.Project) error {
	b, e := json.Marshal(p)
	if e != nil {
		return e
	}
	_, e = s.db.Exec("INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", p.ID, string(b))
	return e
}
func (s *Store) PutSession(v model.Session) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	_, e = s.db.Exec("INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", v.ID, string(b))
	return e
}
func (s *Store) CommitEvent(v model.Session, e *model.SessionEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE sessions SET body=? WHERE id=?", string(b), v.ID); err != nil {
		return err
	}
	b, err = json.Marshal(e)
	if err != nil {
		return err
	}
	r, err := tx.Exec("INSERT INTO events(session_id,body) VALUES(?,?)", v.ID, string(b))
	if err != nil {
		return err
	}
	e.Sequence, err = r.LastInsertId()
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Load() ([]model.Project, []model.Session, error) {
	ps := []model.Project{}
	ss := []model.Session{}
	rows, err := s.db.Query("SELECT body FROM projects ORDER BY rowid")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var b string
		var p model.Project
		if err = rows.Scan(&b); err == nil {
			err = json.Unmarshal([]byte(b), &p)
		}
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		ps = append(ps, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	rows, err = s.db.Query("SELECT body FROM sessions ORDER BY rowid")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var b string
		var v model.Session
		if err = rows.Scan(&b); err == nil {
			err = json.Unmarshal([]byte(b), &v)
		}
		if err != nil {
			return nil, nil, err
		}
		ss = append(ss, v)
	}
	return ps, ss, rows.Err()
}
func (s *Store) Events(id string, after int64) ([]model.SessionEvent, error) {
	rows, err := s.db.Query("SELECT sequence,body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 1000", id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SessionEvent{}
	for rows.Next() {
		var seq int64
		var b string
		var e model.SessionEvent
		if err = rows.Scan(&seq, &b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(b), &e); err != nil {
			return nil, err
		}
		e.Sequence = seq
		out = append(out, e)
	}
	return out, rows.Err()
}
func (s *Store) Setting(k string) string {
	var v string
	_ = s.db.QueryRow("SELECT value FROM settings WHERE key=?", k).Scan(&v)
	return v
}
func (s *Store) SetSetting(k, v string) error {
	_, err := s.db.Exec("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v)
	return err
}
