import type { SessionEvent } from "../../types";
export type EvidenceData =
  | { kind: "text"; text: string }
  | { kind: "metric"; value: number; unit: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "series"; unit: string; values: { label: string; value: number }[] }
  | {
      kind: "tests";
      checks: {
        name: string;
        result: "passed" | "failed" | "running" | "unknown";
      }[];
    }
  | { kind: "edges"; edges: { from: string; to: string; relation: string }[] };
export interface Evidence {
  id: string;
  projectId: string;
  sourceId: string;
  revision: string;
  timestamp: string;
  attribution: "recorded" | "agent-reported" | "sample";
  /** Who or what the record is ("You", "Agent", "Approval"); examples without one show the component name. */
  label?: string;
  data: EvidenceData;
}
export interface Source {
  projectId: string;
  id: string;
  revision: string;
  permissionScope: string;
}
export const catalog = {
  Summary: "text",
  Finding: "text",
  TerminalExcerpt: "text",
  CodeDiff: "text",
  Metric: "metric",
  Comparison: "series",
  Chart: "series",
  DataTable: "table",
  FileChangeList: "table",
  TaskTimeline: "table",
  TestReport: "tests",
  DependencyGraph: "edges",
  HandoffTrace: "edges",
} as const;
export type ComponentType = keyof typeof catalog;
export interface PresentationBlock {
  id: string;
  type: ComponentType;
  evidenceId: string;
}
/** "deterministic-1" is the standard layout; "agent-1" was arranged by a model choosing blocks only. */
export type TemplateVersion = "deterministic-1" | "agent-1";
export interface Presentation {
  schemaVersion: "nook.presentation.v1";
  catalogVersion: "2";
  source: Source;
  templateVersion: TemplateVersion;
  generatedAt: string;
  blocks: PresentationBlock[];
}
/** The wire contract with the backend's PresentSession, mirrored in backend/src/presentation.rs. */
export interface PresentRequest {
  sessionId: string;
  revision: number;
  focus: string;
  arrange: boolean;
}
export interface PresentResult {
  source: Source;
  evidence: Evidence[];
  /** Records that existed; `evidence` keeps only the latest. */
  total: number;
  presentation: Presentation;
  /** "sample" is the browser demo, which never calls a model. */
  mode: "standard" | "model" | "sample";
  provider: string;
  focus: string;
  /** Why a requested arrangement was not used. */
  reason: string;
  cached: boolean;
}
export function cacheKey(source: Source) {
  return JSON.stringify([
    source.projectId,
    source.id,
    source.revision,
    source.permissionScope,
    "nook.presentation.v1",
    "2",
    "deterministic-1",
  ]);
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
export function validatePresentation(
  value: unknown,
  source: Source,
  evidence: readonly Evidence[],
): value is Presentation {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "catalogVersion",
      "source",
      "templateVersion",
      "generatedAt",
      "blocks",
    ]) ||
    value.schemaVersion !== "nook.presentation.v1" ||
    value.catalogVersion !== "2" ||
    !["deterministic-1", "agent-1"].includes(value.templateVersion as string) ||
    typeof value.generatedAt !== "string"
  )
    return false;
  if (
    !record(value.source) ||
    !exact(value.source, ["projectId", "id", "revision", "permissionScope"]) ||
    Object.entries(source).some(
      ([k, v]) =>
        value.source && (value.source as Record<string, unknown>)[k] !== v,
    )
  )
    return false;
  if (!Array.isArray(value.blocks) || value.blocks.length > 100) return false;
  const ids = new Set<string>();
  return value.blocks.every((b) => {
    if (
      !record(b) ||
      !exact(b, ["id", "type", "evidenceId"]) ||
      typeof b.id !== "string" ||
      ids.has(b.id) ||
      typeof b.type !== "string" ||
      !Object.hasOwn(catalog, b.type) ||
      typeof b.evidenceId !== "string"
    )
      return false;
    ids.add(b.id);
    const e = evidence.find((e) => e.id === b.evidenceId);
    return (
      !!e &&
      e.projectId === source.projectId &&
      e.sourceId === source.id &&
      e.revision === source.revision &&
      e.data.kind === catalog[b.type as ComponentType]
    );
  });
}
export const MAX_EVIDENCE = 200;
export const STANDARD_BLOCKS = 40;
const EVIDENCE_TEXT = 8 * 1024;
const eventKinds: Record<
  string,
  { label: string; attribution: Evidence["attribution"] }
> = {
  user: { label: "You", attribution: "recorded" },
  delta: { label: "Agent", attribution: "agent-reported" },
  approval: { label: "Approval", attribution: "recorded" },
  completed: { label: "Status", attribution: "recorded" },
  stopped: { label: "Status", attribution: "recorded" },
  error: { label: "Problem", attribution: "recorded" },
  disconnected: { label: "Problem", attribution: "recorded" },
};
/**
 * Mirrors build_evidence in backend/src/presentation.rs: only conversation, approvals and outcomes
 * count (process identities and progress chatter do not), and the chunks of one streamed message
 * become one record, identified by its first event. Keeps the latest MAX_EVIDENCE of `total`.
 */
