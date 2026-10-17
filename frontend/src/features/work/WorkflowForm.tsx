import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import type { Snapshot, CreateWorkflowRequest } from "../../types";

export function WorkflowForm({
  data,
  pending,
  cancel,
  save,
  initial,
}: {
  initial?: CreateWorkflowRequest;
  data: Snapshot;
  pending: boolean;
  cancel: () => void;
  save: (r: CreateWorkflowRequest) => Promise<void>;
}) {
  const [projectId, setProject] = useState(
      initial?.projectId || data.projects[0]?.id || "",
    ),
    [goal, setGoal] = useState(initial?.goal || "");
  type DraftTask = CreateWorkflowRequest["tasks"][number];
  const makeTask = (): DraftTask => ({
    id: crypto.randomUUID(),
    title: "",
    prompt: "",
    provider:
      data.providers.find((p) => p.available)?.id ||
      data.providers[0]?.id ||
      "",
    dependsOn: [],
  });
  const [tasks, setTasks] = useState<DraftTask[]>(
    () => initial?.tasks || [makeTask()],
  );
  const edit = (id: string, patch: Partial<DraftTask>) =>
    setTasks(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  return (
    <form
      className="work-surface workflow-form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        await save({ projectId, goal, tasks });
      }}
    >
      <h2>Give the team a shared goal.</h2>
      <label>
        Project
        <select
          disabled={!!initial}
          value={projectId}
          onChange={(e) => setProject(e.target.value)}
        >
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Workflow goal
        <input
          required
          maxLength={500}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What should this team accomplish?"
        />
      </label>
      {tasks.map((task, i) => (
        <fieldset key={task.id}>
          <legend>Task {i + 1}</legend>
          <button
            type="button"
            className="text-button"
            disabled={tasks.length === 1}
            onClick={() =>
              setTasks(
                tasks
                  .filter((t) => t.id !== task.id)
                  .map((t) => ({
                    ...t,
                    dependsOn: t.dependsOn.filter((id) => id !== task.id),
                  })),
              )
            }
          >
            Remove task {i + 1}
          </button>
          <label>
            Task name
            <input
              aria-label={`Task ${i + 1} name`}
              required
              maxLength={120}
              value={task.title}
              onChange={(e) => edit(task.id, { title: e.target.value })}
            />
          </label>
          <label>
            Brief and acceptance criteria
            <textarea
              aria-label={`Task ${i + 1} brief`}
              required
              maxLength={64000}
              rows={3}
              value={task.prompt}
              onChange={(e) => edit(task.id, { prompt: e.target.value })}
            />
          </label>
          <label>
            Provider
            <select
              value={task.provider}
              onChange={(e) => edit(task.id, { provider: e.target.value })}
            >
              {data.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.available ? "" : " · setup needed"}
                </option>
              ))}
            </select>
          </label>
          {i > 0 && (
            <div>
              <p className="help">Wait for human acceptance of:</p>
              {tasks.slice(0, i).map((dep) => (
                <label className="checkbox-line" key={dep.id}>
                  <input
                    type="checkbox"
                    checked={task.dependsOn.includes(dep.id)}
                    onChange={(e) =>
                      edit(task.id, {
                        dependsOn: e.target.checked
                          ? [...task.dependsOn, dep.id]
                          : task.dependsOn.filter((id) => id !== dep.id),
                      })
                    }
                  />
                  {dep.title || "Untitled task"}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ))}
      <div className="workflow-actions">
        <button
          type="button"
          className="secondary"
          disabled={tasks.length >= 30}
          onClick={() => setTasks([...tasks, makeTask()])}
        >
          <Plus size={15} />
          Add task
        </button>
        <button type="button" className="text-button" onClick={cancel}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={pending || !projectId || !data.providers.length}
        >
          {pending ? "Saving…" : "Save workflow"}
        </button>
      </div>
    </form>
  );
}
