package model

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

type State string

const (
	Starting     State = "starting"
	Working      State = "working"
	Waiting      State = "waiting"
	Completed    State = "completed"
	Stopped      State = "stopped"
	Failed       State = "failed"
	Disconnected State = "disconnected"
)

func (s State) Active() bool { return s == Starting || s == Working || s == Waiting }
func ID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func UUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

type Project struct {
	ID      string              `json:"id"`
	Name    string              `json:"name"`
	Path    string              `json:"path"`
	Git     bool                `json:"git"`
	Context []ContextAssignment `json:"context"`
}
type ContextAssignment struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}
type Avatar struct {
	Shape int    `json:"shape"`
	Color int    `json:"color"`
	Name  string `json:"name"`
}
type Session struct {
	ProcessID    int                  `json:"processId"`
	ProcessBirth string               `json:"processBirth"`
	ID           string               `json:"id"`
	ProjectID    string               `json:"projectId"`
	Title        string               `json:"title"`
	Provider     string               `json:"provider"`
	State        State                `json:"state"`
	Activity     string               `json:"activity"`
	Error        string               `json:"error"`
	Cwd          string               `json:"cwd"`
	Branch       string               `json:"branch"`
	BaseCommit   string               `json:"baseCommit"`
	Isolated     bool                 `json:"isolated"`
	ProviderID   string               `json:"providerId"`
	Avatar       Avatar               `json:"avatar"`
	Context      []ContextAssignment  `json:"context"`
	CreatedAt    string               `json:"createdAt"`
	UpdatedAt    string               `json:"updatedAt"`
	Archived     bool                 `json:"archived"`
	Seen         bool                 `json:"seen"`
	Capabilities ProviderCapabilities `json:"capabilities"`
}
type ProviderCapabilities struct {
	Resume    bool   `json:"resume"`
	Interrupt bool   `json:"interrupt"`
	Approvals bool   `json:"approvals"`
	Questions bool   `json:"questions"`
	Sandbox   string `json:"sandbox"`
}
type ProviderInfo struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	Path         string               `json:"path"`
	Version      string               `json:"version"`
	Available    bool                 `json:"available"`
	Problem      string               `json:"problem"`
	Capabilities ProviderCapabilities `json:"capabilities"`
}
type Question struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Options []string `json:"options"`
	Multi   bool     `json:"multi"`
}
type ApprovalRequest struct {
	ID        string     `json:"id"`
	SessionID string     `json:"sessionId"`
	Kind      string     `json:"kind"`
	Title     string     `json:"title"`
	Detail    string     `json:"detail"`
	Questions []Question `json:"questions"`
	Decisions []string   `json:"decisions"`
}
type ApprovalResponse struct {
	SessionID string              `json:"sessionId"`
	RequestID string              `json:"requestId"`
	Decision  string              `json:"decision"`
	Answers   map[string][]string `json:"answers"`
}
type SessionEvent struct {
	Sequence  int64            `json:"sequence"`
	SessionID string           `json:"sessionId"`
	Kind      string           `json:"kind"`
	Text      string           `json:"text"`
	ItemID    string           `json:"itemId"`
	Time      string           `json:"time"`
	Approval  *ApprovalRequest `json:"approval,omitempty"`
}
type Snapshot struct {
	Workflows []Workflow        `json:"workflows"`
	Problem   string            `json:"problem"`
	Projects  []Project         `json:"projects"`
	Sessions  []Session         `json:"sessions"`
	Providers []ProviderInfo    `json:"providers"`
	Approvals []ApprovalRequest `json:"approvals"`
}
type LaunchRequest struct {
	ProjectID string `json:"projectId"`
	Provider  string `json:"provider"`
	Title     string `json:"title"`
	Prompt    string `json:"prompt"`
	Shared    bool   `json:"shared"`
}
type Changes struct {
	Status    string `json:"status"`
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated"`
}
