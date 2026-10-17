import { useState } from "react";
import { Plus, ArrowRight, GitBranch, Check } from "lucide-react";
import { api, demo } from "../../api";
import { Avatar } from "../../Avatar";
import type { Snapshot, WorkflowAction, WorkflowArtifact } from "../../types";
import { EvidenceCanvas } from "../canvas/PresentationCanvas";
import { sessionEvidence, type Source } from "../canvas/model";
import { WorkflowForm } from "./WorkflowForm";
import { active } from "../../types";
import { WorkflowWorkspace } from "./Workspaces";

export function LiveWorkflows({
  data,
  refresh,
  openSession,
  initial,
}: {
  initial?: { workflowId: string; taskId: string };
  data: Snapshot;
  refresh: () => Promise<void>;
  openSession: (id: string) => void;
}) {
  const [selected, setSelected] = useState(initial?.workflowId || ""),
    [taskID, setTaskID] = useState(initial?.taskId || ""),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [reason, setReason] = useState(""),
    [examples, setExamples] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState<WorkflowArtifact>(),
    [confirm, setConfirm] = useState(false),
    [shared, setShared] = useState(false);
  const [tab, setTab] = useState("Team");
  const workflows = (data.workflows || []).filter(
      (w) => w.archived === showArchived,
    ),
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
    setReason("");
    setEditing(false);
    setEvidence(undefined);
    setConfirm(false);
    setShared(false);
  };
  const validEvidence =
    evidence &&
    evidence.workflowId === w?.id &&
    evidence.taskId === task?.id &&
    evidence.sessionId === task?.sessionId
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
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => {
            setShowArchived(e.target.checked);
            setSelected("");
            choose("");
          }}
        />
        Show archived workflows
      </label>
      {editing && w && (
        <WorkflowForm
          key={w.id}
          data={data}
          initial={{ projectId: w.projectId, goal: w.goal, tasks: w.tasks }}
          pending={pending}
          cancel={() => setEditing(false)}
          save={async (request) => {
            const saved = await run(() =>
              api.EditWorkflow({
                workflowId: w.id,
                revision: w.revision,
                goal: request.goal,
                tasks: request.tasks,
              }),
            );
            if (saved) {
              choose(saved.tasks[0].id);
              setEditing(false);
            }
          }}
        />
      )}
      {creating && (
        <WorkflowForm
          data={data}
          pending={pending}
          cancel={() => setCreating(false)}
          save={async (request) => {
            const created = await run(() => api.CreateWorkflow(request));
            if (created) {
              setShowArchived(false);
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
            <div className="workflow-actions">
              {!w.archived &&
                !w.canceled &&
                !w.tasks.some((t) => t.sessionId || t.attempts.length) && (
                  <button
                    className="secondary"
                    disabled={pending}
                    onClick={() => setEditing(true)}
                  >
                    Edit workflow
                  </button>
                )}
              {!w.archived && w.state !== "completed" && (
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={async () => {
                    await run(() =>
                      api.CancelWorkflow({
                        workflowId: w.id,
                        taskId: "",
                        revision: w.revision,
                      }),
                    );
                    setConfirm(false);
                  }}
                >
                  Cancel workflow
                </button>
              )}
              {!w.archived && (w.canceled || w.state === "completed") && (
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={async () => {
                    const archived = await run(() =>
                      api.ArchiveWorkflow({
                        workflowId: w.id,
                        taskId: "",
                        revision: w.revision,
                      }),
                    );
                    if (archived) {
                      setSelected("");
                      choose("");
                    }
                  }}
                >
                  Archive workflow
                </button>
              )}
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
              {!task.sessionId && !w.canceled && !w.archived && (
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
                    {pending
                      ? "Starting…"
                      : task.attempts.length
                        ? "Retry task"
                        : "Start task"}
                    <ArrowRight size={16} />
                  </button>
                  {task.state === "blocked" && (
                    <p>Accept the dependencies before starting this task.</p>
                  )}
                </>
              )}
              {task.sessionId && (
                <div className="workflow-actions">
                  {!w.canceled &&
                    !w.archived &&
                    session &&
                    active(session.state) && (
                      <button
                        className="secondary"
                        disabled={pending}
                        onClick={() => run(() => api.Stop(task.sessionId))}
                      >
                        Stop attempt
                      </button>
                    )}
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
              {!!task.attempts.length && (
                <details>
                  <summary>Attempts ({task.attempts.length})</summary>
                  <ol className="work-timeline">
                    {task.attempts.map((a, i) => (
                      <li key={a.sessionId}>
                        <strong>
                          Attempt {i + 1} · {a.outcome}
                        </strong>
                        <span>{a.reason}</span>
                        <button
                          className="text-button"
                          onClick={() => openSession(a.sessionId)}
                        >
                          Open attempt {i + 1}
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {!w.canceled &&
                !w.archived &&
                !task.artifactId &&
                session &&
                !active(session.state) && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const rejected = await run(() =>
                        api.RejectWorkflowTask({
                          ...action(),
                          reason,
                          sourceRevision: validEvidence?.revision,
                        }),
                      );
                      if (rejected) {
                        setEvidence(undefined);
                        setConfirm(false);
                        setReason("");
                      }
                    }}
                  >
                    <label>
                      Feedback for the next attempt
                      <textarea
                        required
                        maxLength={4096}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    <button
                      className="secondary"
                      disabled={pending || !reason.trim()}
                    >
                      Reject and prepare retry
                    </button>
                    <p className="help">
                      Keeps this attempt and its evidence. Retry starts a new
                      session only when you choose.
                    </p>
                  </form>
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
              <p className="help">
                Downstream handoff:{" "}
                {validEvidence.handoffBytes.toLocaleString()} bytes ·{" "}
                {validEvidence.omittedRecords} older records omitted. Each
                dependency may be shortened further to fit the shared prompt
                budget.
              </p>
              <details>
                <summary>Downstream reference text</summary>
                <pre className="evidence-text">
                  {validEvidence.handoff ||
                    "No conversation or outcome records"}
                </pre>
              </details>
              {validEvidence.changes && (
                <details open>
                  <summary>
                    Code snapshot · HEAD {validEvidence.headCommit.slice(0, 12)}
                  </summary>
                  <p className="help">
                    Tracked changes relative to the session's starting commit.
                    Untracked files are listed but their contents are not
                    captured.{" "}
                    {validEvidence.changes.truncated
                      ? "Diff preview is truncated."
                      : ""}
                  </p>
                  <pre className="file-status">
                    {validEvidence.diffStat || "No tracked changes"}
                  </pre>
                  <pre className="file-status">
                    {validEvidence.changes.status}
                  </pre>
                  <pre className="diff">{validEvidence.changes.diff}</pre>
                </details>
              )}
              <WorkflowEvidenceView evidence={validEvidence} />
              {!task.artifactId && !w.canceled && !w.archived && (
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
                              sourceCodeRevision: validEvidence.codeRevision,
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
