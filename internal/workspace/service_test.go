package workspace

import (
	"fmt"
	"nook/internal/model"
	"nook/internal/store"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func testService(t *testing.T) *Service {
	t.Helper()
	db, e := store.Open(filepath.Join(t.TempDir(), "nook.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	s := &Service{db: db, runtimes: map[string]runtimeEntry{}, approvals: map[string]model.ApprovalRequest{}}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestFifteenSessionsAndStaleEvents(t *testing.T) {
	s := testService(t)
	for i := 0; i < 15; i++ {
		v := model.Session{ID: fmt.Sprint(i), State: model.Working}
		s.sessions = append(s.sessions, v)
		s.runtimes[v.ID] = runtimeEntry{generation: "current"}
		if e := s.db.PutSession(v); e != nil {
			t.Fatal(e)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				s.ingest(id, "current", model.SessionEvent{Kind: "delta", Text: "hello"})
			}
			s.ingest(id, "current", model.SessionEvent{Kind: "completed", Text: "done"})
			s.ingest(id, "old-generation", model.SessionEvent{Kind: "error", Text: "stale"})
		}(fmt.Sprint(i))
	}
	wg.Wait()
	for _, v := range s.Snapshot().Sessions {
		if v.State != model.Completed {
			t.Fatal(v)
		}
		events, e := s.Events(v.ID, 0)
		if e != nil || len(events) != 31 {
			t.Fatal(len(events), e)
		}
	}
}
func TestStopInvalidatesApproval(t *testing.T) {
	s := testService(t)
	v := model.Session{ID: "one", State: model.Waiting}
	s.sessions = []model.Session{v}
	s.db.PutSession(v)
	s.runtimes[v.ID] = runtimeEntry{generation: "a"}
	s.approvals["p"] = model.ApprovalRequest{ID: "p", SessionID: v.ID}
	if e := s.Stop(v.ID); e != nil {
		t.Fatal(e)
	}
	s.ingest(v.ID, "a", model.SessionEvent{Kind: "completed"})
	if e := s.Respond(model.ApprovalResponse{SessionID: v.ID, RequestID: "p", Decision: "accept"}); e == nil {
		t.Fatal("stale approval accepted")
	}
	if s.Snapshot().Sessions[0].State != model.Stopped {
		t.Fatal("late event changed stopped state")
	}
}
func TestContextUsesOnlyAssignedItems(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "note ü.txt")
	os.WriteFile(p, []byte("reference"), 0600)
	v := model.Session{Context: []model.ContextAssignment{{Kind: "note", Name: "Private", Value: "hidden", Enabled: false}, {Kind: "file", Name: "Brief", Value: p, Enabled: true}}}
	out, e := contextPrompt(v, "task")
	if e != nil {
		t.Fatal(e)
	}
	if contains(out, "hidden") || !contains(out, "reference") {
		t.Fatal(out)
	}
	os.Remove(p)
	if _, e = contextPrompt(v, "task"); e == nil {
		t.Fatal("missing file ignored")
	}
}
func contains(a, b string) bool {
	for i := 0; i+len(b) <= len(a); i++ {
		if a[i:i+len(b)] == b {
			return true
		}
	}
	return false
}
