package provider

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"nook/internal/model"
	"nook/internal/process"
	"os"
	"strings"
	"sync"
	"time"
)

type claude struct {
	c                             Config
	mu                            sync.Mutex
	child                         *process.Child
	pending                       map[string]chan model.ApprovalResponse
	server                        *http.Server
	url, token, session, settings string
	resume, closed, busy          bool
	turnDone                      chan struct{}
	cancel                        context.CancelFunc
	ctx                           context.Context
}

func startClaude(c Config) (Runtime, error) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &claude{c: c, pending: map[string]chan model.ApprovalResponse{}, token: model.ID() + model.ID(), session: c.Session.ProviderID, resume: c.Session.ProviderID != "", ctx: ctx, cancel: cancel}
	if r.session == "" {
		r.session = model.UUID()
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancel()
		return nil, err
	}
	r.url = "http://" + l.Addr().String()
	r.server = &http.Server{Handler: http.HandlerFunc(r.hook), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 8192}
	go r.server.Serve(l)
	hook := func(path string) map[string]any {
		return map[string]any{"type": "http", "url": r.url + path, "headers": map[string]string{"Authorization": "Bearer $NOOK_SESSION_TOKEN"}, "allowedEnvVars": []string{"NOOK_SESSION_TOKEN"}, "timeout": 600, "onFailure": "block"}
	}
	settings := map[string]any{"hooks": map[string]any{"PreToolUse": []any{map[string]any{"matcher": "AskUserQuestion|ExitPlanMode", "hooks": []any{hook("/question")}}}}}
	b, _ := json.Marshal(settings)
	f, err := os.CreateTemp("", "nook-session-*.json")
	if err != nil {
		r.Stop()
		return nil, err
	}
	r.settings = f.Name()
	if _, err = f.Write(b); err != nil {
		f.Close()
		r.Stop()
		return nil, err
	}
	f.Close()
	return r, nil
}
func (r *claude) Send(text string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("Claude session is stopped")
	}
	if r.busy {
		return errors.New("Claude is already working")
	}
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"nook": map[string]any{"command": r.c.Helper, "args": []string{"--permission-host"}}}})
	args := []string{"--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--settings", r.settings, "--mcp-config", string(mcp), "--permission-prompt-tool", "mcp__nook__approve"}
	if r.resume {
		args = append(args, "--resume", r.session)
	} else {
		args = append(args, "--session-id", r.session)
	}
	child, err := process.Start(r.c.Info.Path, args, r.c.Session.Cwd, []string{"NOOK_SESSION_TOKEN=" + r.token, "NOOK_PERMISSION_URL=" + r.url + "/approve"})
	if err != nil {
		return err
	}
	birth, identityErr := process.Identity(child.Cmd.Process.Pid)
	if identityErr != nil {
		go func() { io.Copy(io.Discard, child.Out); child.Wait() }()
		child.Stop()
		return identityErr
	}
	identity, _ := json.Marshal(map[string]any{"pid": child.Cmd.Process.Pid, "birth": birth})
	r.c.Emit(event("process", string(identity)))
	r.child = child
	r.busy = true
	r.turnDone = make(chan struct{})
	done := r.turnDone
	b, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
	if err = child.Write(append(b, '\n')); err != nil {
		go func() { io.Copy(io.Discard, child.Out); child.Wait(); close(done) }()
		child.Stop()
		r.busy = false
		return err
	}
	child.In.Close()
	go r.read(child, done)
	return nil
}
func (r *claude) read(child *process.Child, done chan struct{}) {
	scan := bufio.NewScanner(child.Out)
	scan.Buffer(make([]byte, 4096), 8*1024*1024)
	complete := false
	streamed := false
	item := model.ID()
	for scan.Scan() {
		var m map[string]any
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			continue
		}
		if id := str(m, "session_id"); id != "" {
			r.mu.Lock()
			first := !r.resume
			r.session = id
			r.resume = true
			r.mu.Unlock()
			if first {
				r.c.Emit(event("provider_id", id))
			}
		}
		switch str(m, "type") {
		case "stream_event":
			e := obj(m, "event")
			switch str(e, "type") {
			case "message_start":
				streamed = false
				item = model.ID()
			case "content_block_delta":
				d := obj(e, "delta")
				if str(d, "type") == "text_delta" {
					streamed = true
					r.c.Emit(model.SessionEvent{Kind: "delta", Text: str(d, "text"), ItemID: item})
				} else if str(d, "type") == "thinking_delta" {
					r.c.Emit(event("activity", "Thinking"))
				}
			case "content_block_start":
				b := obj(e, "content_block")
				if str(b, "type") == "tool_use" {
					r.c.Emit(event("activity", "Using "+str(b, "name")))
				}
			}
		case "assistant":
			content, _ := obj(m, "message")["content"].([]any)
			for _, v := range content {
				b, _ := v.(map[string]any)
				if str(b, "type") == "text" && !streamed {
					r.c.Emit(model.SessionEvent{Kind: "delta", Text: str(b, "text"), ItemID: item})
				}
				if str(b, "type") == "tool_use" {
					r.c.Emit(event("activity", "Using "+str(b, "name")))
				}
			}
		case "result":
			complete = true
			failed, _ := m["is_error"].(bool)
			if failed {
				msg := str(m, "result")
				if msg == "" {
					msg = fmt.Sprint(m["errors"])
				}
				r.c.Emit(event("error", ExplainError(msg)))
			} else {
				r.c.Emit(event("completed", "Ready for your next thought"))
			}
		}
	}
	readErr := scan.Err()
	err := child.Wait()
	r.mu.Lock()
	stopped := r.closed
	r.busy = false
	r.child = nil
	for id, ch := range r.pending {
		select {
		case ch <- model.ApprovalResponse{Decision: "decline"}:
		default:
		}
		delete(r.pending, id)
	}
	r.mu.Unlock()
	r.c.Emit(event("process_clear", ""))
	close(done)
	if !complete && !stopped {
		msg := "Claude stopped before completing the turn. Resume to continue."
		if readErr != nil {
			msg = readErr.Error()
		} else if err != nil {
			msg = fmt.Sprintf("Claude exited before completing the turn (%v). Check sign-in, provider version, and organization settings.", err)
		}
		r.c.Emit(event("disconnected", msg))
	}
}
func (r *claude) Interrupt() error {
	r.mu.Lock()
	child := r.child
	r.mu.Unlock()
	if child == nil {
		return errors.New("No active turn")
	}
	child.Stop()
	r.c.Emit(event("stopped", "Turn stopped; resume to continue"))
	return nil
}
func (r *claude) Stop() {
	r.mu.Lock()
	r.closed = true
	child := r.child
	r.mu.Unlock()
	r.cancel()
	if r.server != nil {
		r.server.Close()
	}
	if child != nil {
		child.Stop()
	}
	if r.settings != "" {
		os.Remove(r.settings)
	}
}
func (r *claude) Respond(a model.ApprovalResponse) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, ok := r.pending[a.RequestID]
	if !ok {
		return errors.New("This request has expired")
	}
	delete(r.pending, a.RequestID)
	ch <- a
	return nil
}
func (r *claude) hook(w http.ResponseWriter, req *http.Request) {
	if req.Method != "POST" || subtle.ConstantTimeCompare([]byte(req.Header.Get("Authorization")), []byte("Bearer "+r.token)) != 1 {
		http.Error(w, "Forbidden", 403)
		return
	}
	var body map[string]any
	if json.NewDecoder(http.MaxBytesReader(w, req.Body, 1024*1024)).Decode(&body) != nil {
		http.Error(w, "Invalid request", 400)
		return
	}
	input := obj(body, "tool_input")
	if input == nil {
		input = obj(body, "input")
	}
	tool := str(body, "tool_name")
	detail, _ := json.MarshalIndent(input, "", "  ")
	a := model.ApprovalRequest{ID: model.ID(), Kind: "approval", Title: "Allow " + tool + "?", Detail: string(detail), Decisions: []string{"accept", "decline"}}
	question := req.URL.Path == "/question"
	if question {
		switch tool {
		case "AskUserQuestion":
			a.Kind = "question"
			a.Title = "Your input is needed"
			a.Questions = questions(input, true)
			a.Decisions = []string{"answer", "cancel"}
		case "ExitPlanMode":
			a.Title = "Approve this plan"
			a.Detail = str(input, "plan")
		default:
			http.Error(w, "Unsupported question", 400)
			return
		}
	}
	ch := make(chan model.ApprovalResponse, 1)
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		http.Error(w, "Session stopped", 410)
		return
	}
	r.pending[a.ID] = ch
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.pending, a.ID)
		r.mu.Unlock()
		r.c.Emit(model.SessionEvent{Kind: "resolved", ItemID: a.ID})
	}()
	r.c.Emit(model.SessionEvent{Kind: "approval", Approval: &a})
	answer := model.ApprovalResponse{Decision: "decline"}
	timer := time.NewTimer(590 * time.Second)
	defer timer.Stop()
	select {
	case answer = <-ch:
	case <-req.Context().Done():
		return
	case <-r.ctx.Done():
	case <-timer.C:
	}
	allow := answer.Decision == "accept" || answer.Decision == "answer"
	w.Header().Set("Content-Type", "application/json")
	if question {
		decision := "deny"
		if allow {
			decision = "allow"
		}
		out := map[string]any{"hookEventName": "PreToolUse", "permissionDecision": decision}
		if allow {
			if input == nil {
				input = map[string]any{}
			}
			if tool == "AskUserQuestion" {
				answers := map[string]string{}
				for k, v := range answer.Answers {
					answers[k] = strings.Join(v, ", ")
				}
				input["answers"] = answers
			}
			out["updatedInput"] = input
		}
		json.NewEncoder(w).Encode(map[string]any{"hookSpecificOutput": out})
		return
	}
	if allow {
		json.NewEncoder(w).Encode(map[string]any{"behavior": "allow", "updatedInput": input})
	} else {
		json.NewEncoder(w).Encode(map[string]any{"behavior": "deny", "message": "The user declined, or the request expired."})
	}
}

