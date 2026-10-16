// Browser-only presentation simulator. It never calls a model: every arranged result is a
// "sample" that says so, and it follows the same rules as the backend's PresentSession.
import type { API, Session, SessionEvent } from "../../types";
import {
  buildEvidence,
  compose,
  type ComponentType,
  type Evidence,
  type Source,
} from "./model";
const MAX_FOCUS = 200;
const textOf = (e: Evidence) => (e.data.kind === "text" ? e.data.text : "");
const kindOf = (e: Evidence): ComponentType => {
  const text = textOf(e);
  if (/^diff --git|^@@ /m.test(text)) return "CodeDiff";
  return /error|fail|warn|risk/i.test(text) ? "Finding" : "Summary";
};
export function createPresentationDemo(
  sessions: Session[],
  events: SessionEvent[],
) {
  const running = new Map<string, () => void>();
  const PresentSession: API["PresentSession"] = async (r) => {
    const focus = r.focus.trim();
    if (focus.length > MAX_FOCUS)
      throw Error(`Keep the focus under ${MAX_FOCUS} characters`);
    const session = sessions.find((s) => s.id === r.sessionId);
    if (!session) throw Error("Session not found");
    const seen = events.filter(
      (e) => e.sessionId === session.id && e.sequence <= r.revision,
    );
    if (r.revision > 0 && seen.at(-1)?.sequence !== r.revision)
      throw Error("Unknown revision; refresh the view");
    const source: Source = {
      projectId: session.projectId,
      id: session.id,
      revision: String(r.revision),
      permissionScope: `local:${session.projectId}:${session.id}`,
    };
    const { items, total } = buildEvidence(seen, source);
    const standard = {
      source,
      evidence: items,
      total,
      presentation: compose(source, items),
      mode: "standard" as const,
      provider: "",
      focus,
      reason: "",
      cached: false,
    };
    if (!r.arrange) return structuredClone(standard);
    if (session.provider !== "claude")
      return {
        ...structuredClone(standard),
        reason: "Arranging is available for Claude Code sessions.",
      };
    if (running.has(session.id)) throw Error("Already arranging this view");
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(done, 700);
        running.set(session.id, () => {
          clearTimeout(timer);
          fail(Error("Arranging was cancelled"));
        });
      });
    } finally {
      running.delete(session.id);
    }
    const words = focus.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = words.length
      ? items.filter((e) =>
          words.some((w) => textOf(e).toLowerCase().includes(w)),
        )
      : items;
    return structuredClone({
      ...standard,
      presentation: {
        ...standard.presentation,
        templateVersion: "agent-1" as const,
        blocks: shown.map((e) => ({
          id: e.id,
          evidenceId: e.id,
          type: kindOf(e),
        })),
      },
      mode: "sample" as const,
      provider: "Demo",
    });
  };
  const CancelPresentation: API["CancelPresentation"] = async (id) => {
    running.get(id)?.();
  };
  return { PresentSession, CancelPresentation };
}
