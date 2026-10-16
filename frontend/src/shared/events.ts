import type { SessionEvent } from "../types";
// Sequences are globally ordered in SQLite. Replays must not duplicate a session's evidence.
export function mergeSessionEvents(
  sessionId: string,
  current: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): SessionEvent[] {
  const events = new Map<number, SessionEvent>();
  for (const event of [...current, ...incoming]) {
    if (
      event.sessionId === sessionId &&
      Number.isSafeInteger(event.sequence) &&
      event.sequence > 0 &&
      !events.has(event.sequence)
    )
      events.set(event.sequence, event);
  }
  return [...events.values()].sort((a, b) => a.sequence - b.sequence);
}
