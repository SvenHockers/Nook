// Browser-only workflow simulator. Never imported by native service code.
import type {
  API,
  Session,
  SessionEvent,
  WorkflowRecord,
  WorkflowArtifact,
  WorkflowAction,
} from "../../types";
export function createWorkflowDemo(
  sessions: Session[],
  events: SessionEvent[],
  launch: API["Launch"],
  changed: () => void,
  complete: (id: string) => void,
) {
  const workflows: WorkflowRecord[] = [];
  const artifacts = new Map<string, WorkflowArtifact>();
  const project = (w: WorkflowRecord): WorkflowRecord => {
    const copy = structuredClone(w);
    for (const t of copy.tasks) {
      const session = sessions.find((s) => s.id === t.sessionId);
      t.state = t.artifactId
        ? "succeeded"
        : session
          ? session.state === "completed" || session.state === "waiting"
            ? "waiting_for_input"
            : session.state === "working" || session.state === "starting"
              ? "running"
              : session.state === "failed"
                ? "failed"
                : "blocked"
          : t.dependsOn.every((id) =>
                copy.tasks.some((d) => d.id === id && d.artifactId),
              )
            ? "ready"
            : "blocked";
    }
    copy.state = copy.tasks.every((t) => t.artifactId)
      ? "completed"
      : copy.tasks.some((t) => t.state === "waiting_for_input")
        ? "waiting_for_input"
        : copy.tasks.some((t) => t.state === "running")
          ? "running"
          : copy.history.length > 1
            ? "blocked"
            : "draft";
    return copy;
  };
  const find = (r: WorkflowAction) => {
    const w = workflows.find((w) => w.id === r.workflowId);
    if (!w || w.revision !== r.revision)
      throw Error("Workflow changed; refresh before trying again");
    const t = w.tasks.find((t) => t.id === r.taskId);
    if (!t) throw Error("Task not found");
    return { w, t };
  };
  const event = (
    w: WorkflowRecord,
    taskId: string,
    kind: string,
    text: string,
  ) => {
    w.updatedAt = new Date().toISOString();
    w.history.push({
      id: crypto.randomUUID(),
      time: w.updatedAt,
      taskId,
      kind,
      text,
    });
  };
  const evidence: API["WorkflowEvidence"] = async (r) => {
    const { w, t } = find(r);
    if (t.artifactId) return structuredClone(artifacts.get(t.artifactId)!);
    if (!t.sessionId) throw Error("No assigned session evidence");
    const records = events.filter((e) => e.sessionId === t.sessionId);
    return structuredClone({
      id: "",
      workflowId: w.id,
      projectId: w.projectId,
      taskId: t.id,
      sessionId: t.sessionId,
      revision: records.at(-1)?.sequence || 0,
      acceptedAt: "",
      events: records,
    });
  };
  const api: Pick<
    API,
    | "CreateWorkflow"
    | "StartWorkflowTask"
    | "AcceptWorkflowTask"
    | "WorkflowEvidence"
  > = {
    CreateWorkflow: async (r) => {
      if (!r.goal.trim() || !r.tasks.length)
        throw Error("Add a goal and at least one task");
      const w: WorkflowRecord = {
        id: crypto.randomUUID(),
        projectId: r.projectId,
        goal: r.goal,
        revision: 1,
        state: "draft",
        tasks: r.tasks.map((t) => ({
          ...t,
          dependsOn: [...t.dependsOn],
          sessionId: "",
          artifactId: "",
          state: "ready",
        })),
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      event(w, "", "created", "Demo workflow saved. No live execution.");
      workflows.push(w);
      changed();
      return project(w);
    },
    StartWorkflowTask: async (r) => {
      const { w, t } = find(r);
      if (t.sessionId || t.artifactId)
        throw Error("This task already has a session");
      if (
        !t.dependsOn.every((id) =>
          w.tasks.some((d) => d.id === id && d.artifactId),
        )
      )
        throw Error("Accept every dependency before starting this task");
      const session = await launch({
        projectId: w.projectId,
        provider: t.provider,
        title: t.title,
        prompt: t.prompt,
        shared: !!r.shared,
      });
      t.sessionId = session.id;
      w.revision++;
      event(w, t.id, "started", "Started simulated session");
      changed();
      setTimeout(() => complete(session.id), 400);
      return session;
    },
    WorkflowEvidence: evidence,
    AcceptWorkflowTask: async (r) => {
      const { w, t } = find(r);
      if (
        t.artifactId ||
        sessions.find((s) => s.id === t.sessionId)?.state !== "completed"
      )
        throw Error("Wait for the assigned session to finish");
      const a = await evidence(r);
      if (!a.revision || a.revision !== r.sourceRevision)
        throw Error("Source changed; inspect the latest evidence");
      a.id = crypto.randomUUID();
      a.acceptedAt = new Date().toISOString();
      artifacts.set(a.id, structuredClone(a));
      t.artifactId = a.id;
      w.revision++;
      event(
        w,
        t.id,
        "accepted",
        `Human accepted simulated source revision ${a.revision}`,
      );
      changed();
      return project(w);
    },
  };
  return { api, snapshot: () => workflows.map(project) };
}
