import type { SessionEvent } from "../../types";

export function Conversation({ events }: { events: SessionEvent[] }) {
  const messages: { id: string; role: string; text: string }[] = [];
  for (const e of events) {
    if (e.kind === "user")
      messages.push({
        id: e.itemId || String(e.sequence),
        role: "user",
        text: e.text,
      });
    if (e.kind === "delta") {
      const last = messages.at(-1);
      if (last?.id === e.itemId && last.role === "agent") last.text += e.text;
      else
        messages.push({
          id: e.itemId || String(e.sequence),
          role: "agent",
          text: e.text,
        });
    }
  }
  return (
    <div className="conversation">
      {messages.map((m, i) => (
        <div key={m.id + i} className={"message " + m.role}>
          <span className="message-author">
            {m.role === "user" ? "You" : "Your agent"}
          </span>
          <div>{m.text}</div>
        </div>
      ))}
    </div>
  );
}
