package model

// Workflow task acceptance is a human decision, separate from provider turn completion.
type WorkflowTask struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Prompt     string   `json:"prompt"`
	Provider   string   `json:"provider"`
	DependsOn  []string `json:"dependsOn"`
	SessionID  string   `json:"sessionId"`
	ArtifactID string   `json:"artifactId"`
	State      string   `json:"state"`
}
type WorkflowEvent struct {
	ID     string `json:"id"`
	Time   string `json:"time"`
	TaskID string `json:"taskId"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
}
type Workflow struct {
	ID        string          `json:"id"`
	ProjectID string          `json:"projectId"`
	Goal      string          `json:"goal"`
	Revision  int             `json:"revision"`
	State     string          `json:"state"`
	Tasks     []WorkflowTask  `json:"tasks"`
	History   []WorkflowEvent `json:"history"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}
type CreateWorkflowRequest struct {
	ProjectID string         `json:"projectId"`
	Goal      string         `json:"goal"`
	Tasks     []WorkflowTask `json:"tasks"`
}
type WorkflowAction struct {
	WorkflowID     string `json:"workflowId"`
	TaskID         string `json:"taskId"`
	Revision       int    `json:"revision"`
	SourceRevision int64  `json:"sourceRevision"`
	Shared         bool   `json:"shared"`
}
type WorkflowArtifact struct {
	ID         string         `json:"id"`
	WorkflowID string         `json:"workflowId"`
	ProjectID  string         `json:"projectId"`
	TaskID     string         `json:"taskId"`
	SessionID  string         `json:"sessionId"`
	Revision   int64          `json:"revision"`
	AcceptedAt string         `json:"acceptedAt"`
	Events     []SessionEvent `json:"events"`
}
