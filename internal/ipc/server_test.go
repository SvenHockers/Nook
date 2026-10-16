package ipc

import (
	"bytes"
	"encoding/json"
	"nook/internal/model"
	"nook/internal/workspace"
	"strings"
	"testing"
)

func TestMalformedAndUnknownRequestsDoNotCrashRuntime(t *testing.T) {
	var out bytes.Buffer
	input := "{bad}\n" + `{"id":1,"method":"UntrustedCommand","args":["anything"]}` + "\n" + `{"id":2,"method":"Shutdown","args":[]}` + "\n"
	if err := Serve(strings.NewReader(input), &out, t.TempDir(), ""); err != nil {
		t.Fatal(err)
	}
	replies := map[uint64]Response{}
	dec := json.NewDecoder(&out)
	for dec.More() {
		var r Response
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		if r.Event == "" {
			replies[r.ID] = r
		}
	}
	if replies[0].Error != "Malformed request" || !strings.Contains(replies[1].Error, "Unknown method") || replies[2].Error != "" {
		t.Fatal(replies)
	}
}

func TestEOFClosesDatabaseAndRetainsState(t *testing.T) {
	root := t.TempDir()
	var out bytes.Buffer
	input := `{"id":1,"method":"SaveNavigation","args":["{\"theme\":\"dark\"}"]}` + "\n"
	if err := Serve(strings.NewReader(input), &out, root, ""); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := Serve(strings.NewReader(`{"id":2,"method":"Navigation","args":[]}`+"\n"), &out, root, ""); err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(&out)
	for dec.More() {
		var r Response
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		if r.ID == 2 {
			if r.Result != `{"theme":"dark"}` {
				t.Fatal(r)
			}
			return
		}
	}
	t.Fatal("missing navigation response")
}

func TestWorkflowCommandsReachServiceAndEnforceDependencies(t *testing.T) {
	s, err := workspace.New(t.TempDir(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	encode := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
	project, err := Dispatch(s, Request{Method: "AddProject", Args: []json.RawMessage{encode(t.TempDir())}})
	if err != nil {
		t.Fatal(err)
	}
	p := project.(model.Project)
	value, err := Dispatch(s, Request{Method: "CreateWorkflow", Args: []json.RawMessage{encode(model.CreateWorkflowRequest{ProjectID: p.ID, Goal: "Review a handoff", Tasks: []model.WorkflowTask{{ID: "a", Title: "Build", Prompt: "Build", Provider: "codex"}, {ID: "b", Title: "Review", Prompt: "Review", Provider: "codex", DependsOn: []string{"a"}}}})}})
	if err != nil {
		t.Fatal(err)
	}
	w := value.(model.Workflow)
	_, err = Dispatch(s, Request{Method: "StartWorkflowTask", Args: []json.RawMessage{encode(model.WorkflowAction{WorkflowID: w.ID, TaskID: "b", Revision: w.Revision})}})
	if err == nil || !strings.Contains(err.Error(), "dependency") {
		t.Fatal(err)
	}
}