export function buildEvidence(
  events: readonly SessionEvent[],
  source: Source,
): { items: Evidence[]; total: number } {
  const out: Evidence[] = [];
  const streams = new Map<string, Evidence>();
  for (const e of events) {
    if (e.sessionId !== source.id) continue;
    if (e.kind === "evidence" || e.kind === "check") {
      (e.recorded ?? []).forEach((r, i) =>
        out.push({
          id: `${source.id}:${e.sequence}:${i}`,
          projectId: source.projectId,
          sourceId: source.id,
          revision: source.revision,
          timestamp: e.time,
          attribution: "recorded",
          label: r.label,
          data: structuredClone(r.data),
        }),
      );
      continue;
    }
    if (!Object.hasOwn(eventKinds, e.kind)) continue;
    const { label, attribution } = eventKinds[e.kind];
    const text =
      e.kind === "approval"
        ? e.approval?.detail
          ? `${e.approval.title}\n${e.approval.detail}`
          : (e.approval?.title ?? "")
        : e.text;
    const stream = e.kind === "delta" && e.itemId ? e.itemId : "";
    const joined = streams.get(stream);
    if (stream && joined) {
      // Blank chunks are line breaks inside a message, so they still join it.
      if (joined.data.kind === "text") joined.data.text += text;
      continue;
    }
    if (!text.trim()) continue;
    const item: Evidence = {
      id: `${source.id}:${e.sequence}`,
      projectId: source.projectId,
      sourceId: source.id,
      revision: source.revision,
      timestamp: e.time,
      attribution,
      label,
      data: { kind: "text", text },
    };
    if (stream) streams.set(stream, item);
    out.push(item);
  }
  for (const e of out)
    if (e.data.kind === "text") {
      const bytes = new TextEncoder().encode(e.data.text);
      if (bytes.length > EVIDENCE_TEXT) {
        let end = EVIDENCE_TEXT;
        while ((bytes[end] & 0xc0) === 0x80) end--;
        e.data.text =
          new TextDecoder().decode(bytes.slice(0, end)) + "\n[Truncated]";
      }
    }
  return { items: out.slice(-MAX_EVIDENCE), total: out.length };
}
export function sessionEvidence(
  events: readonly SessionEvent[],
  source: Source,
): Evidence[] {
  return buildEvidence(events, source).items;
}
const isText = (v: unknown) => typeof v === "string";
const listOf = (v: unknown, ok: (x: unknown) => boolean) =>
  Array.isArray(v) && v.every(ok);
function sound(v: unknown): v is Evidence {
  if (!record(v) || !isText(v.id) || !record(v.data)) return false;
  const d = v.data;
  switch (d.kind) {
    case "text":
      return isText(d.text);
    case "metric":
      return Number.isFinite(d.value) && isText(d.unit);
    case "table":
      return (
        listOf(d.columns, isText) && listOf(d.rows, (r) => listOf(r, isText))
      );
    case "series":
      return (
        isText(d.unit) &&
        listOf(
          d.values,
          (x) => record(x) && isText(x.label) && Number.isFinite(x.value),
        )
      );
    case "tests":
      return listOf(
        d.checks,
        (x) => record(x) && isText(x.name) && isText(x.result),
      );
    case "edges":
      return listOf(
        d.edges,
        (x) =>
          record(x) && isText(x.from) && isText(x.to) && isText(x.relation),
      );
    default:
      return false;
  }
}
/** The second gate for a backend result: it must be about exactly the source that was asked for. */
export function validateResult(
  value: unknown,
  expected: Source,
): value is PresentResult {
  return (
    record(value) &&
    record(value.source) &&
    Object.entries(expected).every(
      ([k, v]) => (value.source as Record<string, unknown>)[k] === v,
    ) &&
    listOf(value.evidence, sound) &&
    typeof value.total === "number" &&
    ["standard", "model", "sample"].includes(value.mode as string) &&
    isText(value.provider) &&
    isText(value.focus) &&
    isText(value.reason) &&
    typeof value.cached === "boolean" &&
    validatePresentation(
      value.presentation,
      expected,
      value.evidence as Evidence[],
    )
  );
}
export function compose(
  source: Source,
  evidence: readonly Evidence[],
): Presentation {
  return {
    schemaVersion: "nook.presentation.v1",
    catalogVersion: "2",
    source,
    templateVersion: "deterministic-1",
    generatedAt: new Date().toISOString(),
    blocks: evidence.slice(-STANDARD_BLOCKS).map((e) => ({
      id: e.id,
      evidenceId: e.id,
      type:
        nativeComponent(e) ??
        (
          {
            text: "Summary",
            metric: "Metric",
            table: "DataTable",
            series: "Chart",
            tests: "TestReport",
            edges: "DependencyGraph",
          } as const
        )[e.data.kind],
    })),
  };
}

function nativeComponent(e: Evidence): ComponentType | undefined {
  if (e.attribution !== "recorded") return undefined;
  const labels: Record<string, ComponentType> = {
    "Changed files": "FileChangeList",
    "Code changes": "CodeDiff",
    "Session timeline": "TaskTimeline",
    "Accepted handoffs": "HandoffTrace",
    "Check output": "TerminalExcerpt",
  };
  return Object.hasOwn(labels, e.label ?? "") ? labels[e.label!] : undefined;
}
