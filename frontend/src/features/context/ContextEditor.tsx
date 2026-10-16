import { useState } from "react";
import { FileText, FolderOpen, Plus, X } from "lucide-react";
import { api } from "../../api";
import type { ContextItem } from "../../types";

export function ContextEditor({
  items,
  save,
}: {
  items: ContextItem[];
  save: (items: ContextItem[]) => Promise<unknown>;
}) {
  const [kind, setKind] = useState<ContextItem["kind"]>("note"),
    [name, setName] = useState(""),
    [value, setValue] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="context-editor">
      <h3>Shared with this agent</h3>
      <p className="help">
        Changes apply to the next message. Removing an item cannot erase
        information already sent.
      </p>
      {items.map((item, i) => (
        <div className="context-item" key={item.id}>
          <input
            type="checkbox"
            aria-label={"Include " + item.name}
            checked={item.enabled}
            onChange={() =>
              save(
                items.map((c, j) =>
                  j === i ? { ...c, enabled: !c.enabled } : c,
                ),
              )
            }
          />
          <FileText size={17} />
          <div>
            <strong>{item.name}</strong>
            <small>{item.kind === "note" ? "Project note" : item.value}</small>
          </div>
          <button
            className="icon-button"
            aria-label={"Remove " + item.name}
            onClick={() => save(items.filter((_, j) => j !== i))}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const saved = await save([
            ...items,
            {
              id: crypto.randomUUID(),
              kind,
              name: name.trim() || value.split(/[\\/]/).at(-1) || "Reference",
              value,
              enabled: true,
            },
          ]);
          if (saved) {
            setName("");
            setValue("");
          }
        }}
      >
        <label>
          Add context
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ContextItem["kind"]);
              setValue("");
            }}
          >
            <option value="note">A project note</option>
            <option value="file">A text file</option>
            <option value="folder">A reference folder</option>
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should we call it?"
          />
        </label>
        {kind === "note" ? (
          <label>
            Note
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              required
              maxLength={100000}
            />
          </label>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  const p = await api.ChooseContext(kind);
                  if (p) setValue(p);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <FolderOpen size={15} />
              Choose {kind}
            </button>
            <p className="path help">{value || "Nothing selected yet"}</p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="secondary" disabled={!value.trim()}>
          <Plus size={15} />
          Add context
        </button>
      </form>
    </div>
  );
}
