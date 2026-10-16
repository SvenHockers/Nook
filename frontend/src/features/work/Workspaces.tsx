import { useState, type ReactNode } from "react";
import { AgentAvatar } from "../avatars/AgentAvatar";
import { characters } from "../avatars/model";
import { EvidenceCanvas } from "../canvas/PresentationCanvas";
import {
  sampleDefinition,
  sampleEvidence,
  sampleRun,
  sampleSource,
  sampleWorkflow,
} from "./fixtures";
import type { LoopPhase, Workflow, LoopDefinition, LoopRun } from "./model";
import type { Snapshot } from "../../types";
export type WorkspacePage =
  | "Home"
  | "Agents"
  | "Workflows"
  | "Loops"
  | "Context"
  | "Activity"
  | "Playground";
function SampleGate({
  kind,
  children,
}: {
  kind: string;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="work-page">
      <div className="eyebrow">WORKSPACE / {kind.toUpperCase()}</div>
      <h1>
        {kind === "Workflows"
          ? "Good work, together."
          : "One thoughtful step at a time."}
      </h1>
      <p className="help">
        {kind === "Workflows"
          ? "Follow the team, the dependencies, and what changes hands."
          : "Discover → Execute → Verify → Decide. Every attempt keeps its evidence."}
      </p>
      <div className="sample-notice">
        <div>
          <strong>
            {show
              ? "Simulated example · no live execution"
              : `${kind} runtime is not connected`}
          </strong>
          <p>
            {show
              ? "These records illustrate the interface. They do not start agents, run checks, or grant approval."
              : "Your real agent sessions remain available in Agents. Explore a labeled example of this workspace."}
          </p>
        </div>
        <button className="secondary" onClick={() => setShow(!show)}>
          {show ? "Close example" : "Explore example"}
        </button>
      </div>
      {show && children}
    </div>
  );
}
function SampleReport({ ids }: { ids: string[] }) {
  const records = sampleEvidence.filter((e) => ids.includes(e.id));
  return (
    <EvidenceCanvas
      key={ids.join(",")}
      source={sampleSource}
      evidence={records}
      raw={JSON.stringify(records, null, 2)}
      chat={records
        .map((e) =>
          e.data.kind === "text"
            ? e.data.text
            : `Sample ${e.data.kind}: ${e.id}`,
        )
        .join("\n")}
    />
  );
}
export function WorkflowWorkspace() {
  return (
    <SampleGate kind="Workflows">
      <WorkflowTeamView
        workflow={sampleWorkflow}
        renderEvidence={(ids) => <SampleReport ids={ids} />}
      />
    </SampleGate>
  );
}
export function WorkflowTeamView({
  workflow: w,
  renderEvidence,
}: {
  workflow: Workflow;
  renderEvidence: (ids: string[]) => ReactNode;
}) {
  const [tab, setTab] = useState("Team"),
    [taskId, setTaskId] = useState(w.tasks[0]?.id || ""),
    [artifact, setArtifact] = useState<string>();
  const task = w.tasks.find((t) => t.id === taskId) || w.tasks[0];
  return (
    <section className="work-surface">
      <div className="work-title">
        <div>
          <small>WORKFLOW · {w.state.toUpperCase()}</small>
          <h2>{w.goal}</h2>
        </div>
        <span className="soft-badge">
          {w.tasks.filter((t) => t.state === "running").length} tasks running ·{" "}
          {w.tasks.filter((t) => t.state === "blocked").length} blocked
        </span>
      </div>
      <div className="segmented" role="group" aria-label="Workflow views">
        {["Team", "Dependencies", "Timeline", "Artifacts"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Team" && (
        <div className="team-grid">
          {w.tasks.map((t) => (
            <button
              className={`team-card ${taskId === t.id ? "chosen" : ""}`}
              key={t.id}
              onClick={() => setTaskId(t.id)}
            >
              <AgentAvatar
                identity={characters[t.owner]}
                state={t.agentState}
                size={96}
              />
              <strong>{characters[t.owner].name}</strong>
              <span>{t.title}</span>
              <small>Task {t.state}</small>
            </button>
          ))}
        </div>
      )}
      {tab === "Dependencies" && (
        <div className="dependency-map">
          {w.tasks.map((t) => (
            <button
              className="dependency-task"
              key={t.id}
              onClick={() => setTaskId(t.id)}
            >
              <strong>{t.title}</strong>
              <span>
                {t.dependsOn.length
                  ? `Depends on: ${t.dependsOn.map((id) => w.tasks.find((a) => a.id === id)?.title || id).join(" + ")}`
                  : "Independent task · may run in parallel"}
              </span>
              <small>{t.state}</small>
            </button>
          ))}
        </div>
      )}
      {tab === "Timeline" && (
        <ol className="work-timeline">
          {w.history.map((h) => (
            <li key={h.time}>
              <time>{h.time}</time>
              {h.text}
            </li>
          ))}
        </ol>
      )}
      {tab === "Artifacts" &&
        w.handoffs.map((h) => (
          <button
            className="handoff-row"
            key={h.artifactId}
            onClick={() => setArtifact(h.artifactId)}
          >
            <strong>
              {h.artifactId}@{h.revision}
            </strong>
            <span>
              {h.from} → {h.to} · {h.time}
            </span>
            <span>Inspect handoff →</span>
          </button>
        ))}
      {task && ["Team", "Dependencies"].includes(tab) && (
        <div className="task-inspector">
          <h3>{task.title}</h3>
          <p>{task.acceptance}</p>
          <p className="help">
            Context: {task.context.join(", ")} · Task state: {task.state}
          </p>
          {task.artifactIds.map((id) => (
            <button
              className="text-button"
              key={id}
              onClick={() => setArtifact(id)}
            >
              Inspect {id} →
            </button>
          ))}
        </div>
      )}
      <div className="permission-note">
        <strong>Human checkpoint</strong>
        <p>{w.checkpoint}</p>
      </div>
      {artifact && (
        <>
          <button
            className="text-button"
            onClick={() => setArtifact(undefined)}
          >
            Close evidence
          </button>
          {renderEvidence([artifact])}
        </>
      )}
    </section>
  );
}
export function LoopWorkspace() {
  return (
    <SampleGate kind="Loops">
      <LoopRunView
        recipe={sampleDefinition}
        run={sampleRun}
        renderEvidence={(ids) => <SampleReport ids={ids} />}
      />
    </SampleGate>
  );
}
export function LoopRunView({
  recipe,
  run,
  renderEvidence,
}: {
  recipe: LoopDefinition;
  run: LoopRun;
  renderEvidence: (ids: string[]) => ReactNode;
}) {
  const [attemptIndex, setAttempt] = useState(
      Math.max(0, run.attempts.length - 1),
    ),
    [phase, setPhase] = useState<LoopPhase>(
      run.attempts.at(-1)?.phase || "discover",
    ),
    [inspect, setInspect] = useState(false);
  const attempt = run.attempts[attemptIndex] || run.attempts.at(-1);
  if (!attempt)
    return (
      <section className="work-surface">
        <h2>{recipe.objective}</h2>
        <p>No attempts recorded for {run.label}.</p>
      </section>
    );
  return (
    <section className="work-surface">
      <div className="work-title">
        <div>
          <small>
            LOOP DEFINITION · {recipe.trigger.toUpperCase()} TRIGGER
          </small>
          <h2>{recipe.objective}</h2>
        </div>
        <span className="soft-badge">
          Maximum {recipe.maxAttempts} attempts
        </span>
      </div>
      <p className="help">
        {recipe.approval}. Checks: {recipe.verification.join(", ")}.
      </p>
      <div className="loop-run-title">
        <AgentAvatar
          identity={characters[run.owner]}
          state={run.agentState}
          size={64}
        />
        <div>
          <h3>
            {run.label} · {run.state}
          </h3>
          <p>{run.activity}</p>
        </div>
      </div>
      <h3>
        Attempt {attempt.number} / {recipe.maxAttempts} · {attempt.outcome}
      </h3>
      <div className="phase-strip" role="group" aria-label="Loop phases">
        {(["discover", "execute", "verify", "decide"] as const).map((p) => (
          <button
            aria-pressed={phase === p}
            key={p}
            onClick={() => setPhase(p)}
          >
            <span>{p}</span>
            <small>{attempt.phase === p ? "Recorded phase" : "Inspect"}</small>
          </button>
        ))}
      </div>
      <div className="task-inspector">
        <h3>{phase[0].toUpperCase() + phase.slice(1)}</h3>
        <p>
          {phase === "verify"
            ? attempt.note
            : phase === "discover"
              ? recipe.objective
              : phase === "execute"
                ? "A bounded attempt uses the assigned project context. No command is executed by this example."
                : attempt.outcome === "failed"
                  ? "Retry allowed while the attempt budget remains. Human review is still required before applying changes."
                  : "Await verification results before deciding whether to accept, retry, or request help."}
        </p>
        <small>Sample record · {attempt.timestamp}</small>
      </div>
      <ul className="check-list">
        {attempt.checks.map((c) => (
          <li key={c.name}>
            <span>{c.name}</span>
            <strong>{c.result}</strong>
            <button className="text-button" onClick={() => setInspect(true)}>
              Evidence
            </button>
          </li>
        ))}
      </ul>
      <h3>Attempt history</h3>
      <div className="attempt-list">
        {run.attempts.map((a, i) => (
          <button
            key={a.number}
            aria-pressed={i === attemptIndex}
            onClick={() => {
              setAttempt(i);
              setPhase(a.phase);
              setInspect(false);
            }}
          >
            #{a.number} · {a.outcome} · {a.timestamp}
          </button>
        ))}
      </div>
      {inspect &&
        renderEvidence([...new Set(attempt.checks.map((c) => c.evidenceId))])}
    </section>
  );
}
export function ContextWorkspace({
  data,
  openSession,
  openProject,
}: {
  data: Snapshot;
  openSession: (id: string) => void;
  openProject: (id: string) => void;
}) {
  return (
    <div className="work-page">
      <div className="eyebrow">WORKSPACE / CONTEXT</div>
      <h1>The right context, in reach.</h1>
      <p className="help">
        Project knowledge and session assignments. Assignments supply
        information; they do not enforce filesystem restrictions.
      </p>
      {!data.projects.length && (
        <p className="empty-copy">Open a project to manage its knowledge.</p>
      )}
      {data.projects.map((p) => (
        <section className="work-surface" key={p.id}>
          <div className="work-title">
            <h2>{p.name}</h2>
            <button className="secondary" onClick={() => openProject(p.id)}>
              Edit project context
            </button>
          </div>
          <p className="path help">{p.path}</p>
          <div className="resource-list">
            {p.context.length ? (
              p.context.map((c) => (
                <div key={c.id}>
                  <strong>{c.name}</strong>
                  <span>
                    {c.kind} ·{" "}
                    {c.enabled ? "Included in new sessions" : "Not included"}
                  </span>
                </div>
              ))
            ) : (
              <p className="help">No project defaults assigned.</p>
            )}
          </div>
          {data.sessions
            .filter((s) => s.projectId === p.id && !s.archived)
            .map((s) => (
              <button
                className="context-session"
                key={s.id}
                onClick={() => openSession(s.id)}
              >
                <strong>{s.title}</strong>
                <span>
                  {s.context.filter((c) => c.enabled).length} assigned resources
                </span>
                <small>
                  {s.capabilities.sandbox ||
                    "No enforcement information reported"}
                </small>
                <span>Inspect context →</span>
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}
export function ActivityWorkspace({
  data,
  openSession,
}: {
  data: Snapshot;
  openSession: (id: string) => void;
}) {
  const [onlyAttention, setOnlyAttention] = useState(false);
  const sessions = data.sessions
    .filter(
      (s) =>
        !onlyAttention ||
        ["waiting", "failed", "disconnected"].includes(s.state),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="work-page">
      <div className="eyebrow">WORKSPACE / ACTIVITY</div>
      <h1>A little perspective.</h1>
      <p className="help">
        Latest recorded session activity. Open a session for its complete event
        history.
      </p>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={onlyAttention}
          onChange={(e) => setOnlyAttention(e.target.checked)}
        />
        Needs attention only
      </label>
      <section className="work-surface">
        {sessions.length ? (
          sessions.map((s) => (
            <button
              className="activity-row"
              key={s.id}
              onClick={() => openSession(s.id)}
            >
              <time>{new Date(s.updatedAt).toLocaleString()}</time>
              <div>
                <strong>{s.title}</strong>
                <p>{s.activity}</p>
              </div>
              <span>{s.state}</span>
            </button>
          ))
        ) : (
          <p>No recorded activity in this view.</p>
        )}
      </section>
    </div>
  );
}
