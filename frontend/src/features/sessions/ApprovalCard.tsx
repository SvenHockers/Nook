import { useState } from "react";
import { MessageCircle } from "lucide-react";
import type { API, Approval } from "../../types";

export function ApprovalCard({
  approval: a,
  answer,
  disabled,
}: {
  approval: Approval;
  answer: (r: Parameters<API["Respond"]>[0]) => Promise<unknown>;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return (
    <div className="approval">
      <span className="approval-kicker">
        <MessageCircle size={15} />A LITTLE INPUT FROM YOU
      </span>
      <h3>{a.title}</h3>
      {a.detail && <pre>{a.detail}</pre>}
      {a.questions?.map((q) => (
        <fieldset key={q.id}>
          <legend>{q.text}</legend>
          {q.options.map((o) => (
            <label className="answer-choice" key={o}>
              <input
                type={q.multi ? "checkbox" : "radio"}
                name={a.id + q.id}
                checked={answers[q.id]?.includes(o) || false}
                onChange={(e) =>
                  setAnswers({
                    ...answers,
                    [q.id]: q.multi
                      ? e.target.checked
                        ? [...(answers[q.id] || []), o]
                        : (answers[q.id] || []).filter((v) => v !== o)
                      : [o],
                  })
                }
              />
              {o}
            </label>
          ))}
          <input
            aria-label={"Custom answer: " + q.text}
            placeholder="Or write your own answer…"
            value={(answers[q.id] || [])
              .filter((v) => !q.options.includes(v))
              .join(", ")}
            onChange={(e) =>
              setAnswers({
                ...answers,
                [q.id]: e.target.value ? [e.target.value] : [],
              })
            }
          />
        </fieldset>
      ))}
      <div className="approval-actions">
        {a.decisions.map((d) => (
          <button
            key={d}
            disabled={
              disabled ||
              (d === "answer" &&
                a.questions.some((q) => !answers[q.id]?.length))
            }
            className={
              ["accept", "answer"].includes(d) ? "primary" : "secondary"
            }
            onClick={() =>
              answer({
                sessionId: a.sessionId,
                requestId: a.id,
                decision: d,
                answers,
              })
            }
          >
            {(
              {
                accept: "Allow once",
                decline: "Decline",
                answer: "Send answer",
                cancel: "Cancel turn",
              } as Record<string, string>
            )[d] || d}
          </button>
        ))}
      </div>
    </div>
  );
}
