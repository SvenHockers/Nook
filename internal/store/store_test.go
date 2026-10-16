package store

import (
	"nook/internal/model"
	"path/filepath"
	"testing"
)

func TestRestartAndOrderedEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "space ü", "nook.sqlite")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	v := model.Session{ID: "s", State: model.Working, ProviderID: "provider-session"}
	if e = s.PutSession(v); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 20; i++ {
		e := model.SessionEvent{SessionID: "s", Kind: "delta", Text: "hello"}
		if err := s.CommitEvent(v, &e); err != nil {
			t.Fatal(err)
		}
		if e.Sequence != int64(i+1) {
			t.Fatal(e.Sequence)
		}
	}
	s.Close()
	s, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	_, sessions, e := s.Load()
	if e != nil || sessions[0].ProviderID != "provider-session" {
		t.Fatal(sessions, e)
	}
	events, e := s.Events("s", 10)
	if e != nil || len(events) != 10 || events[0].Sequence != 11 {
		t.Fatal(events, e)
	}
}
func TestRejectFutureSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nook.sqlite")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	s.db.Exec("PRAGMA user_version=99")
	s.Close()
	if _, e = Open(path); e == nil {
		t.Fatal("future schema was opened")
	}
}

func TestWorkflowMigrationPreservesV1Data(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.PutSession(model.Session{ID: "old", Title: "Keep me"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("DROP TABLE workflow_artifacts; DROP TABLE workflows; PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, sessions, err := s.Load()
	if err != nil || len(sessions) != 1 || sessions[0].Title != "Keep me" {
		t.Fatal(sessions, err)
	}
	workflows, err := s.Workflows()
	if err != nil || len(workflows) != 0 {
		t.Fatal(workflows, err)
	}
	var version int
	s.db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 2 {
		t.Fatal(version)
	}
}
func TestWorkflowCommitRollsBackAllWrites(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "atomic.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w := model.Workflow{ID: "w", Revision: 1, Goal: "Original"}
	if err = s.CommitWorkflow(w, 0, nil, nil); err != nil {
		t.Fatal(err)
	}
	v := model.Session{ID: "session"}
	s.PutSession(v)
	w.Revision = 2
	w.Goal = "Must roll back"
	if err = s.CommitWorkflow(w, 1, &v, nil); err == nil {
		t.Fatal("duplicate session inserted")
	}
	loaded, _ := s.Workflows()
	if loaded[0].Revision != 1 || loaded[0].Goal != "Original" {
		t.Fatal(loaded)
	}
}
