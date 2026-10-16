import type { RuntimeState } from "../avatars/model";
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
export interface WorkTask {
  id: string;
  title: string;
  owner: number;
  state: TaskState;
  agentState: RuntimeState;
  dependsOn: string[];
  acceptance: string;
  context: string[];
  artifactIds: string[];
}
export interface Workflow {
  id: string;
  goal: string;
  checkpoint: string;
  state: WorkflowState;
  tasks: WorkTask[];
  history: { time: string; text: string }[];
  handoffs: {
    from: string;
    to: string;
    artifactId: string;
    revision: string;
    time: string;
  }[];
}
export type LoopPhase = "discover" | "execute" | "verify" | "decide";
export interface LoopDefinition {
  id: string;
  objective: string;
  trigger: "manual" | "scheduled" | "event";
  maxAttempts: number;
  verification: string[];
  approval: string;
}
export interface LoopAttempt {
  number: number;
  phase: LoopPhase;
  outcome: "running" | "failed" | "accepted";
  timestamp: string;
  checks: {
    name: string;
    result: "passed" | "failed" | "running";
    evidenceId: string;
  }[];
  note: string;
}
export interface LoopRun {
  id: string;
  label: string;
  activity: string;
  definitionId: string;
  state:
    | "queued"
    | "running"
    | "waiting_for_input"
    | "completed"
    | "failed"
    | "canceled";
  owner: number;
  agentState: RuntimeState;
  attempts: LoopAttempt[];
}
