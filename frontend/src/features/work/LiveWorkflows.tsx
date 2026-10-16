import { useState, type FormEvent } from "react";
import { Plus, ArrowRight, GitBranch, Check } from "lucide-react";
import { api, demo } from "../../api";
import { Avatar } from "../../Avatar";
import type {
  CreateWorkflowRequest,
  Snapshot,
  WorkflowAction,
  WorkflowArtifact,
  WorkflowRecord,
  WorkflowTaskRecord,
} from "../../types";
import { EvidenceCanvas } from "../canvas/PresentationCanvas";
import { sessionEvidence, type Source } from "../canvas/model";
import { WorkflowWorkspace } from "./Workspaces";

export function LiveWorkflows({
  data,
  refresh,
  openSession,
}: {
  data: Snapshot;
  refresh: () => Promise<void>;
  openSession: (id: string) => void;
}) {
  const [selected, setSelected] = useState(""),
    [taskID, setTaskID] = useState(""),
    [creating, setCreating] = useState(false),
    [examples, setExamples] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState<WorkflowArtifact>(),
    [confirm, setConfirm] = useState(false),
    [shared, setShared] = useState(false);
  const [tab, setTab] = useState("Team");
  const workflows = data.workflows || [],
    w = workflows.find((w) => w.id === selected) || workflows[0];
  const task = w?.tasks.find((t) => t.id === taskID) || w?.tasks[0];
  const session = data.sessions.find((s) => s.id === task?.sessionId),
    project = data.projects.find((p) => p.id === w?.projectId);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setError(String(e));
      await refresh();
    } finally {
      setPending(false);
    }
  }
  const action = (): WorkflowAction => ({
    workflowId: w!.id,
    taskId: task!.id,
    revision: w!.revision,
  });
  const choose = (id: string) => {
    setTaskID(id);
    setEvidence(undefined);
    setConfirm(false);
    setShared(false);
  };
  const validEvidence =
    evidence && evidence.workflowId === w?.id && evidence.taskId === task?.id
      ? evidence
      : undefined;
  return (
    <div className="work-page">
      <div className="work-title">
        <div>
          <div className="eyebrow">WORKSPACE / WORKFLOWS</div>
          <h1>Good work, together.</h1>
        </div>
        <button
          className="primary"
          disabled={!data.projects.length}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          New workflow
        </button>
      </div>
      <p className="help">
        Give each task an owner and a clear handoff. Ready tasks start when you
        choose; downstream work waits for your review.
      </p>
      {demo && (
        <div className="sample-notice">
          Demo workflows · simulated sessions and evidence · changes last for
          this browser visit.
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {creating && (
        <WorkflowForm
          data={data}
          pending={pending}
          cancel={() => setCreating(false)}
          save={async (request) => {
            const created = await run(() => api.CreateWorkflow(request));
            if (created) {
              setSelected(created.id);
              choose(created.tasks[0].id);
              setCreating(false);
            }
          }}
        />
      )}
      {!w && !creating && (
        <section className="work-surface">
          <h2>A shared goal starts here.</h2>
          <p className="help">
            {data.projects.length
              ? "Create a workflow with independent tasks, dependent reviews, and explicit acceptance criteria in each task brief."
              : "Open a project from the sidebar before creating a workflow."}
          </p>
        </section>
      )}
      {workflows.length > 0 && (
        <label>
          Workflow
          <select
            aria-label="Workflow"
            value={w?.id}
            onChange={(e) => {
              setSelected(e.target.value);
              choose("");
            }}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.goal}
              </option>
            ))}
          </select>
        </label>
      )}
      {w && task && (
        <>
          <section className="work-surface">
            <div className="work-title">
              <div>
                <small>
                  {project?.name} · {w.state.replaceAll("_", " ")} · revision{" "}
                  {w.revision}
                </small>
                <h2>{w.goal}</h2>
              </div>
              <span className="soft-badge">
                {w.tasks.filter((t) => t.artifactId).length} accepted /{" "}
                {w.tasks.length} tasks
              </span>
            </div>
            <div
              className="segmented"
              role="group"
              aria-label="Saved workflow views"
            >
              {["Team", "Dependencies", "History"].map((t) => (
                <button
                  key={t}
                  aria-pressed={tab === t}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "Team" && (
              <div className="team-grid">
                {w.tasks.map((t) => {
                  const owner = data.sessions.find((s) => s.id === t.sessionId);
                  return (
                    <button
                      key={t.id}
                      className={`team-card ${task.id === t.id ? "chosen" : ""}`}
                      onClick={() => choose(t.id)}
                    >
                      {owner ? (
                        <Avatar session={owner} />
                      ) : (
                        <div className="unassigned-avatar">
                          <GitBranch size={30} />
                        </div>
                      )}
                      <strong>{t.title}</strong>
                      <span>
                        {data.providers.find((p) => p.id === t.provider)
                          ?.name || t.provider}
                      </span>
                      <small>Task: {t.state.replaceAll("_", " ")}</small>
                      <small>
                        {owner ? `Agent: ${owner.state}` : "No session started"}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}
            {tab === "Dependencies" && (
              <div className="dependency-map">
                {w.tasks.map((t) => (
                  <button
                    className="dependency-task"
                    key={t.id}
                    onClick={() => choose(t.id)}
                  >
                    <strong>{t.title}</strong>
                    <span>
                      {t.dependsOn.length
                        ? `Waits for acceptance: ${t.dependsOn.map((id) => w.tasks.find((t) => t.id === id)?.title || id).join(" + ")}`
                        : "Independent · can run in parallel"}
                    </span>
                    <small>{t.state.replaceAll("_", " ")}</small>
                  </button>
                ))}
              </div>
            )}
            {tab === "History" && (
              <ol className="work-timeline">
                {w.history.map((h) => (
                  <li key={h.id}>
                    <time>{new Date(h.time).toLocaleString()}</time>
                    <span>{h.text}</span>
                  </li>
                ))}
              </ol>
            )}
            <div className="task-inspector">
              <h3>{task.title}</h3>
              <p className="evidence-text">{task.prompt}</p>
              <p className="help">
                {task.dependsOn.length
                  ? "Accepted dependency evidence is supplied as reference data to this task. Files are not merged between worktrees."
                  : "Project context defaults are copied into the new session."}
              </p>
              {!task.sessionId && (
                <>
                  {project?.git && (
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={shared}
                        onChange={(e) => setShared(e.target.checked)}
                      />
                      Use the shared project folder
                    </label>
                  )}
                  <p className="help">
                    {project?.git && !shared
                      ? "Starts in a separate worktree from committed HEAD. Uncommitted edits are not copied."
                      : "Uses the project folder. Concurrent agents can edit the same files."}{" "}
                    Starting trusts the project’s provider configuration and
                    instructions.
                  </p>
                  <button
                    className="primary"
                    disabled={pending || task.state !== "ready"}
                    onClick={async () => {
                      const started = await run(() =>
                        api.StartWorkflowTask({ ...action(), shared }),
                      );
                      if (started) setEvidence(undefined);
                    }}
                  >
                    {pending ? "Starting…" : "Start task"}
                    <ArrowRight size={16} />
                  </button>
                  {task.state === "blocked" && (
                    <p>Accept the dependencies before starting this task.</p>
                  )}
                </>
              )}
              {task.sessionId && (
                <div className="workflow-actions">
                  <button
                    className="secondary"
                    onClick={() => openSession(task.sessionId)}
                  >
                    Open agent session
                  </button>
                  <button
                    className="secondary"
                    disabled={pending}
                    onClick={async () => {
                      const result = await run(() =>
                        api.WorkflowEvidence(action()),
                      );
                      if (result) {
                        setEvidence(result);
                        setConfirm(false);
                      }
                    }}
                  >
                    {task.artifactId
                      ? "Inspect accepted handoff"
                      : "Inspect latest output"}
                  </button>
                </div>
              )}
              {task.artifactId && (
                <p>
                  <Check size={14} /> Human-accepted handoff saved. This does
                  not certify tests passed.
                </p>
              )}
            </div>
          </section>
          {validEvidence && (
            <section className="work-surface">
              <div className="work-title">
                <h2>
                  {validEvidence.id ? "Accepted handoff" : "Review task output"}
                </h2>
                <span className="soft-badge">
                  Source revision {validEvidence.revision}
                </span>
              </div>
              <WorkflowEvidenceView evidence={validEvidence} />
              {!task.artifactId && (
                <>
                  <p className="help">
                    Inspect the output and the session’s Changes view before
                    accepting. Acceptance saves this exact event revision and
                    unlocks dependent tasks. It does not merge files or run
                    verification.
                  </p>
                  {!confirm ? (
                    <button
                      className="primary"
                      disabled={
                        pending ||
                        session?.state !== "completed" ||
                        !validEvidence.revision
                      }
                      onClick={() => setConfirm(true)}
                    >
                      Accept reviewed output
                    </button>
                  ) : (
                    <div className="sample-notice">
                      <div>
                        <strong>
                          Accept “{task.title}” at revision{" "}
                          {validEvidence.revision}?
                        </strong>
                        <p>
                          This immutable handoff will be available to{" "}
                          {
                            w.tasks.filter((t) => t.dependsOn.includes(task.id))
                              .length
                          }{" "}
                          dependent tasks. New session output will not change
                          it.
                        </p>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => setConfirm(false)}
                      >
                        Keep reviewing
                      </button>
                      <button
                        className="primary"
                        disabled={pending}
                        onClick={async () => {
                          const accepted = await run(() =>
                            api.AcceptWorkflowTask({
                              ...action(),
                              sourceRevision: validEvidence.revision,
                            }),
                          );
                          setConfirm(false);
                          if (accepted) {
                            const saved = await run(() =>
                              api.WorkflowEvidence({
                                workflowId: accepted.id,
                                taskId: task.id,
                                revision: accepted.revision,
                              }),
                            );
                            setEvidence(saved);
                          }
                        }}
                      >
                        Accept and unlock dependent tasks
                      </button>
                    </div>
                  )}
                  {session?.state !== "completed" && (
                    <p className="help">
                      The assigned agent must finish its turn before you can
                      accept this output.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <button className="text-button" onClick={() => setExamples(!examples)}>
        {examples
          ? "Hide reference example"
          : "Explore workflow reference example"}
      </button>
      {examples && <WorkflowWorkspace />}
    </div>
  );
}
function WorkflowEvidenceView({ evidence }: { evidence: WorkflowArtifact }) {
  const source: Source = {
    projectId: evidence.projectId,
    id: evidence.sessionId,
    revision: String(evidence.revision),
    permissionScope: `local:${evidence.projectId}:${evidence.workflowId}`,
  };
  return (
    <EvidenceCanvas
      key={`${evidence.taskId}:${evidence.revision}:${evidence.id}`}
      source={source}
      evidence={sessionEvidence(evidence.events, source)}
      raw={JSON.stringify(evidence.events, null, 2)}
      chat={evidence.events
        .filter((e) => e.kind === "user" || e.kind === "delta")
        .map((e) => (e.kind === "user" ? `\nYou: ${e.text}\n` : e.text))
        .join("")}
    />
  );
}
function WorkflowForm({
  data,
  pending,
  cancel,
  save,
}: {
  data: Snapshot;
  pending: boolean;
  cancel: () => void;
  save: (r: CreateWorkflowRequest) => Promise<void>;
}) {
  const [projectId, setProject] = useState(data.projects[0]?.id || ""),
    [goal, setGoal] = useState("");
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
  const [tasks, setTasks] = useState<DraftTask[]>(() => [makeTask()]);
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
        <select value={projectId} onChange={(e) => setProject(e.target.value)}>
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
