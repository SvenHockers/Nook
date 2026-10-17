import type { RuntimeState } from "../avatars/model";
import type { WorkflowRecord, WorkflowTaskRecord } from "../../types";
export type { WorkflowState, TaskState } from "../../types";
export interface WorkTask extends Pick<
  WorkflowTaskRecord,
  "id" | "title" | "state" | "dependsOn"
> {
  owner: number;
  agentState: RuntimeState;
  acceptance: string;
  context: string[];
  artifactIds: string[];
}
export interface Workflow extends Pick<
  WorkflowRecord,
  "id" | "goal" | "state"
> {
  checkpoint: string;
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
