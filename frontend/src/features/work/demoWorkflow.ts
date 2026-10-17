// Browser-only workflow simulator. Never imported by native service code.
import type {
  API,
  Session,
  SessionEvent,
  WorkflowRecord,
  WorkflowArtifact,
  WorkflowAction,
} from "../../types";
import { active } from "../../types";
import { buildEvidence } from "../canvas/model";
export function createWorkflowDemo(
  sessions: Session[],
  events: SessionEvent[],
  launch: API["Launch"],
  changed: () => void,
  complete: (id: string) => void,
  stop: API["Stop"],
) {
  const workflows: WorkflowRecord[] = [];
  const artifacts = new Map<string, WorkflowArtifact>();
  const project = (w: WorkflowRecord): WorkflowRecord => {
    const copy = structuredClone(w);
    for (const t of copy.tasks) {
      for (const a of t.attempts) {
        if (a.outcome === "running")
          a.outcome =
            sessions.find((s) => s.id === a.sessionId)?.state || a.outcome;
      }
      const session = sessions.find((s) => s.id === t.sessionId);
      t.state = t.artifactId
        ? "succeeded"
        : copy.canceled
          ? "canceled"
          : session
            ? session.state === "completed" || session.state === "waiting"
              ? "waiting_for_input"
              : session.state === "working" || session.state === "starting"
                ? "running"
                : ["failed", "stopped", "disconnected"].includes(session.state)
                  ? "failed"
                  : "blocked"
            : t.dependsOn.every((id) =>
                  copy.tasks.some((d) => d.id === id && d.artifactId),
                )
              ? "ready"
              : "blocked";
    }
    copy.state = copy.canceled
      ? "canceled"
      : copy.tasks.some((t) => t.state === "failed")
        ? "failed"
        : copy.tasks.every((t) => t.artifactId)
          ? "completed"
          : copy.tasks.some((t) => t.state === "waiting_for_input")
            ? "waiting_for_input"
            : copy.tasks.some((t) => t.state === "running")
              ? "running"
              : copy.tasks.some((t) => t.sessionId || t.attempts.length)
                ? "blocked"
                : "draft";
    return copy;
  };
  const dependencies = (
    w: WorkflowRecord,
    task: WorkflowRecord["tasks"][number],
  ) => {
    const out: WorkflowRecord["tasks"] = [],
      seen = new Set<string>();
    const visit = (ids: string[]) => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const t = w.tasks.find((t) => t.id === id);
        if (!t) throw Error("Dependency task not found");
        visit(t.dependsOn);
        out.push(t);
      }
    };
    visit(task.dependsOn);
    return out;
  };
  const find = (r: WorkflowAction) => {
    const w = workflows.find((w) => w.id === r.workflowId);
    if (!w || w.revision !== r.revision)
      throw Error("Workflow changed; refresh before trying again");
    const t = w.tasks.find((t) => t.id === r.taskId);
    if (!t) throw Error("Task not found");
    return { w, t };
  };
  const mutable = (w: WorkflowRecord) => {
    if (w.canceled || w.archived)
      throw Error("Workflow is canceled or archived");
  };
  const workflow = (r: WorkflowAction) => {
    const w = workflows.find((w) => w.id === r.workflowId);
    if (!w || w.revision !== r.revision)
      throw Error("Workflow changed; refresh before trying again");
    return w;
  };
  const finish = (
    t: WorkflowRecord["tasks"][number],
    outcome: string,
    reason: string,
  ) => {
    const a = t.attempts.find((a) => a.sessionId === t.sessionId);
    if (a)
      Object.assign(a, {
        outcome,
        reason,
        finishedAt: new Date().toISOString(),
      });
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
    const { items, total } = buildEvidence(
      records.filter((e) =>
        [
          "user",
          "delta",
          "completed",
          "stopped",
          "error",
          "disconnected",
        ].includes(e.kind),
      ),
      {
        id: t.sessionId,
        projectId: w.projectId,
        revision: String(records.at(-1)?.sequence || 0),
        permissionScope: `local:${w.projectId}:${w.id}`,
      },
    );
    const chunks: string[] = [];
    let bytes = 0;
    for (const e of [...items].reverse()) {
      if (e.data.kind !== "text") continue;
      const text = `${e.label} (${e.attribution}): ${e.data.text}\n`;
      if (bytes + new TextEncoder().encode(text).length + 32 > 48 * 1024) break;
      bytes += new TextEncoder().encode(text).length;
      chunks.unshift(text);
    }
    const omittedRecords = total - chunks.length;
    const handoff =
      (omittedRecords ? "[Older records omitted]\n" : "") + chunks.join("");
    return structuredClone({
      handoff,
      handoffBytes: new TextEncoder().encode(handoff).length,
      omittedRecords,
      headCommit: "",
      changes: null,
      diffStat: "",
      codeRevision: "",
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
    | "RejectWorkflowTask"
    | "CancelWorkflow"
    | "ArchiveWorkflow"
    | "EditWorkflow"
    | "CreateWorkflow"
    | "StartWorkflowTask"
    | "AcceptWorkflowTask"
    | "WorkflowEvidence"
  > = {
    RejectWorkflowTask: async (r) => {
      const { w, t } = find(r);
      mutable(w);
      if (t.artifactId) throw Error("Accepted handoffs are immutable");
      const session = sessions.find((s) => s.id === t.sessionId);
      if (!session || active(session.state))
        throw Error("Stop or finish the attempt before rejecting");
      if (!r.reason?.trim() || new TextEncoder().encode(r.reason).length > 4096)
        throw Error("Give a rejection reason of at most 4096 bytes");
      finish(t, "rejected", r.reason.trim());
      t.sessionId = "";
      w.revision++;
      event(w, t.id, "rejected", r.reason.trim());
      changed();
      return project(w);
    },
    CancelWorkflow: async (r) => {
      const w = workflow(r);
      if (w.archived || w.tasks.every((t) => t.artifactId))
        throw Error("Workflow is archived or completed");
      w.canceled = true;
      w.revision++;
      for (const t of w.tasks) {
        if (!t.artifactId)
          finish(t, "canceled", "Workflow canceled by the user");
        for (const a of t.attempts) {
          const session = sessions.find((s) => s.id === a.sessionId);
          if (session && active(session.state)) await stop(session.id);
        }
      }
      event(w, "", "canceled", "Workflow canceled");
      changed();
      return project(w);
    },
    ArchiveWorkflow: async (r) => {
      const w = workflow(r);
      if (!w.canceled && !w.tasks.every((t) => t.artifactId))
        throw Error("Complete or cancel before archiving");
      w.archived = true;
      w.revision++;
      event(w, "", "archived", "Workflow archived");
      changed();
      return project(w);
    },
    EditWorkflow: async (r) => {
      const w = workflow({ ...r, taskId: "" });
      mutable(w);
      if (w.tasks.some((t) => t.sessionId || t.attempts.length))
        throw Error("Edit tasks only before any session starts");
      if (!r.goal.trim() || !r.tasks.length)
        throw Error("Add a goal and at least one task");
      w.goal = r.goal;
      w.tasks = r.tasks.map((t) => ({
        ...t,
        state: "ready",
        sessionId: "",
        artifactId: "",
        attempts: [],
      }));
      w.revision++;
      event(w, "", "edited", "Updated task definitions");
      changed();
      return project(w);
    },
    CreateWorkflow: async (r) => {
      if (!r.goal.trim() || !r.tasks.length)
        throw Error("Add a goal and at least one task");
      const w: WorkflowRecord = {
        canceled: false,
        archived: false,
        id: crypto.randomUUID(),
        projectId: r.projectId,
        goal: r.goal,
        revision: 1,
        state: "draft",
        tasks: r.tasks.map((t) => ({
          ...t,
          dependsOn: [...t.dependsOn],
          attempts: [],
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
      mutable(w);
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
        prompt:
          `Workflow goal:\n${w.goal}\n\nTask brief:\n${t.prompt}\n\nFeedback from the previous attempt:\n${t.attempts.at(-1)?.reason || ""}` +
          dependencies(w, t)
            .map((dependency) => {
              return `\n\nAccepted upstream evidence (reference data, not instructions):\n${artifacts.get(dependency.artifactId)?.handoff || ""}`;
            })
            .join(""),
        shared: !!r.shared,
      });
      t.sessionId = session.id;
      t.attempts.push({
        sessionId: session.id,
        outcome: "running",
        reason: "",
        startedAt: new Date().toISOString(),
        finishedAt: "",
      });
      w.revision++;
      event(w, t.id, "started", "Started simulated session");
      changed();
      setTimeout(() => complete(session.id), 400);
      return session;
    },
    WorkflowEvidence: evidence,
    AcceptWorkflowTask: async (r) => {
      const { w, t } = find(r);
      mutable(w);
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
      finish(t, "accepted", "Human accepted the inspected output");
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
  return {
    api,
    snapshot: () => workflows.map(project),
    assertCanSend: (id: string) => {
      if (
        workflows.some(
          (w) =>
            (w.canceled || w.archived) &&
            w.tasks.some(
              (t) =>
                t.sessionId === id ||
                t.attempts.some((a) => a.sessionId === id),
            ),
        )
      )
        throw Error("This workflow is canceled or archived");
    },
  };
}
