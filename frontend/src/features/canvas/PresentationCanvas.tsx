import { useMemo, useRef, useState } from "react";
import type { SessionEvent } from "../../types";
import {
  cacheKey,
  compose,
  sessionEvidence,
  validatePresentation,
  type Evidence,
  type Source,
} from "./model";
function EvidenceView({ evidence: e }: { evidence: Evidence }) {
  const d = e.data;
  switch (d.kind) {
    case "text":
      return <p className="evidence-text">{d.text}</p>;
    case "metric":
      return (
        <p className="metric-value">
          {d.value} <small>{d.unit}</small>
        </p>
      );
    case "table":
      return (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {d.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "tests":
      return (
        <ul className="check-list">
          {d.checks.map((c, i) => (
            <li key={i}>
              <span>{c.name}</span>
              <strong>{c.result}</strong>
            </li>
          ))}
        </ul>
      );
    case "edges":
      return (
        <ul className="check-list">
          {d.edges.map((edge, i) => (
            <li key={i}>
              {edge.from} → {edge.to}
              <small>{edge.relation}</small>
            </li>
          ))}
        </ul>
      );
    case "series": {
      const max = Math.max(1, ...d.values.map((v) => Math.abs(v.value)));
      return (
        <ul className="chart-bars">
          {d.values.map((v, i) => (
            <li key={i}>
              <span>{v.label}</span>
              <meter
                min={0}
                max={max}
                value={Math.abs(v.value)}
                aria-label={`${v.label}: ${v.value} ${d.unit}`}
              />
              <strong>
                {v.value} {d.unit}
              </strong>
            </li>
          ))}
        </ul>
      );
    }
  }
}
export function EvidenceCanvas({
  source,
  evidence,
  raw,
  chat,
}: {
  source: Source;
  evidence: readonly Evidence[];
  raw: string;
  chat: string;
}) {
  const [mode, setMode] = useState("Visual");
  const [inspected, setInspected] = useState<string>();
  const [snapshot, setSnapshot] = useState(() => ({
    source,
    evidence,
    raw,
    chat,
    presentation: compose(source, evidence),
  }));
  const scroll = useRef<Record<string, number>>({});
  // A permission or source identity change must never retain the previous source.
  const differentScope =
    source.projectId !== snapshot.source.projectId ||
    source.id !== snapshot.source.id ||
    source.permissionScope !== snapshot.source.permissionScope;
  if (differentScope) {
    setSnapshot({
      source,
      evidence,
      raw,
      chat,
      presentation: compose(source, evidence),
    });
    setInspected(undefined);
    return null;
  }
  const stale = cacheKey(source) !== cacheKey(snapshot.source);
  const valid = validatePresentation(
    snapshot.presentation,
    snapshot.source,
    snapshot.evidence,
  );
  return (
    <section className="canvas" aria-label="Nook Canvas">
      <div className="canvas-toolbar">
        <strong>Nook Canvas</strong>
        <div className="segmented" role="group" aria-label="Presentation mode">
          {["Visual", "Chat", "Raw"].map((m) => (
            <button
              key={m}
              aria-pressed={m === mode}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <p className="help">
        Source revision {snapshot.source.revision} · Recorded evidence ·{" "}
        {snapshot.evidence.length} records
      </p>
      {stale && (
        <div className="sample-notice" role="status">
          New evidence is available. All views still show revision{" "}
          {snapshot.source.revision}.
          <button
            className="secondary"
            onClick={() => {
              setSnapshot({
                source,
                evidence,
                raw,
                chat,
                presentation: compose(source, evidence),
              });
              setInspected(undefined);
            }}
          >
            Refresh view
          </button>
        </div>
      )}
      <div
        className="canvas-body"
        key={mode}
        ref={(el) => {
          if (el) el.scrollTop = scroll.current[mode] || 0;
        }}
        onScroll={(e) => {
          scroll.current[mode] = e.currentTarget.scrollTop;
        }}
      >
        {mode === "Visual" &&
          (!valid ? (
            <p role="alert">
              This presentation could not be validated. Chat and Raw remain
              available.
            </p>
          ) : !snapshot.evidence.length ? (
            <p className="empty-copy">
              No visual view yet. Recorded output will appear here when
              available.
            </p>
          ) : (
            snapshot.presentation.blocks.map((block) => {
              const e = snapshot.evidence.find(
                (e) => e.id === block.evidenceId,
              )!;
              return (
                <article className="evidence-card" key={block.id}>
                  <div className="evidence-meta">
                    <span>
                      {block.type} · {e.attribution}
                    </span>
                    <time>
                      {e.timestamp
                        ? new Date(e.timestamp).toLocaleTimeString()
                        : "No timestamp"}
                    </time>
                  </div>
                  <EvidenceView evidence={e} />
                  <button
                    className="text-button"
                    onClick={() =>
                      setInspected(inspected === e.id ? undefined : e.id)
                    }
                  >
                    Inspect source <span className="sr-only">{e.id}</span>
                  </button>
                  {inspected === e.id && (
                    <pre className="source-record">
                      {JSON.stringify(e, null, 2)}
                    </pre>
                  )}
                </article>
              );
            })
          ))}
        {mode === "Chat" && (
          <pre className="canvas-chat">
            {snapshot.chat || "No conversational output for this revision."}
          </pre>
        )}
        {mode === "Raw" && (
          <pre className="source-record">
            {snapshot.raw || "No raw output for this revision."}
          </pre>
        )}
      </div>
    </section>
  );
}
export function SessionCanvas({
  projectId,
  sessionId,
  events,
}: {
  projectId: string;
  sessionId: string;
  events: readonly SessionEvent[];
}) {
  const source = useMemo<Source>(
    () => ({
      projectId,
      id: sessionId,
      revision: String(events.at(-1)?.sequence || 0),
      permissionScope: `local:${projectId}:${sessionId}`,
    }),
    [projectId, sessionId, events],
  );
  const evidence = useMemo(
    () => sessionEvidence(events, source),
    [events, source],
  );
  return (
    <EvidenceCanvas
      key={sessionId}
      source={source}
      evidence={evidence}
      raw={JSON.stringify(events, null, 2)}
      chat={events
        .filter((e) => e.kind === "user" || e.kind === "delta")
        .map((e) => (e.kind === "user" ? `\nYou: ${e.text}\n` : e.text))
        .join("")}
    />
  );
}
