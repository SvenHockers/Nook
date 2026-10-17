import { describe, expect, it } from "vitest";
import { createDemo } from "../../demo";
import { workflowAttention } from "./attention";

describe("workflow recovery and attention", () => {
  it("keeps failed attempts, retries explicitly, and retires canceled workflows", async () => {
    const api = createDemo(() => {});
    const snapshot = await api.Snapshot();
    let w = await api.CreateWorkflow({
      projectId: snapshot.projects[0].id,
      goal: "Recover safely",
      tasks: [
        {
          id: "a",
          title: "Build",
          prompt: "Implement the feature",
          provider: "codex",
          dependsOn: [],
        },
      ],
    });
    const request = () => ({
      workflowId: w.id,
      taskId: "a",
      revision: w.revision,
    });
    const first = await api.StartWorkflowTask(request());
    await api.Stop(first.id);
    w = (await api.Snapshot()).workflows[0];
    expect(w.state).toBe("failed");
    expect(workflowAttention(await api.Snapshot())[0].reason).toBe(
      "Attempt needs recovery",
    );
    w = await api.RejectWorkflowTask({
      ...request(),
      reason: "Address edge cases",
    });
    expect(w.tasks[0].attempts[0].outcome).toBe("rejected");
    expect(workflowAttention(await api.Snapshot())).toEqual([]);
    const second = await api.StartWorkflowTask(request());
    expect(second.id).not.toBe(first.id);
    expect((await api.Events(second.id, 0))[0].text).toContain(
      "Address edge cases",
    );
    w = (await api.Snapshot()).workflows[0];
    w = await api.CancelWorkflow(request());
    expect(w.state).toBe("canceled");
    await expect(api.Send(second.id, "resume canceled work")).rejects.toThrow(
      "canceled",
    );
    expect(
      (await api.Snapshot()).sessions.find((s) => s.id === second.id)?.state,
    ).toBe("stopped");
    await expect(api.StartWorkflowTask(request())).rejects.toThrow();
    w = await api.ArchiveWorkflow(request());
    expect(w.archived).toBe(true);
    expect(w.tasks[0].attempts).toHaveLength(2);
  });

  it("surfaces completed workflow tasks even when their session is archived", async () => {
    const api = createDemo(() => {});
    const data = await api.Snapshot();
    const completed = data.sessions.find((s) => s.state === "completed")!;
    completed.archived = true;
    data.workflows.push({
      id: "w",
      projectId: completed.projectId,
      goal: "Review",
      revision: 1,
      state: "waiting_for_input",
      canceled: false,
      archived: false,
      createdAt: "",
      updatedAt: "",
      history: [],
      tasks: [
        {
          id: "t",
          title: "Review output",
          prompt: "",
          provider: completed.provider,
          dependsOn: [],
          sessionId: completed.id,
          artifactId: "",
          attempts: [],
          state: "waiting_for_input",
        },
      ],
    });
    expect(workflowAttention(data)).toHaveLength(1);
    data.workflows[0].tasks[0].artifactId = "accepted";
    expect(workflowAttention(data)).toHaveLength(0);
  });
});
