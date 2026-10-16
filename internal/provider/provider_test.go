package provider

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"nook/internal/model"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("NOOK_FAKE_PROVIDER") == "1" {
		switch os.Args[1] {
		case "app-server":
			fakeCodex()
			os.Exit(0)
		case "--print":
			fakeClaude()
			os.Exit(0)
		case "--permission-host":
			PermissionHost(os.Stdin, os.Stdout)
			os.Exit(0)
		case "--version":
			fmt.Println("2.1.295 (test provider)")
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}
func send(v any) {
	b, _ := json.Marshal(v)
	half := len(b) / 2
	os.Stdout.Write(b[:half])
	os.Stdout.Write(append(b[half:], '\n'))
}
func fakeCodex() {
	scan := bufio.NewScanner(os.Stdin)
	approvals := 0
	for scan.Scan() {
		var m rpc
		json.Unmarshal(scan.Bytes(), &m)
		switch m.Method {
		case "initialize":
			send(map[string]any{"id": m.ID, "result": map[string]any{}})
		case "thread/start", "thread/resume":
			send(map[string]any{"id": m.ID, "result": map[string]any{"thread": map[string]string{"id": "test-thread"}}})
		case "turn/start":
			send(map[string]any{"method": "turn/started", "params": map[string]any{"turn": map[string]string{"id": "t1"}}})
			send(map[string]any{"id": m.ID, "result": map[string]any{}})
			for _, id := range []string{"approve-1", "approve-2"} {
				send(map[string]any{"id": id, "method": "item/commandExecution/requestApproval", "params": map[string]any{"command": "echo harmless", "threadId": "test-thread", "turnId": "t1"}})
			}
		case "turn/interrupt":
			send(map[string]any{"id": m.ID, "result": map[string]any{}})
		default:
			if len(m.Result) > 0 {
				approvals++
				if approvals == 2 {
					send(map[string]any{"method": "item/agentMessage/delta", "params": map[string]string{"itemId": "m1", "delta": "Hello "}})
					send(map[string]any{"method": "item/agentMessage/delta", "params": map[string]string{"itemId": "m1", "delta": "world"}})
					send(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]string{"id": "t1", "status": "completed"}}})
				}
			}
		}
	}
}
func fakeClaude() {
	io.ReadAll(os.Stdin)
	id := ""
	for i, a := range os.Args {
		if a == "--session-id" || a == "--resume" {
			id = os.Args[i+1]
		}
	}
	send(map[string]string{"type": "system", "session_id": id})
	b := []byte(`{"tool_name":"Write","input":{"file_path":"example.txt","content":"hello"}}`)
	req, _ := http.NewRequest("POST", os.Getenv("NOOK_PERMISSION_URL"), bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("NOOK_SESSION_TOKEN"))
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		os.Exit(3)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(data), "allow") {
		os.Exit(4)
	}
	send(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]string{"type": "text", "text": "Done"}}}})
	send(map[string]any{"type": "result", "session_id": id, "is_error": false})
}
func waitEvent(t *testing.T, ch <-chan model.SessionEvent, kind string) model.SessionEvent {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case e := <-ch:
			if e.Kind == kind {
				return e
			}
		case <-timer.C:
			t.Fatal("timed out waiting for " + kind)
			return model.SessionEvent{}
		}
	}
}
func TestCodexConcurrentApprovalsAndStreaming(t *testing.T) {
	t.Setenv("NOOK_FAKE_PROVIDER", "1")
	ch := make(chan model.SessionEvent, 100)
	rt, e := startCodex(Config{Info: model.ProviderInfo{Path: os.Args[0]}, Session: model.Session{Cwd: t.TempDir()}, Emit: func(e model.SessionEvent) { ch <- e }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Stop()
	if e = rt.Send("Hello"); e != nil {
		t.Fatal(e)
	}
	a := waitEvent(t, ch, "approval").Approval
	b := waitEvent(t, ch, "approval").Approval
	if a.ID == b.ID {
		t.Fatal("request collision")
	}
	for _, v := range []*model.ApprovalRequest{b, a} {
		if e = rt.Respond(model.ApprovalResponse{RequestID: v.ID, Decision: "accept"}); e != nil {
			t.Fatal(e)
		}
	}
	if e = rt.Respond(model.ApprovalResponse{RequestID: a.ID, Decision: "accept"}); e == nil {
		t.Fatal("duplicate approval accepted")
	}
	x := waitEvent(t, ch, "delta")
	y := waitEvent(t, ch, "delta")
	if x.Text+y.Text != "Hello world" {
		t.Fatal(x, y)
	}
	waitEvent(t, ch, "completed")
}
func TestClaudeBridgeAndResume(t *testing.T) {
	t.Setenv("NOOK_FAKE_PROVIDER", "1")
	ch := make(chan model.SessionEvent, 100)
	rt, e := startClaude(Config{Info: model.ProviderInfo{Path: os.Args[0]}, Session: model.Session{Cwd: t.TempDir()}, Helper: os.Args[0], Emit: func(e model.SessionEvent) { ch <- e }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Stop()
	for i := 0; i < 2; i++ {
		if e = rt.Send("Hi"); e != nil {
			t.Fatal(e)
		}
		a := waitEvent(t, ch, "approval").Approval
		if e = rt.Respond(model.ApprovalResponse{RequestID: a.ID, Decision: "accept"}); e != nil {
			t.Fatal(e)
		}
		waitEvent(t, ch, "completed")
		c := rt.(*claude)
		c.mu.Lock()
		done := c.turnDone
		c.mu.Unlock()
		<-done
	}
	if !rt.(*claude).resume {
		t.Fatal("session not resumable")
	}
}
func TestClaudeRejectsUnauthenticatedHook(t *testing.T) {
	rt, e := startClaude(Config{Session: model.Session{}, Emit: func(model.SessionEvent) {}})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Stop()
	res, e := http.Post(rt.(*claude).url+"/question", "application/json", strings.NewReader(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
}
func TestVersionBoundary(t *testing.T) {
	for _, v := range []string{"2.1.294", "garbage", "1.9.999"} {
		if atLeast(v, 2, 1, 295) {
			t.Fatal(v)
		}
	}
	if !atLeast("2.1.295 (Claude Code)", 2, 1, 295) {
		t.Fatal("supported version rejected")
	}
}
