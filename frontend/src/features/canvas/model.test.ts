import { describe, expect, it } from "vitest";
import {
  cacheKey,
  compose,
  sessionEvidence,
  validatePresentation,
  type Evidence,
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
