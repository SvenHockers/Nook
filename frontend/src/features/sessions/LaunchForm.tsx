import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Plus } from "lucide-react";
import type { API, Snapshot } from "../../types";

export function LaunchForm({
  data,
  project,
  pending,
  submit,
  add,
}: {
  data: Snapshot;
  project: string;
  pending: boolean;
  submit: (r: Parameters<API["Launch"]>[0]) => Promise<void>;
  add: () => Promise<unknown>;
}) {
  const [pid, setPid] = useState(
      project === "all" ? data.projects[0]?.id || "" : project,
    ),
    [provider, setProvider] = useState(
      data.providers.find((p) => p.available)?.id || "codex",
    ),
    [shared, setShared] = useState(false);
  const p = data.projects.find((p) => p.id === pid);
  useEffect(() => {
    if (!pid && data.projects[0]) setPid(data.projects[0].id);
  }, [data.projects, pid]);
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit({
          projectId: pid,
          provider,
          title: String(f.get("title") || ""),
          prompt: String(f.get("prompt") || ""),
          shared,
        });
      }}
    >
      <p className="modal-subtitle">
        Pick a collaborator. Point them toward something worth doing.
      </p>
      <label>
        Project
        <select value={pid} onChange={(e) => setPid(e.target.value)} required>
          <option value="" disabled>
            Choose a project
          </option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {!data.projects.length && (
        <button type="button" className="secondary" onClick={add}>
          <Plus size={15} />
          Open a project
        </button>
      )}
      <label>Agent</label>
      <div className="agent-picker">
        {data.providers.map((p) => (
          <button
            type="button"
            key={p.id}
            className={provider === p.id ? "chosen" : ""}
            disabled={!p.available}
            onClick={() => setProvider(p.id)}
          >
            <span className={"provider-glyph " + p.id}>
              {p.id === "claude" ? "✳" : "◈"}
            </span>
            <strong>{p.name}</strong>
            <small>
              {p.available
                ? "Your installed agent"
                : "Setup needed in Settings"}
            </small>
            {provider === p.id && <Check size={16} />}
          </button>
        ))}
      </div>
      <label>
        What are we working on?
        <textarea
          name="prompt"
          rows={4}
          placeholder="Describe an idea, ask a question, or hand over a task…"
          required
          maxLength={100000}
        />
      </label>
      <label>
        A name for this task <span className="optional">optional</span>
        <input
          name="title"
          placeholder="A short name to find it later"
          maxLength={120}
        />
      </label>
      {p?.git ? (
        <div className="worktree-choice">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={!shared}
              onChange={(e) => setShared(!e.target.checked)}
            />
            Give this agent a separate worktree
          </label>
          <p>
            {shared
              ? "Agents in the shared folder can edit the same files at the same time."
              : "Starts from the current committed HEAD. Uncommitted edits are not copied. Your original folder stays separate."}
          </p>
        </div>
      ) : (
        <p className="help">
          This agent will use the project folder. Concurrent agents can edit the
          same files.
        </p>
      )}
      <p className="help">
        Opening an agent trusts this project’s provider configuration, hooks,
        and instructions. Review unfamiliar projects first.
      </p>
      <button
        className="primary full"
        disabled={
          pending ||
          !pid ||
          !data.providers.some((p) => p.id === provider && p.available)
        }
      >
        {pending ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Plus size={17} />
        )}
        Let’s get started
      </button>
    </form>
  );
}
