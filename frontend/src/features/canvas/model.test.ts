import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../types";
import {
  buildEvidence,
  cacheKey,
  compose,
  MAX_EVIDENCE,
  sessionEvidence,
  STANDARD_BLOCKS,
  validatePresentation,
  validateResult,
  type Evidence,
  type PresentResult,
  type Source,
} from "./model";
const source: Source = {
  projectId: "p",
  id: "s",
  revision: "3",
  permissionScope: "local:p:s",
};
const evidence: Evidence[] = [
  {
    id: "e",
    projectId: "p",
    sourceId: "s",
    revision: "3",
    timestamp: "",
    attribution: "agent-reported",
    data: { kind: "text", text: "<script>unsafe()</script>" },
  },
];
describe("presentation boundary", () => {
  it("accepts evidence-backed catalog components", () => {
    expect(
      validatePresentation(compose(source, evidence), source, evidence),
    ).toBe(true);
  });
  it.each(["script", "iframe", "__proto__", "constructor", "NativeCommand"])(
    "rejects component %s",
    (type) => {
      const spec = compose(source, evidence);
      expect(
        validatePresentation(
          { ...spec, blocks: [{ id: "b", type, evidenceId: "e" }] },
          source,
          evidence,
        ),
      ).toBe(false);
    },
  );
  it("rejects native actions and untrusted props", () => {
    const spec = compose(source, evidence);
    expect(
      validatePresentation({ ...spec, actions: ["Stop"] }, source, evidence),
    ).toBe(false);
    expect(
      validatePresentation(
        { ...spec, blocks: [{ ...spec.blocks[0], onClick: "rm -rf" }] },
        source,
        evidence,
      ),
    ).toBe(false);
  });
  it("fails closed for changed scope, revision, missing evidence and type mismatch", () => {
    const spec = compose(source, evidence);
    expect(
      validatePresentation(
        spec,
        { ...source, permissionScope: "revoked" },
        evidence,
      ),
    ).toBe(false);
    expect(
      validatePresentation(spec, { ...source, revision: "4" }, evidence),
    ).toBe(false);
    expect(validatePresentation(spec, source, [])).toBe(false);
    expect(
      validatePresentation(spec, source, [
        { ...evidence[0], projectId: "other" },
      ]),
    ).toBe(false);
    expect(
      validatePresentation(
        { ...spec, blocks: [{ id: "b", type: "Metric", evidenceId: "e" }] },
        source,
        evidence,
      ),
    ).toBe(false);
  });
  it("isolates cache keys by source scope and revision", () => {
    expect(cacheKey(source)).not.toBe(
      cacheKey({ ...source, projectId: "other" }),
    );
    expect(cacheKey(source)).not.toBe(
      cacheKey({ ...source, permissionScope: "changed" }),
    );
    expect(cacheKey(source)).not.toBe(cacheKey({ ...source, revision: "4" }));
  });
  it("keeps agent claims unverified and excludes other sessions", () => {
    const events = [
      {
        sequence: 3,
        sessionId: "s",
        kind: "delta",
        text: "100 tests passed",
        itemId: "m",
        time: "",
      },
      {
        sequence: 4,
        sessionId: "other",
        kind: "delta",
        text: "Private",
        itemId: "m",
        time: "",
      },
    ];
    const result = sessionEvidence(events, source);
    expect(result).toHaveLength(1);
    expect(result[0].attribution).toBe("agent-reported");
    expect(result[0].data.kind).toBe("text");
  });
});
// These cases mirror the unit tests of build_evidence in backend/src/presentation.rs.
const ev = (
  sequence: number,
  kind: string,
  itemId: string,
  text: string,
): SessionEvent => ({ sequence, sessionId: "s", kind, text, itemId, time: "t" });
const textOf = (e: Evidence) => (e.data.kind === "text" ? e.data.text : "");
describe("session evidence", () => {
  it("joins streamed chunks into one record and leaves out process chatter", () => {
    const approval: SessionEvent = {
      ...ev(6, "approval", "a", "ignored"),
      approval: {
        id: "a",
        sessionId: "s",
        kind: "approval",
        title: "Run tests?",
        detail: "npm test",
        questions: [],
        decisions: [],
      },
    };
    const { items, total } = buildEvidence(
      [
        ev(1, "user", "u", "Hello"),
        ev(2, "process", "", '{"pid":7,"birth":"secret"}'),
        ev(3, "delta", "m", "First"),
        ev(4, "activity", "", "Thinking"),
        ev(5, "delta", "m", "\n"),
        approval,
        ev(7, "delta", "m", "Second"),
        ev(8, "provider_id", "", "abc"),
        ev(9, "delta", "other", "   "),
        ev(10, "error", "", "Boom"),
      ],
      source,
    );
    expect(total).toBe(4);
    expect(items.map(textOf)).toEqual([
      "Hello",
      "First\nSecond",
      "Run tests?\nnpm test",
      "Boom",
    ]);
    expect(items.map((e) => e.label)).toEqual([
      "You",
      "Agent",
      "Approval",
      "Problem",
    ]);
    expect(items[1].id).toBe("s:3");
    expect(items[1].attribution).toBe("agent-reported");
    expect(JSON.stringify(items)).not.toContain("secret");
  });
  it("never includes another session or an unknown kind", () => {
    const foreign = { ...ev(2, "delta", "m", "Private"), sessionId: "other" };
    const { items } = buildEvidence(
      [ev(1, "user", "u", "Mine"), foreign, ev(3, "constructor", "", "x")],
      source,
    );
    expect(items.map(textOf)).toEqual(["Mine"]);
  });
  it("keeps the latest records and marks long text", () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      ev(i + 1, "user", "", `m${i + 1}`),
    );
    events.push(ev(251, "delta", "big", "x".repeat(20_000)));
    const { items, total } = buildEvidence(events, source);
    expect([total, items.length]).toEqual([251, MAX_EVIDENCE]);
    const last = textOf(items.at(-1)!);
    expect(last.endsWith("\n[Truncated]") && last.length < 8300).toBe(true);
    expect(compose(source, items).blocks).toHaveLength(STANDARD_BLOCKS);
  });
});
describe("arranged results", () => {
  const result = (over: Partial<PresentResult> = {}): PresentResult => ({
    source,
    evidence,
    total: 1,
    presentation: compose(source, evidence),
    mode: "model",
    provider: "Claude Code",
    focus: "",
    reason: "",
    cached: false,
    ...over,
  });
  const arranged = (type: string) => ({
    ...compose(source, evidence),
    templateVersion: "agent-1",
    blocks: [{ id: "e", evidenceId: "e", type }],
  });
  it("accepts a result about exactly the requested source", () => {
    expect(validateResult(result(), source)).toBe(true);
    for (const type of ["Finding", "TerminalExcerpt", "CodeDiff"])
      expect(
        validateResult(
          result({ presentation: arranged(type) as never }),
          source,
        ),
      ).toBe(true);
  });
  it("rejects a result for another revision, scope or session", () => {
    expect(validateResult(result(), { ...source, revision: "4" })).toBe(false);
    expect(
      validateResult(result(), { ...source, permissionScope: "revoked" }),
    ).toBe(false);
    expect(
      validateResult(result({ source: { ...source, id: "other" } }), source),
    ).toBe(false);
  });
  it("rejects components that cannot render the evidence, and malformed data", () => {
    expect(
      validateResult(result({ presentation: arranged("Metric") as never }), source),
    ).toBe(false);
    expect(
      validateResult(
        result({ presentation: arranged("NativeCommand") as never }),
        source,
      ),
    ).toBe(false);
    const bad = [
      { ...evidence[0], data: { kind: "table", columns: "x", rows: [] } },
      { ...evidence[0], data: { kind: "script", text: "x" } },
      { ...evidence[0], data: { kind: "metric", value: "NaN", unit: "" } },
    ];
    for (const e of bad)
      expect(validateResult(result({ evidence: [e] as never }), source)).toBe(
        false,
      );
    expect(validateResult(result({ mode: "magic" as never }), source)).toBe(
      false,
    );
    expect(validateResult(null, source)).toBe(false);
  });
});