// PermissionHost is a small stdio MCP server run by Claude as a child of Nook.
// Tokens arrive only through the environment, never command arguments or disk.
func PermissionHost(in io.Reader, out io.Writer) error {
	scan := bufio.NewScanner(in)
	scan.Buffer(make([]byte, 4096), 1024*1024)
	enc := json.NewEncoder(out)
	for scan.Scan() {
		var msg rpc
		if json.Unmarshal(scan.Bytes(), &msg) != nil {
			continue
		}
		if len(msg.ID) == 0 {
			continue
		}
		var result any
		switch msg.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "nook", "version": "0.1.0"}}
		case "ping":
			result = map[string]any{}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "approve", "description": "Ask the user for permission in Nook", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"tool_name": map[string]any{"type": "string"}, "input": map[string]any{"type": "object"}}, "required": []string{"tool_name", "input"}}}}}
		case "tools/call":
			var p struct {
				Arguments json.RawMessage `json:"arguments"`
			}
			json.Unmarshal(msg.Params, &p)
			req, e := http.NewRequest("POST", os.Getenv("NOOK_PERMISSION_URL"), bytes.NewReader(p.Arguments))
			var response []byte
			if e == nil {
				req.Header.Set("Authorization", "Bearer "+os.Getenv("NOOK_SESSION_TOKEN"))
				client := http.Client{Timeout: 595 * time.Second}
				res, err := client.Do(req)
				if err == nil {
					if res.StatusCode == 200 {
						response, _ = io.ReadAll(io.LimitReader(res.Body, 1024*1024))
					}
					res.Body.Close()
				}
			}
			if len(response) == 0 {
				response = []byte(`{"behavior":"deny","message":"Nook is unavailable"}`)
			}
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": string(response)}}}
		default:
			enc.Encode(map[string]any{"id": msg.ID, "jsonrpc": "2.0", "error": map[string]any{"code": -32601, "message": "Unsupported method"}})
			continue
		}
		if err := enc.Encode(map[string]any{"id": msg.ID, "jsonrpc": "2.0", "result": result}); err != nil {
			return err
		}
	}
	return scan.Err()
}
