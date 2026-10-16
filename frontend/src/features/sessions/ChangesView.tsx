import { useEffect, useState } from "react";
import { ArrowDownToLine, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "../../api";
import type { Changes } from "../../types";

export function ChangesView({
  id,
  run,
}: {
  id: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}) {
  const [changes, setChanges] = useState<Changes>(),
    [error, setError] = useState("");
  const load = () =>
    api
      .Changes(id)
      .then(setChanges)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    load();
  }, [id]);
  return (
    <div className="changes">
      <div className="changes-toolbar">
        <strong>Work in this checkout</strong>
        <button
          className="icon-button"
          aria-label="Refresh changes"
          onClick={load}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="help">
        Compared with this session’s starting commit. Untracked files are listed
        but are not included in the patch.
      </p>
      <div className="changes-buttons">
        <button
          className="secondary"
          onClick={() => run(() => api.ExportPatch(id))}
        >
          <ArrowDownToLine size={15} />
          Export patch
        </button>
        <button
          className="text-button"
          onClick={() => run(() => api.Reveal(id))}
        >
          <ExternalLink size={14} />
          Open folder
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <pre className="file-status">
        {changes?.status || "No changed files."}
      </pre>
      <pre className="diff">{changes?.diff || "No tracked changes yet."}</pre>
    </div>
  );
}
