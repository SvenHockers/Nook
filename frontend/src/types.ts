import type { PresentRequest, PresentResult } from "./features/canvas/model";
export type State =
  | "starting"
  | "working"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed"
  | "disconnected";
export interface ContextItem {
  id: string;
  kind: "note" | "file" | "folder";
  name: string;
  value: string;
  enabled: boolean;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  git: boolean;
  context: ContextItem[];
}
export interface Capabilities {
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  questions: boolean;
  sandbox: string;
}
export interface Provider {
  id: string;
  name: string;
  path: string;
  version: string;
  available: boolean;
  problem: string;
  capabilities: Capabilities;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  provider: string;
  state: State;
  activity: string;
  error: string;
  cwd: string;
  branch: string;
  baseCommit: string;
  isolated: boolean;
  providerId: string;
  avatar: { shape: number; color: number; name: string };
  context: ContextItem[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  capabilities: Capabilities;
}
export interface Question {
  id: string;
  text: string;
  options: string[];
  multi: boolean;
}
export interface Approval {
  id: string;
  sessionId: string;
  kind: string;
  title: string;
  detail: string;
  questions: Question[];
  decisions: string[];
}
export interface Answer {
  sessionId: string;
  requestId: string;
  decision: string;
  answers: Record<string, string[]>;
}
export interface VerificationCommand {
  name: string;
  argv: string[];
  timeoutSeconds: number;
  outputCap: number;
}
export interface CheckConfiguration {
  revision: string;
  commands: VerificationCommand[];
  approved: boolean;
}
export interface CheckRun {
  id: string;
  command: VerificationCommand;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  durationMs: number;
  outcome: string;
  output: string;
  truncated: boolean;
}
export interface SessionEvent {
  recorded?: {
    label: string;
    data: import("./features/canvas/model").EvidenceData;
  }[];
  check?: CheckRun;
  sequence: number;
  sessionId: string;
  kind: string;
  text: string;
  itemId: string;
  time: string;
  approval?: Approval;
}
export type WorkflowState =
  | "draft"
  | "queued"
  | "running"
  | "waiting_for_input"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";
export type TaskState =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";
export interface TaskAttempt {
  sessionId: string;
  outcome: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
}
export interface WorkflowTaskRecord {
  id: string;
  title: string;
  prompt: string;
  provider: string;
  dependsOn: string[];
  sessionId: string;
  artifactId: string;
  attempts: TaskAttempt[];
  state: TaskState;
}
export interface WorkflowRecord {
  id: string;
  projectId: string;
  goal: string;
  revision: number;
  state: WorkflowState;
  canceled: boolean;
  archived: boolean;
  tasks: WorkflowTaskRecord[];
  history: {
    id: string;
    time: string;
    taskId: string;
    kind: string;
    text: string;
  }[];
  createdAt: string;
  updatedAt: string;
}
export interface CreateWorkflowRequest {
  projectId: string;
  goal: string;
  tasks: Pick<
    WorkflowTaskRecord,
    "id" | "title" | "prompt" | "provider" | "dependsOn"
  >[];
}
export interface WorkflowAction {
  workflowId: string;
  taskId: string;
  revision: number;
  sourceRevision?: number;
  sourceCodeRevision?: string;
  reason?: string;
  shared?: boolean;
}
export interface EditWorkflowRequest extends Omit<
  CreateWorkflowRequest,
  "projectId"
> {
  workflowId: string;
  revision: number;
}
export interface WorkflowArtifact {
  id: string;
  workflowId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  revision: number;
  acceptedAt: string;
  handoff: string;
  handoffBytes: number;
  omittedRecords: number;
  headCommit: string;
  changes: Changes | null;
  diffStat: string;
  codeRevision: string;
  events: SessionEvent[];
}
export interface Snapshot {
  workflows: WorkflowRecord[];
  projects: Project[];
  sessions: Session[];
  providers: Provider[];
  approvals: Approval[];
  problem: string;
}
export interface Launch {
  projectId: string;
  provider: string;
  title: string;
  prompt: string;
  shared: boolean;
}
export interface Changes {
  status: string;
  diff: string;
  truncated: boolean;
}
export interface API {
  CaptureEvidence(id: string): Promise<void>;
  CheckConfiguration(project: string): Promise<CheckConfiguration>;
  ConfigureChecks(
    project: string,
    commands: VerificationCommand[],
  ): Promise<CheckConfiguration>;
  RunCheck(request: {
    sessionId: string;
    name: string;
    revision: string;
    confirm: boolean;
  }): Promise<void>;
  CancelCheck(id: string): Promise<void>;
  PresentSession(request: PresentRequest): Promise<PresentResult>;
  CancelPresentation(id: string): Promise<void>;
  RejectWorkflowTask(request: WorkflowAction): Promise<WorkflowRecord>;
  EditWorkflow(request: EditWorkflowRequest): Promise<WorkflowRecord>;
  CancelWorkflow(request: WorkflowAction): Promise<WorkflowRecord>;
  ArchiveWorkflow(request: WorkflowAction): Promise<WorkflowRecord>;
  CreateWorkflow(request: CreateWorkflowRequest): Promise<WorkflowRecord>;
  StartWorkflowTask(request: WorkflowAction): Promise<Session>;
  AcceptWorkflowTask(request: WorkflowAction): Promise<WorkflowRecord>;
  WorkflowEvidence(request: WorkflowAction): Promise<WorkflowArtifact>;
  Snapshot(): Promise<Snapshot>;
  AddProject(): Promise<Project>;
  Launch(r: Launch): Promise<Session>;
  Send(id: string, text: string): Promise<void>;
  Stop(id: string): Promise<void>;
  Respond(r: Answer): Promise<void>;
  Events(id: string, after: number): Promise<SessionEvent[]>;
  RefreshProviders(): Promise<Provider[]>;
  ChooseExecutable(id: string): Promise<void>;
  Context(id: string, items: ContextItem[], project: boolean): Promise<void>;
  ChooseContext(kind: string): Promise<string>;
  Archive(id: string): Promise<void>;
  Rename(id: string, title: string): Promise<void>;
  Changes(id: string): Promise<Changes>;
  ExportPatch(id: string): Promise<string>;
  Reveal(id: string): Promise<void>;
  Notify(title: string, body: string): Promise<void>;
  Navigation(): Promise<string>;
  SaveNavigation(v: string): Promise<void>;
}
export const active = (s: State) =>
  ["starting", "working", "waiting"].includes(s);
export const needsAttention = (s: Session) =>
  ["waiting", "failed", "disconnected"].includes(s.state);
