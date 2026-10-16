import { describe, it, expect, vi } from "vitest";
import { createDemo } from "./demo";
import { needsAttention } from "./types";
describe("workspace contracts", () => {
  it("separates attention from normal activity across 15 sessions", async () => {
    const api = createDemo(() => {});
    const s = await api.Snapshot();
    expect(s.sessions).toHaveLength(15);
    expect(s.sessions.filter(needsAttention).map((s) => s.id)).toEqual([
      "s1",
      "s6",
      "s12",
    ]);
    expect(new Set(s.sessions.map((s) => s.id)).size).toBe(15);
  });
  it("keeps UI snapshots isolated from runtime changes", async () => {
    const api = createDemo(() => {});
    const before = await api.Snapshot();
    await api.Stop("s0");
    expect(before.sessions[0].state).toBe("working");
    expect((await api.Snapshot()).sessions[0].state).toBe("stopped");
  });
  it("resolves one approval without removing another", async () => {
    const changed = vi.fn();
    const api = createDemo(changed);
    await api.Respond({
      sessionId: "s1",
      requestId: "a1",
      decision: "accept",
      answers: {},
    });
    expect((await api.Snapshot()).approvals.map((a) => a.id)).toEqual(["a2"]);
    expect(changed).toHaveBeenCalled();
  });
});
