// Package ipc implements the private, newline-delimited desktop protocol.
// stdin EOF is ownership loss: it always stops Nook's agent processes.
package ipc

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"nook/internal/desktop"
	"nook/internal/model"
	"nook/internal/workspace"
	"os"
	"path/filepath"
	"sync"
)

type Request struct {
	ID     uint64            `json:"id"`
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}
type Response struct {
	ID     uint64 `json:"id,omitempty"`
	Result any    `json:"result"`
	Error  string `json:"error,omitempty"`
	Event  string `json:"event,omitempty"`
}

func Serve(in io.Reader, out io.Writer, root, helper string) error {
	var writeMu sync.Mutex
	write := func(v Response) { writeMu.Lock(); defer writeMu.Unlock(); _ = json.NewEncoder(out).Encode(v) }
	service, err := workspace.New(root, helper, func(event string, data any) { write(Response{Event: "nook:" + event, Result: data}) })
	if err != nil {
		return err
	}
	scan := bufio.NewScanner(in)
	scan.Buffer(make([]byte, 4096), 2*1024*1024)
	var wg sync.WaitGroup
	for scan.Scan() {
		var req Request
		if err = json.Unmarshal(scan.Bytes(), &req); err != nil {
			write(Response{Error: "Malformed request"})
			continue
		}
		if req.Method == "Shutdown" {
			wg.Wait()
			err = service.Close()
			r := Response{ID: req.ID, Result: true}
			if err != nil {
				r.Error = err.Error()
			}
			write(r)
			return err
		}
		// Independent requests may run concurrently, especially approvals and stop.
		wg.Add(1)
		go func(r Request) {
			defer wg.Done()
			result, e := Dispatch(service, r)
			response := Response{ID: r.ID, Result: result}
			if e != nil {
				response.Error = e.Error()
			}
			write(response)
		}(req)
	}
	wg.Wait()
	closeErr := service.Close()
	if scan.Err() != nil {
		return scan.Err()
	}
	return closeErr
}
func arg[T any](r Request, i int) (T, error) {
	var v T
	if i >= len(r.Args) {
		return v, errors.New("Missing argument")
	}
	err := json.Unmarshal(r.Args[i], &v)
	return v, err
}
func Dispatch(s *workspace.Service, r Request) (any, error) {
	switch r.Method {
	case "Snapshot":
		return s.Snapshot(), nil
	case "RefreshProviders":
		return s.RefreshProviders(), nil
	case "Navigation":
		return s.Navigation(), nil
	case "AddProject":
		p, e := arg[string](r, 0)
		if e != nil {
			return nil, e
		}
		return s.AddProject(p)
	case "CreateWorkflow":
		v, e := arg[model.CreateWorkflowRequest](r, 0)
		if e != nil {
			return nil, e
		}
		return s.CreateWorkflow(v)
	case "StartWorkflowTask", "AcceptWorkflowTask", "WorkflowEvidence":
		v, e := arg[model.WorkflowAction](r, 0)
		if e != nil {
			return nil, e
		}
		switch r.Method {
		case "StartWorkflowTask":
			return s.StartWorkflowTask(v)
		case "AcceptWorkflowTask":
			return s.AcceptWorkflowTask(v)
		default:
			return s.WorkflowEvidence(v)
		}
	case "Launch":
		v, e := arg[model.LaunchRequest](r, 0)
		if e != nil {
			return nil, e
		}
		return s.Launch(v)
	case "Respond":
		v, e := arg[model.ApprovalResponse](r, 0)
		if e != nil {
			return nil, e
		}
		return nil, s.Respond(v)
	case "SaveNavigation":
		v, e := arg[string](r, 0)
		if e != nil {
			return nil, e
		}
		return nil, s.SaveNavigation(v)
	}
	id, e := arg[string](r, 0)
	if e != nil {
		return nil, e
	}
	switch r.Method {
	case "Stop":
		return nil, s.Stop(id)
	case "Archive":
		return nil, s.Archive(id)
	case "Changes":
		return s.Changes(id)
	case "Reveal":
		v, e := s.Session(id)
		if e != nil {
			return nil, e
		}
		return nil, desktop.Reveal(v.Cwd)
	case "Send", "Rename", "SetExecutable":
		v, e := arg[string](r, 1)
		if e != nil {
			return nil, e
		}
		switch r.Method {
		case "Send":
			return nil, s.Send(id, v)
		case "Rename":
			return nil, s.Rename(id, v)
		default:
			return nil, s.SetExecutable(id, v)
		}
	case "Events":
		after, e := arg[int64](r, 1)
		if e != nil {
			return nil, e
		}
		return s.Events(id, after)
	case "Context":
		items, e := arg[[]model.ContextAssignment](r, 1)
		if e != nil {
			return nil, e
		}
		project, e := arg[bool](r, 2)
		if e != nil {
			return nil, e
		}
		return nil, s.Context(id, items, project)
	case "ExportPatch":
		path, e := arg[string](r, 1)
		if e != nil {
			return nil, e
		}
		if !filepath.IsAbs(path) {
			return nil, errors.New("Choose an absolute export path")
		}
		patch, e := s.Patch(id)
		if e != nil {
			return nil, e
		}
		return path, os.WriteFile(path, []byte(patch), 0600)
	default:
		return nil, fmt.Errorf("Unknown method: %s", r.Method)
	}
}
