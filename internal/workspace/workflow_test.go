package workspace

import (
	"nook/internal/model"
	"nook/internal/store"
	"path/filepath"
	"sync"
	"testing"
)

func workflowService(t *testing.T) (*Service, model.Workflow) {
	t.Helper()
	s := testService(t)
	s.projects = []model.Project{{ID: "p", Path: t.TempDir(), Context: []model.ContextAssignment{}}}
	s.providers = []model.ProviderInfo{{ID: "test", Available: true}}
	w, err := s.CreateWorkflow(model.CreateWorkflowRequest{ProjectID: "p", Goal: "Ship safely", Tasks: []model.WorkflowTask{
		{ID: "a", Title: "Build", Prompt: "Build the feature", Provider: "test", DependsOn: []string{}},
		{ID: "b", Title: "Review", Prompt: "Review the output", Provider: "test", DependsOn: []string{"a"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return s, w
}
func recordWorkflowSession(t *testing.T, s *Service, w model.Workflow) model.Session {
	t.Helper()
	v := model.Session{ID: "session-a", ProjectID: "p", State: model.Completed}
	if err := s.db.PutSession(v); err != nil {
		t.Fatal(err)
	}
	s.sessions = append(s.sessions, v)
	w.Tasks[0].SessionID = v.ID
	w.Revision++
	if err := s.db.CommitWorkflow(w, w.Revision-1, nil, nil); err != nil {
		t.Fatal(err)
	}
	s.workflows[0] = w
	e := model.SessionEvent{SessionID: v.ID, Kind: "delta", Text: "Agent reported output; not verified"}
	if err := s.db.CommitEvent(v, &e); err != nil {
		t.Fatal(err)
	}
	return v
}
func TestWorkflowDependenciesAndHumanAcceptance(t *testing.T) {
	s, w := workflowService(t)
	if _, err := s.StartWorkflowTask(model.WorkflowAction{WorkflowID: w.ID, TaskID: "b", Revision: w.Revision}); err == nil {
		t.Fatal("blocked task started")
	}
	recordWorkflowSession(t, s, w)
	w = s.Snapshot().Workflows[0]
	if w.Tasks[0].State != "waiting_for_input" || w.Tasks[1].State != "blocked" {
		t.Fatal(w)
	}
	r := model.WorkflowAction{WorkflowID: w.ID, TaskID: "a", Revision: w.Revision}
	a, err := s.WorkflowEvidence(r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcceptWorkflowTask(r); err == nil {
		t.Fatal("uninspected evidence accepted")
	}
	r.SourceRevision = a.Revision
	w, err = s.AcceptWorkflowTask(r)
	if err != nil {
		t.Fatal(err)
	}
	if w.Tasks[0].State != "succeeded" || w.Tasks[1].State != "ready" {
		t.Fatal(w)
	}
	if _, err = s.AcceptWorkflowTask(r); err == nil {
		t.Fatal("stale duplicate mutation accepted")
	}
	// Subsequent provider output cannot rewrite the accepted handoff.
	v := s.sessions[0]
	e := model.SessionEvent{SessionID: v.ID, Kind: "delta", Text: "later output"}
	s.db.CommitEvent(v, &e)
	r.Revision = w.Revision
	frozen, err := s.WorkflowEvidence(r)
	if err != nil || len(frozen.Events) != 1 || frozen.ID == "" {
		t.Fatal(frozen, err)
	}
}
func TestWorkflowRejectsChangedSource(t *testing.T) {
	s, w := workflowService(t)
	v := recordWorkflowSession(t, s, w)
	w = s.Snapshot().Workflows[0]
	r := model.WorkflowAction{WorkflowID: w.ID, TaskID: "a", Revision: w.Revision}
	a, _ := s.WorkflowEvidence(r)
	r.SourceRevision = a.Revision
	e := model.SessionEvent{SessionID: v.ID, Kind: "delta", Text: "new result"}
	s.db.CommitEvent(v, &e)
	if _, err := s.AcceptWorkflowTask(r); err == nil {
		t.Fatal("changed source accepted")
	}
}
func TestWorkflowGraphValidation(t *testing.T) {
	s, w := workflowService(t)
	req := model.CreateWorkflowRequest{ProjectID: "p", Goal: w.Goal, Tasks: w.Tasks}
	req.Tasks[0].DependsOn = []string{"b"}
	if _, err := s.CreateWorkflow(req); err == nil {
		t.Fatal("cycle accepted")
	}
	req.Tasks[0].DependsOn = []string{"missing"}
	if _, err := s.CreateWorkflow(req); err == nil {
		t.Fatal("missing dependency accepted")
	}
	req.Tasks[0].DependsOn = nil
	req.Tasks[1].ID = "a"
	if _, err := s.CreateWorkflow(req); err == nil {
		t.Fatal("duplicate task accepted")
	}
}
func TestWorkflowConcurrentAcceptanceHasOneWinner(t *testing.T) {
	s, w := workflowService(t)
	recordWorkflowSession(t, s, w)
	w = s.Snapshot().Workflows[0]
	r := model.WorkflowAction{WorkflowID: w.ID, TaskID: "a", Revision: w.Revision}
	a, _ := s.WorkflowEvidence(r)
	r.SourceRevision = a.Revision
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.AcceptWorkflowTask(r); results <- err }()
	}
	wg.Wait()
	close(results)
	wins := 0
	for err := range results {
		if err == nil {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal(wins)
	}
}
func TestWorkflowPersistenceAndSnapshotIsolation(t *testing.T) {
	s, w := workflowService(t)
	recordWorkflowSession(t, s, w)
	snap := s.Snapshot()
	snap.Workflows[0].Tasks[0].Title = "mutated"
	if s.Snapshot().Workflows[0].Tasks[0].Title == "mutated" {
		t.Fatal("snapshot aliases store")
	}
	path := filepath.Join(t.TempDir(), "restart.sqlite")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.CommitWorkflow(s.workflows[0], 0, nil, nil); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	loaded, err := db.Workflows()
	if err != nil || len(loaded) != 1 || loaded[0].Tasks[0].SessionID != "session-a" {
		t.Fatal(loaded, err)
	}
}

func TestWorkflowStartAllocatesExactlyOneSession(t *testing.T) {
	s, w := workflowService(t)
	r := model.WorkflowAction{WorkflowID: w.ID, TaskID: "a", Revision: w.Revision}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.StartWorkflowTask(r); results <- err }()
	}
	wg.Wait()
	close(results)
	wins := 0
	for err := range results {
		if err == nil {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal(wins)
	}
	snap := s.Snapshot()
	if len(snap.Sessions) != 1 || snap.Workflows[0].Tasks[0].SessionID != snap.Sessions[0].ID {
		t.Fatal(snap)
	}
	// Unknown test provider fails asynchronously; no executable or live account is used.
	s.wg.Wait()
	if s.Snapshot().Workflows[0].Tasks[0].State != "failed" {
		t.Fatal("provider failure was not projected")
	}
}
func TestWorkflowTaskCannotAcceptAnotherProjectSession(t *testing.T) {
	s, w := workflowService(t)
	recordWorkflowSession(t, s, w)
	s.sessions[0].ProjectID = "another-project"
	w = s.Snapshot().Workflows[0]
	r := model.WorkflowAction{WorkflowID: w.ID, TaskID: "a", Revision: w.Revision, SourceRevision: 1}
	if _, err := s.WorkflowEvidence(r); err == nil {
		t.Fatal("cross-project source read")
	}
	if _, err := s.AcceptWorkflowTask(r); err == nil {
		t.Fatal("cross-project source accepted")
	}
}
