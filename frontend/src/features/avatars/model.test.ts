import { describe, expect, it } from "vitest";
import {
  characters,
  resolveExpression,
  runtimeFromSession,
  runtimeStates,
} from "./model";
describe("avatar expression contract", () => {
  it("preserves identity through every state and bounds gaze", () => {
    for (const identity of characters)
      for (const state of runtimeStates) {
        const before = JSON.stringify(identity);
        const pose = resolveExpression(identity, state, {
          hovered: true,
          selected: true,
          pointer: { x: 999, y: -999 },
        });
        expect(Math.abs(pose.pupilX)).toBeLessThanOrEqual(4);
        expect(Math.abs(pose.pupilY)).toBeLessThanOrEqual(4);
        expect(pose.openness).toBeGreaterThanOrEqual(0);
        expect(pose.openness).toBeLessThanOrEqual(1);
        expect(JSON.stringify(identity)).toBe(before);
      }
  });
  it("does not let pointer motion override attention", () => {
    expect(
      resolveExpression(characters[0], "waiting_for_input", {
        hovered: true,
        selected: true,
        pointer: { x: 1, y: 1 },
      }),
    ).toEqual(
      resolveExpression(characters[0], "waiting_for_input", {
        hovered: false,
        selected: false,
      }),
    );
  });
  it("maps stopped to idle rather than inventing resumable pause", () => {
    expect(runtimeFromSession.stopped).toBe("idle");
    expect(runtimeFromSession.disconnected).toBe("disconnected");
  });
});
