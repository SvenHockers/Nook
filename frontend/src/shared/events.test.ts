import { expect, it } from "vitest";
import { mergeSessionEvents } from "./events";
import type { SessionEvent } from "../types";
it("deduplicates reconnect replay, preserves original evidence and orders out-of-order events", () => {
  const event: SessionEvent = {
    sessionId: "s",
    sequence: 2,
    kind: "delta",
    text: "original",
    itemId: "m",
    time: "",
  };
  const result = mergeSessionEvents(
    "s",
    [event],
    [
      { ...event, text: "replacement" },
      { ...event, sequence: 1 },
      { ...event, sequence: 3, sessionId: "other" },
    ],
  );
  expect(result.map((e) => e.sequence)).toEqual([1, 2]);
  expect(result[1].text).toBe("original");
});
