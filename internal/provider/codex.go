package provider

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"nook/internal/model"
	"nook/internal/process"
	"sync"
	"time"
)

type rpc struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}
type codexPending struct {
	wireID json.RawMessage
	method string
	params map[string]any
}
type codex struct {
	c            Config
	child        *process.Child
	mu           sync.Mutex
	next         int
	calls        map[string]chan rpc
	approvals    map[string]codexPending
	thread, turn string
	closed       bool
	done         chan struct{}
}

func startCodex(c Config) (Runtime, error) {
	child, err := process.Start(c.Info.Path, []string{"app-server", "--listen", "stdio://"}, c.Session.Cwd, nil)
	if err != nil {
		return nil, err
	}
	r := &codex{c: c, child: child, calls: map[string]chan rpc{}, approvals: map[string]codexPending{}, done: make(chan struct{})}
	go r.read()
	birth, identityErr := process.Identity(child.Cmd.Process.Pid)
	if identityErr != nil {
		r.Stop()
		return nil, identityErr
	}
	identity, _ := json.Marshal(map[string]any{"pid": child.Cmd.Process.Pid, "birth": birth})
	c.Emit(event("process", string(identity)))
	if _, err = r.call("initialize", map[string]any{"clientInfo": map[string]any{"name": "nook", "version": "0.1.0"}, "capabilities": map[string]any{}}); err != nil {
		r.Stop()
		return nil, fmt.Errorf("Codex initialization failed: %w", err)
	}
	if err = r.write(map[string]any{"method": "initialized"}); err != nil {
		r.Stop()
		return nil, err
	}
	method := "thread/start"
	params := map[string]any{"cwd": c.Session.Cwd}
	if c.Session.ProviderID != "" {
		method = "thread/resume"
		params["threadId"] = c.Session.ProviderID
	}
	response, err := r.call(method, params)
	if err != nil {
		r.Stop()
		return nil, err
	}
	var v struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err = json.Unmarshal(response, &v); err != nil || v.Thread.ID == "" {
		r.Stop()
		return nil, errors.New("Codex returned no thread ID")
	}
	r.mu.Lock()
	r.thread = v.Thread.ID
	r.mu.Unlock()
	c.Emit(event("provider_id", v.Thread.ID))
	return r, nil
}
func (r *codex) write(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return r.child.Write(append(b, '\n'))
}
func (r *codex) call(method string, params any) (json.RawMessage, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, errors.New("Codex disconnected")
	}
	r.next++
	id := fmt.Sprint(r.next)
	ch := make(chan rpc, 1)
	r.calls[id] = ch
	n := r.next
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.calls, id); r.mu.Unlock() }()
	if e := r.write(map[string]any{"id": n, "method": method, "params": params}); e != nil {
		return nil, e
	}
	select {
	case v := <-ch:
		if len(v.Error) > 0 {
			return nil, fmt.Errorf("Codex: %s", v.Error)
		}
		return v.Result, nil
	case <-r.done:
		return nil, errors.New("Codex disconnected")
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("Codex %s timed out", method)
	}
}
func (r *codex) Send(text string) error {
	r.mu.Lock()
	thread := r.thread
	r.mu.Unlock()
	_, e := r.call("turn/start", map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": text}}})
	return e
}
func (r *codex) Interrupt() error {
	r.mu.Lock()
	thread, turn := r.thread, r.turn
	r.mu.Unlock()
	if turn == "" {
		return errors.New("No active turn to interrupt")
	}
	_, e := r.call("turn/interrupt", map[string]any{"threadId": thread, "turnId": turn})
	return e
}
func (r *codex) Stop() { r.mu.Lock(); r.closed = true; r.mu.Unlock(); r.child.Stop() }
func (r *codex) read() {
	scan := bufio.NewScanner(r.child.Out)
	scan.Buffer(make([]byte, 4096), 8*1024*1024)
	for scan.Scan() {
		var m rpc
		if err := json.Unmarshal(scan.Bytes(), &m); err != nil {
			r.c.Emit(event("error", "Invalid JSON received from Codex"))
			continue
		}
		if m.Method == "" && len(m.ID) > 0 {
			r.mu.Lock()
			ch := r.calls[string(m.ID)]
			r.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
			continue
		}
		r.handle(m)
	}
	readErr := scan.Err()
	err := r.child.Wait()
	r.mu.Lock()
	stopped := r.closed
	r.closed = true
	r.mu.Unlock()
	close(r.done)
	if !stopped {
		msg := "Codex disconnected. Resume to continue."
		if readErr != nil {
			msg = readErr.Error()
		} else if err != nil {
			msg = fmt.Sprintf("Codex process exited: %v", err)
		}
		r.c.Emit(event("disconnected", msg))
	}
}
func str(m map[string]any, k string) string         { v, _ := m[k].(string); return v }
func obj(m map[string]any, k string) map[string]any { v, _ := m[k].(map[string]any); return v }
func (r *codex) handle(m rpc) {
	var p map[string]any
	_ = json.Unmarshal(m.Params, &p)
	if len(m.ID) > 0 {
		a := model.ApprovalRequest{ID: model.ID(), Kind: "approval", Title: "Permission requested", Detail: string(m.Params), Decisions: []string{"accept", "decline"}}
		switch m.Method {
		case "item/commandExecution/requestApproval":
			a.Title = "Run a command"
			if cmd := str(p, "command"); cmd != "" {
				a.Detail = cmd
			}
		case "item/fileChange/requestApproval":
			a.Title = "Apply file changes"
		case "item/tool/requestUserInput":
			a.Kind = "question"
			a.Title = "Your input is needed"
			a.Questions = questions(p, false)
			a.Decisions = []string{"answer", "cancel"}
		default:
			_ = r.write(map[string]any{"id": m.ID, "error": map[string]any{"code": -32601, "message": "Nook does not support this request; no permission was granted"}})
			r.c.Emit(event("activity", "Unsupported provider request was declined: "+m.Method))
			return
		}
		r.mu.Lock()
		r.approvals[a.ID] = codexPending{m.ID, m.Method, p}
		r.mu.Unlock()
		r.c.Emit(model.SessionEvent{Kind: "approval", Approval: &a})
		return
	}
	switch m.Method {
	case "thread/started":
		if id := str(obj(p, "thread"), "id"); id != "" {
			r.c.Emit(event("provider_id", id))
		}
	case "turn/started":
		r.mu.Lock()
		r.turn = str(obj(p, "turn"), "id")
		r.mu.Unlock()
		r.c.Emit(event("working", "Working on your task"))
	case "item/agentMessage/delta":
		r.c.Emit(model.SessionEvent{Kind: "delta", Text: str(p, "delta"), ItemID: str(p, "itemId")})
	case "item/commandExecution/outputDelta":
		r.c.Emit(model.SessionEvent{Kind: "output", Text: str(p, "delta"), ItemID: str(p, "itemId")})
	case "item/started":
		item := obj(p, "item")
		kind := str(item, "type")
		labels := map[string]string{"reasoning": "Thinking", "commandExecution": "Running a command", "fileChange": "Editing files", "mcpToolCall": "Using a connected tool", "webSearch": "Searching the web"}
		label := labels[kind]
		if label == "" {
			label = "Working"
		}
		r.c.Emit(event("activity", label))
	case "turn/completed":
		turn := obj(p, "turn")
		r.mu.Lock()
		r.turn = ""
		r.approvals = map[string]codexPending{}
		r.mu.Unlock()
		switch str(turn, "status") {
		case "failed":
			r.c.Emit(event("error", ExplainError(str(obj(turn, "error"), "message"))))
		case "interrupted":
			r.c.Emit(event("stopped", "Turn interrupted"))
		default:
			r.c.Emit(event("completed", "Ready for your next thought"))
		}
	case "serverRequest/resolved":
		raw, _ := json.Marshal(p["requestId"])
		r.mu.Lock()
		var id string
		for k, v := range r.approvals {
			if string(v.wireID) == string(raw) {
				id = k
				delete(r.approvals, k)
				break
			}
		}
		r.mu.Unlock()
		if id != "" {
			r.c.Emit(model.SessionEvent{Kind: "resolved", ItemID: id})
		}
	case "error":
		r.c.Emit(event("error", ExplainError(str(obj(p, "error"), "message"))))
	}
}
func (r *codex) Respond(a model.ApprovalResponse) error {
	r.mu.Lock()
	p, ok := r.approvals[a.RequestID]
	if !ok {
		r.mu.Unlock()
		return errors.New("This request has expired")
	}
	delete(r.approvals, a.RequestID)
	r.mu.Unlock()
	var result any
	if p.method == "item/tool/requestUserInput" {
		answers := map[string]any{}
		if a.Decision == "cancel" {
			return r.Interrupt()
		}
		for k, v := range a.Answers {
			answers[k] = map[string]any{"answers": v}
		}
		result = map[string]any{"answers": answers}
	} else {
		if a.Decision != "accept" && a.Decision != "decline" {
			return errors.New("Invalid decision")
		}
		result = map[string]any{"decision": a.Decision}
	}
	return r.write(map[string]any{"id": p.wireID, "result": result})
}
func questions(p map[string]any, claude bool) []model.Question {
	out := []model.Question{}
	items, _ := p["questions"].([]any)
	for _, v := range items {
		m, _ := v.(map[string]any)
		q := model.Question{ID: str(m, "id"), Text: str(m, "question"), Options: []string{}}
		if claude || q.ID == "" {
			q.ID = q.Text
		}
		q.Multi, _ = m["multiSelect"].(bool)
		opts, _ := m["options"].([]any)
		for _, o := range opts {
			option, _ := o.(map[string]any)
			q.Options = append(q.Options, str(option, "label"))
		}
		out = append(out, q)
	}
	return out
}
