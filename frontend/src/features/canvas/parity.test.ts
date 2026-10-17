import { expect, it } from "vitest";
import golden from "./evidence.golden.json";
import {
  buildEvidence,
  compose,
  cacheKey,
  validatePresentation,
} from "./model";
import type { SessionEvent } from "../../types";
it("matches the Rust native evidence, layout and cache-key golden for every kind", () => {
  const built = buildEvidence(golden.events as SessionEvent[], golden.source);
  expect(built).toEqual({ items: golden.items, total: golden.total });
  const layout = compose(golden.source, built.items);
  expect({ ...layout, generatedAt: "fixed" }).toEqual(golden.layout);
  expect(cacheKey(golden.source)).toEqual(golden.cacheKey);
  expect(validatePresentation(layout, golden.source, built.items)).toBe(true);
  expect(new Set(built.items.map((e) => e.data.kind)).size).toBe(6);
});
