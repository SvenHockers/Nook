import "./verification.css";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type {
  CheckConfiguration,
  Session,
  SessionEvent,
  VerificationCommand,
} from "../../types";

const example = JSON.stringify(
  [
    {
      name: "Tests",
      argv: ["npm", "test"],
      timeoutSeconds: 120,
      outputCap: 65536,
    },
  ],
  null,
  2,
);
export function VerificationPanel({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const [config, setConfig] = useState<CheckConfiguration>();
  const [draft, setDraft] = useState(example);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<string>();
  useEffect(() => {
    let canceled = false;
    api
      .CheckConfiguration(session.projectId)
      .then((c) => {
        if (!canceled) {
          setConfig(c);
          setDraft(
            c.commands.length ? JSON.stringify(c.commands, null, 2) : example,
          );
        }
      })
      .catch((e) => {
        if (!canceled) setMessage(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [session.projectId]);
  const latest = new Map(
    events.filter((e) => e.check).map((e) => [e.check!.id, e.check!]),
  );
  const running = [...latest.values()].find((c) => !c.finishedAt);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function run(name: string, consent: boolean) {
    if (!config) return;
    await api.RunCheck({
      sessionId: session.id,
      name,
      revision: config.revision,
      confirm: consent,
    });
    setConfirm(undefined);
    setConfig(await api.CheckConfiguration(session.projectId));
  }
  return (
    <section
      className="verification-panel"
      aria-label="Evidence and verification"
    >
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await api.CaptureEvidence(session.id);
            setMessage(
              "Evidence recorded. Refresh the Canvas to view this snapshot.",
            );
          })
        }
      >
        Record evidence
      </button>
      <details>
        <summary>Verification checks</summary>
        <p>
          Run configured commands in this session’s worktree. Commands are not
          sandboxed and can change files or access your machine and network.
        </p>
        <p>
          Working folder: <code>{session.cwd}</code>
        </p>
        <details>
          <summary>Configure project checks</summary>
          <label htmlFor="check-config">
            Commands (JSON array: name, argv, timeoutSeconds, outputCap in
            bytes)
          </label>
          <textarea
            id="check-config"
            rows={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <button
            disabled={busy || !!running}
            onClick={() =>
              void act(async () => {
                const commands: unknown = JSON.parse(draft);
                if (!Array.isArray(commands))
                  throw Error("Enter a JSON array of commands.");
                const c = await api.ConfigureChecks(
                  session.projectId,
                  commands as VerificationCommand[],
                );
                setConfig(c);
                setConfirm(undefined);
                setMessage(
                  "Project checks saved. Review and confirm before first use.",
                );
              })
            }
          >
            Save checks
          </button>
        </details>
        {config?.commands.map((c) => (
          <div key={c.name}>
            <strong>{c.name}</strong>
            <pre>{JSON.stringify(c.argv)}</pre>
            <p>
              Timeout: {c.timeoutSeconds}s · Output cap: {c.outputCap} bytes
            </p>
            <button
              disabled={busy || !!running || session.archived}
              onClick={() =>
                config.approved
                  ? void act(() => run(c.name, false))
                  : setConfirm(c.name)
              }
            >
              Run {c.name}
            </button>
          </div>
        ))}
        {!config?.commands.length && (
          <p>No checks configured for this project.</p>
        )}
        {confirm && (
          <div role="group" aria-label="Confirm project commands">
            <p>
              Allow the exact commands below for this project? This permission
              resets whenever the configuration changes. Run {confirm} now.
            </p>
            <pre>{JSON.stringify(config?.commands, null, 2)}</pre>
            <button
              disabled={busy}
              onClick={() => void act(() => run(confirm, true))}
            >
              Allow commands and run
            </button>
            <button disabled={busy} onClick={() => setConfirm(undefined)}>
              Go back
            </button>
          </div>
        )}
        {running && (
          <p role="status">
            Running {running.command.name}{" "}
            <button
              disabled={busy}
              onClick={() => void act(() => api.CancelCheck(session.id))}
            >
              Cancel check
            </button>
          </p>
        )}
        {[...latest.values()]
          .filter((c) => c.finishedAt)
          .slice(-3)
          .map((c) => (
            <p key={c.id}>
              {c.command.name}: {c.outcome}
              {c.exitCode !== null ? ` (exit ${c.exitCode})` : ""} ·{" "}
              {c.durationMs}ms
            </p>
          ))}
      </details>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
