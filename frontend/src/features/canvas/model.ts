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
export interface Presentation {
  schemaVersion: "nook.presentation.v1";
  catalogVersion: "1";
  source: Source;
  templateVersion: "deterministic-1";
  generatedAt: string;
  blocks: PresentationBlock[];
}
export function cacheKey(source: Source) {
  return JSON.stringify([
    source.projectId,
    source.id,
    source.revision,
    source.permissionScope,
    "nook.presentation.v1",
    "1",
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
    value.catalogVersion !== "1" ||
    value.templateVersion !== "deterministic-1" ||
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
export function sessionEvidence(
  events: readonly SessionEvent[],
  source: Source,
): Evidence[] {
  return events
    .filter((e) => e.sessionId === source.id && e.kind !== "provider_id")
    .map((e) => ({
      id: `${source.id}:${e.sequence}`,
      projectId: source.projectId,
      sourceId: source.id,
      revision: source.revision,
      timestamp: e.time,
      attribution: e.kind === "delta" ? "agent-reported" : "recorded",
      data: { kind: "text", text: e.text || e.approval?.title || e.kind },
    }));
}
export function compose(
  source: Source,
  evidence: readonly Evidence[],
): Presentation {
  return {
    schemaVersion: "nook.presentation.v1",
    catalogVersion: "1",
    source,
    templateVersion: "deterministic-1",
    generatedAt: new Date().toISOString(),
    blocks: evidence
      .slice(-40)
      .map((e) => ({
        id: e.id,
        evidenceId: e.id,
        type: (
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
