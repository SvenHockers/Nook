package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"nook/internal/gitwork"
	"nook/internal/model"
	"nook/internal/process"
	"nook/internal/provider"
	"nook/internal/store"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type runtimeEntry struct {
	ready      chan struct{}
	generation string
	runtime    provider.Runtime
}
type Service struct {
	mu           sync.Mutex
	db           *store.Store
	root, helper string
	projects     []model.Project
	sessions     []model.Session
	workflows    []model.Workflow
	providers    []model.ProviderInfo
	runtimes     map[string]runtimeEntry
	approvals    map[string]model.ApprovalRequest
	stopping     map[string]bool
	closed       bool
	wg           sync.WaitGroup
	notify       func(string, any)
	fault        string
}

func New(root, helper string, notify func(string, any)) (*Service, error) {
	db, err := store.Open(filepath.Join(root, "nook.sqlite"))
	if err != nil {
		return nil, err
	}
	ps, ss, err := db.Load()
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Service{db: db, root: root, helper: helper, projects: ps, sessions: ss, runtimes: map[string]runtimeEntry{}, approvals: map[string]model.ApprovalRequest{}, notify: notify}
	for i := range s.sessions {
		v := &s.sessions[i]
		if err := process.Recover(v.ProcessID, v.ProcessBirth); err != nil {
			v.State = model.Disconnected
			v.Error = "Could not reconcile the previous process: " + err.Error()
		} else {
			v.ProcessID = 0
			v.ProcessBirth = ""
		}
		if v.State.Active() {
			v.State = model.Disconnected
			v.Activity = "Nook was interrupted. Resume when ready."
			v.UpdatedAt = model.Now()
		}
		if err = db.PutSession(*v); err != nil {
			db.Close()
			return nil, err
		}
	}
	s.workflows, err = db.Workflows()
	if err != nil {
		db.Close()
		return nil, err
	}
	s.RefreshProviders()
	return s, nil
}
func (s *Service) signal(name string, v any) {
	if s.notify != nil {
		s.notify(name, v)
	}
}
func (s *Service) RefreshProviders() []model.ProviderInfo {
	overrides := map[string]string{}
	for _, id := range []string{"claude", "codex"} {
		overrides[id] = s.db.Setting("provider." + id)
	}
	ps := provider.Discover(overrides)
	s.mu.Lock()
	s.providers = ps
	s.mu.Unlock()
	s.signal("changed", nil)
	return ps
}
func (s *Service) SetExecutable(id, path string) error {
	if id != "claude" && id != "codex" {
		return errors.New("Unknown provider")
	}
	if path != "" {
		abs, e := filepath.Abs(path)
		if e != nil {
			return e
		}
		path = abs
	}
	if e := s.db.SetSetting("provider."+id, path); e != nil {
		return e
	}
	s.RefreshProviders()
	return nil
}
func (s *Service) Snapshot() model.Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := []model.ApprovalRequest{}
	for _, v := range s.approvals {
		a = append(a, v)
	}
	return model.Snapshot{Workflows: s.workflowSnapshotsLocked(), Projects: append([]model.Project{}, s.projects...), Sessions: append([]model.Session{}, s.sessions...), Providers: append([]model.ProviderInfo{}, s.providers...), Approvals: a, Problem: s.fault}
}
func (s *Service) AddProject(path string) (model.Project, error) {
	path, e := filepath.Abs(path)
	if e != nil {
		return model.Project{}, e
	}
	path, e = filepath.EvalSymlinks(path)
	if e != nil {
		return model.Project{}, e
	}
	st, e := os.Stat(path)
	if e != nil || !st.IsDir() {
		return model.Project{}, errors.New("Choose an existing folder")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if samePath(p.Path, path) {
			return p, nil
		}
	}
	p := model.Project{ID: model.ID(), Name: filepath.Base(path), Path: path, Git: gitwork.IsGitRepo(path), Context: []model.ContextAssignment{}}
	if e = s.db.PutProject(p); e != nil {
		return p, e
	}
	s.projects = append(s.projects, p)
	return p, nil
}
func samePath(a, b string) bool {
	aa, e := os.Stat(a)
	bb, f := os.Stat(b)
	return e == nil && f == nil && os.SameFile(aa, bb)
}
func (s *Service) Launch(req model.LaunchRequest) (model.Session, error) {
	s.mu.Lock()
	defer s.signal("changed", nil)
	defer s.mu.Unlock()
	return s.launchLocked(req, s.db.PutSession)
}
func (s *Service) launchLocked(req model.LaunchRequest, persist func(model.Session) error) (model.Session, error) {
	if strings.TrimSpace(req.Prompt) == "" {
		return model.Session{}, errors.New("Describe the task first")
	}
	if len(req.Prompt) > 256*1024 {
		return model.Session{}, errors.New("Prompt is too large")
	}
	if s.closed {
		return model.Session{}, errors.New("Nook is quitting")
	}
	var p *model.Project
	for i := range s.projects {
		if s.projects[i].ID == req.ProjectID {
			p = &s.projects[i]
			break
		}
	}
	if p == nil {
		return model.Session{}, errors.New("Project not found")
	}
	info, err := s.info(req.Provider)
	if err != nil {
		return model.Session{}, err
	}
	v := model.Session{ID: model.ID(), ProjectID: p.ID, Provider: req.Provider, Title: strings.TrimSpace(req.Title), Cwd: p.Path, CreatedAt: model.Now(), UpdatedAt: model.Now(), State: model.Starting, Activity: "Preparing a place to work", Context: append([]model.ContextAssignment{}, p.Context...), Capabilities: info.Capabilities}
	if v.Title == "" {
		v.Title = req.Prompt
		if len([]rune(v.Title)) > 64 {
			v.Title = string([]rune(v.Title)[:64]) + "…"
		}
	}
	v.Avatar = model.Avatar{Shape: len(s.sessions) % 5, Color: len(s.sessions) % 6, Name: v.Title}
	if p.Git && !req.Shared {
		v.Cwd, v.Branch, v.BaseCommit, err = gitwork.Create(p.Path, filepath.Join(s.root, "worktrees"), v.ID)
		if err != nil {
			return v, err
		}
		v.Isolated = true
	}
	if err = persist(v); err != nil {
		return v, err
	}
	s.sessions = append(s.sessions, v)
	s.startLocked(v, info, req.Prompt)
	return v, nil
}
func (s *Service) info(id string) (model.ProviderInfo, error) {
	for _, p := range s.providers {
		if p.ID == id {
			if !p.Available {
				return p, errors.New(p.Problem)
			}
			return p, nil
		}
	}
	return model.ProviderInfo{}, errors.New("Provider not found")
}
func (s *Service) find(id string) *model.Session {
	for i := range s.sessions {
		if s.sessions[i].ID == id {
			return &s.sessions[i]
		}
	}
	return nil
}
func (s *Service) startLocked(v model.Session, info model.ProviderInfo, prompt string) {
	gen := model.ID()
	ready := make(chan struct{})
	s.runtimes[v.ID] = runtimeEntry{generation: gen, ready: ready}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(ready)
		emit := func(e model.SessionEvent) { s.ingest(v.ID, gen, e) }
		if _, err := os.Stat(v.Cwd); err != nil {
			emit(model.SessionEvent{Kind: "error", Text: "The working folder is unavailable. Restore it before resuming."})
			return
		}
		rt, err := provider.Start(provider.Config{Info: info, Session: v, Emit: emit, Helper: s.helper})
		if err != nil {
			emit(model.SessionEvent{Kind: "error", Text: provider.ExplainError(err.Error())})
			return
		}
		s.mu.Lock()
		entry, ok := s.runtimes[v.ID]
		if s.closed || !ok || entry.generation != gen {
			s.mu.Unlock()
			rt.Stop()
			return
		}
		entry.runtime = rt
		s.runtimes[v.ID] = entry
		s.mu.Unlock()
		full, err := contextPrompt(v, prompt)
		if err != nil {
			emit(model.SessionEvent{Kind: "error", Text: err.Error()})
			rt.Stop()
			return
		}
		emit(model.SessionEvent{Kind: "user", Text: prompt, ItemID: model.ID()})
		emit(model.SessionEvent{Kind: "working", Text: "Working on your task"})
		if err = rt.Send(full); err != nil {
			emit(model.SessionEvent{Kind: "error", Text: provider.ExplainError(err.Error())})
		}
	}()
}
func contextPrompt(v model.Session, prompt string) (string, error) {
	var b strings.Builder
	for _, c := range v.Context {
		if !c.Enabled {
			continue
		}
		switch c.Kind {
		case "note":
			fmt.Fprintf(&b, "\nProject note (%s):\n%s\n", c.Name, c.Value)
		case "file":
			st, e := os.Stat(c.Value)
			if e != nil {
				return "", fmt.Errorf("Context file %s is unavailable", c.Name)
			}
			if st.Size() > 256*1024 {
				return "", fmt.Errorf("Context file %s exceeds 256 KB; choose a smaller text file", c.Name)
			}
			data, e := os.ReadFile(c.Value)
			if e != nil {
				return "", e
			}
			if strings.ContainsRune(string(data), 0) {
				return "", fmt.Errorf("Context file %s is not a text file", c.Name)
			}
			fmt.Fprintf(&b, "\nAttached reference (%s):\n%s\n", c.Name, data)
		case "folder":
			fmt.Fprintf(&b, "\nReference folder: %s (access remains subject to provider permissions).\n", c.Value)
		}
		if b.Len() > 512*1024 {
			return "", errors.New("Selected context exceeds 512 KB")
		}
	}
	if b.Len() == 0 {
		return prompt, nil
	}
	return "Project context supplied by the user:\n" + b.String() + "\nCurrent task:\n" + prompt, nil
}
func (s *Service) ingest(id, gen string, e model.SessionEvent) {
	s.mu.Lock()
	entry, ok := s.runtimes[id]
	if s.closed || !ok || entry.generation != gen {
		s.mu.Unlock()
		return
	}
	v := s.find(id)
	if v == nil {
		s.mu.Unlock()
		return
	}
	e.SessionID = id
	e.Time = model.Now()
	if len(e.Text) > 1024*1024 {
		e.Text = e.Text[:1024*1024] + "\n[Truncated]"
	}
	v.UpdatedAt = e.Time
	attention := false
	switch e.Kind {
	case "process":
		var identity struct {
			PID   int    `json:"pid"`
			Birth string `json:"birth"`
		}
		if json.Unmarshal([]byte(e.Text), &identity) == nil {
			v.ProcessID = identity.PID
			v.ProcessBirth = identity.Birth
		}
	case "process_clear":
		v.ProcessID = 0
		v.ProcessBirth = ""
	case "provider_id":
		v.ProviderID = e.Text
	case "working":
		v.State = model.Working
		v.Error = ""
		v.Activity = e.Text
	case "activity":
		v.Activity = e.Text
	case "approval":
		if e.Approval != nil {
			e.Approval.SessionID = id
			s.approvals[e.Approval.ID] = *e.Approval
			v.State = model.Waiting
			v.Activity = e.Approval.Title
			attention = true
		}
	case "resolved":
		delete(s.approvals, e.ItemID)
		waiting := false
		for _, a := range s.approvals {
			if a.SessionID == id {
				waiting = true
			}
		}
		if !waiting && v.State == model.Waiting {
			v.State = model.Working
			v.Activity = "Continuing your task"
		}
	case "completed":
		v.State = model.Completed
		v.Activity = e.Text
		v.Seen = false
	case "stopped":
		v.State = model.Stopped
		v.Activity = e.Text
	case "error":
		v.State = model.Failed
		v.Error = e.Text
		v.Activity = "Needs your attention"
		attention = true
	case "disconnected":
		v.State = model.Disconnected
		v.Error = e.Text
		v.Activity = "Connection lost"
		attention = true
	}
	if !v.State.Active() {
		for key, a := range s.approvals {
			if a.SessionID == id {
				delete(s.approvals, key)
			}
		}
	}
	title := v.Title
	err := s.db.CommitEvent(*v, &e)
	if err != nil {
		s.fault = "Could not save session activity: " + err.Error()
	}
	s.mu.Unlock()
	s.signal("changed", nil)
	if attention {
		s.signal("attention", map[string]string{"sessionId": id, "title": title, "body": e.Text})
	}
}
func (s *Service) Send(id, text string) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("Write a message first")
	}
	if len(text) > 256*1024 {
		return errors.New("Message is too large")
	}
	s.mu.Lock()
	v := s.find(id)
	if v == nil {
		s.mu.Unlock()
		return errors.New("Session not found")
	}
	if v.State.Active() || s.stopping[id] {
		s.mu.Unlock()
		return errors.New("Wait for the turn to finish or stop it first")
	}
	if s.closed {
		s.mu.Unlock()
		return errors.New("Nook is quitting")
	}
	info, err := s.info(v.Provider)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	old := s.runtimes[id]
	if old.runtime == nil && v.ProcessID > 0 {
		if err := process.Recover(v.ProcessID, v.ProcessBirth); err != nil {
			s.mu.Unlock()
			return err
		}
		v.ProcessID = 0
		v.ProcessBirth = ""
	}
	delete(s.runtimes, id)
	v.State = model.Starting
	v.Error = ""
	v.Archived = false
	copy := *v
	if err = s.db.PutSession(copy); err != nil {
		s.mu.Unlock()
		return err
	}
	handoff := model.ID()
	s.runtimes[id] = runtimeEntry{generation: handoff}
	s.mu.Unlock()
	if old.runtime != nil {
		old.runtime.Stop()
	}
	if old.ready != nil {
		<-old.ready
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.runtimes[id].generation != handoff {
		return errors.New("Session was stopped before resuming")
	}
	s.startLocked(copy, info, text)
	return nil
}
func (s *Service) Stop(id string) error {
	s.mu.Lock()
	v := s.find(id)
	if v == nil {
		s.mu.Unlock()
		return errors.New("Session not found")
	}
	if s.closed || s.stopping[id] {
		s.mu.Unlock()
		return errors.New("Session is already stopping")
	}
	if s.stopping == nil {
		s.stopping = map[string]bool{}
	}
	s.stopping[id] = true
	s.wg.Add(1)
	defer s.wg.Done()
	entry := s.runtimes[id]
	delete(s.runtimes, id)
	for key, a := range s.approvals {
		if a.SessionID == id {
			delete(s.approvals, key)
		}
	}
	v.Activity = "Stopping agent"
	s.mu.Unlock()
	if entry.runtime != nil {
		entry.runtime.Stop()
	}
	// A launch still initializing must finish its generation check and clean up.
	if entry.ready != nil {
		<-entry.ready
	}
	s.mu.Lock()
	v = s.find(id)
	v.State = model.Stopped
	v.Activity = "Stopped. Your work is saved."
	v.ProcessID = 0
	v.ProcessBirth = ""
	v.UpdatedAt = model.Now()
	err := s.db.PutSession(*v)
	delete(s.stopping, id)
	s.mu.Unlock()
	s.signal("changed", nil)
	return err
}
func (s *Service) Respond(a model.ApprovalResponse) error {
	s.mu.Lock()
	pending, ok := s.approvals[a.RequestID]
	entry := s.runtimes[a.SessionID]
	if !ok || pending.SessionID != a.SessionID || entry.runtime == nil {
		s.mu.Unlock()
		return errors.New("This request is no longer active")
	}
	valid := false
	for _, d := range pending.Decisions {
		if d == a.Decision {
			valid = true
		}
	}
	if !valid {
		s.mu.Unlock()
		return errors.New("Invalid decision")
	}
	if a.Decision == "answer" {
		for _, q := range pending.Questions {
			if len(a.Answers[q.ID]) == 0 {
				s.mu.Unlock()
				return errors.New("Answer every question")
			}
		}
	}
	delete(s.approvals, a.RequestID)
	s.mu.Unlock()
	if err := entry.runtime.Respond(a); err != nil {
		s.ingest(a.SessionID, entry.generation, model.SessionEvent{Kind: "error", Text: err.Error()})
		return err
	}
	s.ingest(a.SessionID, entry.generation, model.SessionEvent{Kind: "resolved", ItemID: a.RequestID})
	return nil
}
func (s *Service) Events(id string, after int64) ([]model.SessionEvent, error) {
	return s.db.Events(id, after)
}
func (s *Service) Context(id string, items []model.ContextAssignment, project bool) error {
	for i := range items {
		c := &items[i]
		if c.Kind != "note" && c.Kind != "file" && c.Kind != "folder" {
			return errors.New("Unknown context type")
		}
		if len(c.Value) > 256*1024 {
			return errors.New("Context item is too large")
		}
		if c.ID == "" {
			c.ID = model.ID()
		}
		if c.Kind != "note" {
			abs, e := filepath.Abs(c.Value)
			if e != nil {
				return e
			}
			c.Value = abs
			st, e := os.Stat(abs)
			if e != nil {
				return e
			}
			if (c.Kind == "folder") != st.IsDir() {
				return errors.New("Context type does not match the selected path")
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if project {
		for i := range s.projects {
			p := &s.projects[i]
			if p.ID == id {
				p.Context = items
				return s.db.PutProject(*p)
			}
		}
	} else {
		if v := s.find(id); v != nil {
			v.Context = items
			return s.db.PutSession(*v)
		}
	}
	return errors.New("Not found")
}
func (s *Service) Archive(id string) error {
	if err := s.Stop(id); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.find(id)
	v.Archived = true
	return s.db.PutSession(*v)
}
func (s *Service) Rename(id, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.find(id)
	if v == nil {
		return errors.New("Session not found")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return errors.New("A name is required")
	}
	v.Title = title
	v.Avatar.Name = title
	return s.db.PutSession(*v)
}
func (s *Service) Session(id string) (model.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v := s.find(id); v != nil {
		return *v, nil
	}
	return model.Session{}, errors.New("Session not found")
}
func (s *Service) Changes(id string) (model.Changes, error) {
	v, e := s.Session(id)
	if e != nil {
		return model.Changes{}, e
	}
	if !gitwork.IsGitRepo(v.Cwd) {
		return model.Changes{Status: "This is not a Git project.", Diff: ""}, nil
	}
	return gitwork.Changes(v.Cwd, v.BaseCommit)
}
func (s *Service) Patch(id string) (string, error) {
	v, e := s.Session(id)
	if e != nil {
		return "", e
	}
	return gitwork.Patch(v.Cwd, v.BaseCommit)
}
func (s *Service) SaveNavigation(v string) error {
	if len(v) > 512*1024 {
		return errors.New("Navigation state is too large")
	}
	return s.db.SetSetting("navigation", v)
}
func (s *Service) Navigation() string { return s.db.Setting("navigation") }
func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	entries := s.runtimes
	s.runtimes = map[string]runtimeEntry{}
	s.mu.Unlock()
	for _, e := range entries {
		if e.runtime != nil {
			e.runtime.Stop()
		}
	}
	s.wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.sessions {
		v := &s.sessions[i]
		if v.State.Active() {
			v.State = model.Stopped
			v.Activity = "Stopped when Nook quit"
			v.UpdatedAt = model.Now()
			if err := s.db.PutSession(*v); err != nil {
				s.fault = err.Error()
			}
		}
	}
	return s.db.Close()
}
