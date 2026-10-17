import type { Snapshot } from "../../types";

export function workflowAttention(data: Snapshot) {
  return data.workflows
    .filter((w) => !w.archived && !w.canceled)
    .flatMap((w) =>
      w.tasks.flatMap((t) => {
        const session = data.sessions.find((s) => s.id === t.sessionId);
        if (
          t.artifactId ||
          !session ||
          (session.state !== "completed" && t.state !== "failed")
        )
          return [];
        return [
          {
            workflowId: w.id,
            taskId: t.id,
            projectId: w.projectId,
            title: t.title,
            goal: w.goal,
            reason:
              session.state === "completed"
                ? "Ready for acceptance"
                : "Attempt needs recovery",
            key: `${w.id}:${t.id}:${session.id}:${session.state}:${session.updatedAt}`,
          },
        ];
      }),
    );
}
