import { LiveWorkflows } from "./features/work/LiveWorkflows";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Command,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Sun,
  Moon,
  Monitor,
  TriangleAlert,
  X,
  Bell,
  Leaf,
  FileText,
  Archive,
  RefreshCw,
  ExternalLink,
  Pencil,
  Users,
  Workflow,
  Repeat2,
  Library,
  Activity,
  Smile,
} from "lucide-react";
import { api, demo, subscribe } from "./api";
import { Avatar } from "./Avatar";
import { mergeSessionEvents } from "./shared/events";
import { AvatarPlayground } from "./features/avatars/AvatarPlayground";
import { SessionCanvas } from "./features/canvas/PresentationCanvas";
import {
  WorkflowWorkspace,
  LoopWorkspace,
  ContextWorkspace,
  ActivityWorkspace,
  type WorkspacePage,
} from "./features/work/Workspaces";
import {
  active,
  needsAttention,
  type Snapshot,
  type Session,
  type SessionEvent,
  type Approval,
  type ContextItem,
  type Project,
  type Changes,
} from "./types";
const empty: Snapshot = {
  workflows: [],
  projects: [],
  sessions: [],
  providers: [],
  approvals: [],
  problem: "",
};
type Nav = {
  page: WorkspacePage;
  project: string;
  selected: string;
  filter: string;
  search: string;
  theme: string;
  drafts: Record<string, string>;
  scroll: Record<string, number>;
  tab: string;
  completionNotifications: boolean;
};
const initial: Nav = {
  page: "Home",
  project: "all",
  selected: "",
  filter: "all",
  search: "",
  theme: "system",
  drafts: {},
  scroll: {},
  tab: "Conversation",
  completionNotifications: false,
};
const stateLabels: Record<string, string> = {
  starting: "Getting ready",
  working: "Working",
  waiting: "Needs you",
  completed: "Ready to review",
  stopped: "Resting",
  failed: "Needs attention",
  disconnected: "Disconnected",
};
const stateClass = (s: Session) => `status status-${s.state}`;
const shortcutKey = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl";
function Modal({
  title,
  onClose,
  children,
  wide = false,
  error,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      className={wide ? "modal wide" : "modal"}
      aria-labelledby="dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
export function App() {
  const [data, setData] = useState(empty),
    [nav, setNav] = useState<Nav>(initial),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [modal, setModal] = useState(""),
    [pending, setPending] = useState(false),
    [history, setHistory] = useState<Record<string, SessionEvent[]>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seqs = useRef<Record<string, number>>({});
  const fetching = useRef(false);
  const navRef = useRef(nav);
  navRef.current = nav;
  const notified = useRef(new Set<string>());
  const previousStates = useRef<Record<string, string>>({});
  const update = (patch: Partial<Nav>) => setNav((n) => ({ ...n, ...patch }));
  const refresh = useCallback(async () => {
    try {
      setData(await api.Snapshot());
      setLoaded(true);
    } catch (e) {
      setError(String(e));
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    refresh();
    api
      .Navigation()
      .then((v) => {
        if (v) {
          try {
            setNav({ ...initial, ...JSON.parse(v) });
          } catch {
            /* ignore invalid saved UI state */
          }
        }
      })
      .catch(() => {});
    const off = subscribe(() => {
      if (!timer.current)
        timer.current = setTimeout(() => {
          timer.current = undefined;
          refresh();
        }, 120);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [refresh]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      api.SaveNavigation(JSON.stringify(nav)).catch((e) => setError(String(e)));
    }, 350);
    return () => clearTimeout(t);
  }, [nav, loaded]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        nav.theme === "system" ? (mq.matches ? "dark" : "light") : nav.theme);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [nav.theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        update({ page: "Agents" });
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>("#search")?.focus(),
        );
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setModal("launch");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setModal("settings");
      }
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        update({ selected: "" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    for (const a of data.approvals) {
      const key = "a" + a.id;
      if (!notified.current.has(key)) {
        notified.current.add(key);
        if (!document.hasFocus())
          api.Notify("Nook · Your agent needs you", a.title).catch(() => {});
      }
    }
    for (const s of data.sessions) {
      const previous = previousStates.current[s.id];
      previousStates.current[s.id] = s.state;
      if (
        (s.state === "failed" ||
          s.state === "disconnected" ||
          (nav.completionNotifications && s.state === "completed")) &&
        previous !== s.state
      ) {
        if (!document.hasFocus())
          api.Notify("Nook · " + s.title, s.activity).catch(() => {});
      }
    }
  }, [data, loaded, nav.completionNotifications]);
  const selected = data.sessions.find((s) => s.id === nav.selected);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const id = selected.id;
    async function load() {
      if (fetching.current) return;
      fetching.current = true;
      try {
        let more = true;
        while (more && alive) {
          const batch = await api.Events(id, seqs.current[id] || 0);
          if (!alive) break;
          if (batch.length) {
            seqs.current[id] = Math.max(
              seqs.current[id] || 0,
              ...batch.filter((e) => e.sessionId === id).map((e) => e.sequence),
            );
            setHistory((h) => ({
              ...h,
              [id]: mergeSessionEvents(id, h[id] || [], batch),
            }));
          }
          more = batch.length === 1000;
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        fetching.current = false;
      }
    }
    load();
    const t = setInterval(load, 700);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected?.id]);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }
  const available = data.sessions.filter(
    (s) =>
      s.archived === (nav.filter === "archived") &&
      (nav.project === "all" || s.projectId === nav.project),
  );
  const attention = available.filter(needsAttention);
  const working = available.filter(
    (s) => s.state === "working" || s.state === "starting",
  );
  const visible = available.filter(
    (s) =>
      (nav.filter === "all" ||
        nav.filter === "archived" ||
        (nav.filter === "attention" && needsAttention(s)) ||
        (nav.filter === "working" &&
          ["working", "starting"].includes(s.state)) ||
        (nav.filter === "completed" && s.state === "completed")) &&
      [
        s.title,
        s.avatar.name,
        s.activity,
        s.provider,
        data.projects.find((p) => p.id === s.projectId)?.name || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(nav.search.toLowerCase()),
  );
  const project = data.projects.find((p) => p.id === nav.project);
  const currentProject = data.projects.find(
    (p) => p.id === selected?.projectId,
  );
  const select = (id: string) => update({ selected: id, tab: "Conversation" });
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            update({
              page: "Home",
              project: "all",
              selected: "",
              filter: "all",
            });
          }}
        >
          <span className="brand-mark">
            <Leaf size={23} strokeWidth={2} />
          </span>
          nook<span className="brand-dot">.</span>
        </a>
        <div className="workspace-switch">
          <div className="workspace-initial">S</div>
          <div>
            <strong>My workspace</strong>
            <small>A little room to create</small>
          </div>
          <MoreHorizontal size={17} />
        </div>
        <nav aria-label="Workspace">
          <button
            className={`nav-item ${nav.page === "Home" && nav.project === "all" && nav.filter !== "attention" ? "selected" : ""}`}
            onClick={() =>
              update({
                page: "Home",
                project: "all",
                selected: "",
                filter: "all",
              })
            }
          >
            <LayoutGrid size={18} />
            Home
          </button>
          {(
            [
              ["Agents", Users],
              ["Workflows", Workflow],
              ["Loops", Repeat2],
              ["Context", Library],
              ["Activity", Activity],
            ] as const
          ).map(([page, Icon]) => (
            <button
              key={page}
              className={`nav-item ${nav.page === page ? "selected" : ""}`}
              onClick={() => update({ page, selected: "" })}
            >
              <Icon size={18} />
              {page}
            </button>
          ))}
          <button
            className={`nav-item ${nav.filter === "attention" ? "selected" : ""}`}
            onClick={() =>
              update({
                page: "Home",
                project: "all",
                selected: "",
                filter: "attention",
              })
            }
          >
            <Bell size={18} />
            Needs attention
            {data.sessions.filter((s) => !s.archived && needsAttention(s))
              .length > 0 && (
              <span className="count attention-count">
                {
                  data.sessions.filter((s) => !s.archived && needsAttention(s))
                    .length
                }
              </span>
            )}
          </button>
        </nav>
        <div className="sidebar-label">
          PROJECTS
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={() => run(() => api.AddProject())}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="Projects" className="project-nav">
          {data.projects.map((p, i) => (
            <button
              key={p.id}
              className={`nav-item ${nav.project === p.id ? "selected" : ""}`}
              onClick={() =>
                update({
                  page: "Agents",
                  project: p.id,
                  selected: "",
                  filter: "all",
                })
              }
            >
              <Folder size={18} className={"folder-color color-" + (i % 3)} />
              <span>{p.name}</span>
              <span className="project-count">
                {
                  data.sessions.filter(
                    (s) => s.projectId === p.id && !s.archived,
                  ).length
                }
              </span>
            </button>
          ))}
          <button
            className="nav-item muted"
            onClick={() => run(() => api.AddProject())}
          >
            <Plus size={17} />
            Add a project
          </button>
        </nav>
        <button
          className="nav-item muted"
          onClick={() =>
            update({ page: "Agents", selected: "", filter: "archived" })
          }
        >
          <Archive size={17} />
          Archived sessions
        </button>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${nav.page === "Playground" ? "selected" : ""}`}
            onClick={() => update({ page: "Playground", selected: "" })}
          >
            <Smile size={18} />
            Avatar playground
          </button>
          <div className="little-note">
            <span>✳</span>
            <strong>Good things take a little space.</strong>
            <p>Bring your ideas. Your agents will help with the rest.</p>
          </div>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings size={18} />
            Settings<span className="shortcut">{shortcutKey} ,</span>
          </button>
          <div className="local-label">
            <span />
            Local workspace <span className="preview-tag">Preview</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {nav.page === "Home" || nav.page === "Agents"
                ? project?.name || nav.page
                : nav.page}
            </strong>
          </div>
          <div className="topbar-right">
            {demo && (
              <span className="demo-label">
                Demo workspace · no live agents
              </span>
            )}
            <button
              className="icon-button"
              aria-label="Open settings"
              onClick={() => setModal("settings")}
            >
              <SlidersHorizontal size={17} />
            </button>
            <span className="profile-circle">You</span>
          </div>
        </header>
        <div className="main-content">
          {nav.page === "Workflows" && (
            <LiveWorkflows data={data} refresh={refresh} openSession={select} />
          )}
          {nav.page === "Loops" && <LoopWorkspace />}
          {nav.page === "Playground" && (
            <AvatarPlayground
              theme={nav.theme}
              setTheme={(theme) => update({ theme })}
            />
          )}
          {nav.page === "Context" && (
            <ContextWorkspace
              data={data}
              openSession={(id) => update({ selected: id, tab: "Context" })}
              openProject={(id) => {
                update({ project: id });
                setModal("project-context");
              }}
            />
          )}
          {nav.page === "Activity" && (
            <ActivityWorkspace
              data={data}
              openSession={(id) => update({ selected: id, tab: "Activity" })}
            />
          )}
          {["Home", "Agents"].includes(nav.page) && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR IDEAS, IN GOOD COMPANY</div>
                  <h1>
                    {nav.filter === "attention"
                      ? "A little attention, a big difference."
                      : project
                        ? project.name
                        : "A little space for big ideas."}
                  </h1>
                  <p>
                    {nav.filter === "attention"
                      ? "A few things your agents could use a hand with."
                      : "Your agents are here. Let’s make something good."}
                  </p>
                </div>
                <button
                  className="primary new-agent"
                  onClick={() => setModal("launch")}
                >
                  <Plus size={18} />
                  New agent
                </button>
              </div>
              {(error || data.problem) && (
                <div className="error-banner" role="alert">
                  <TriangleAlert size={19} />
                  <span>{error || data.problem}</span>
                  <button
                    aria-label="Dismiss error"
                    className="icon-button"
                    onClick={() => setError("")}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              {attention.length > 0 && nav.filter !== "attention" && (
                <button
                  className="attention-banner"
                  onClick={() => update({ filter: "attention" })}
                >
                  <span className="attention-symbol">
                    <MessageCircle size={18} />
                  </span>
                  <span>
                    <strong>
                      {attention.length}{" "}
                      {attention.length === 1 ? "agent could" : "agents could"}{" "}
                      use your attention
                    </strong>
                    <small>A quick decision can keep things moving.</small>
                  </span>
                  <span className="banner-cta">
                    Take a look <ArrowRight size={16} />
                  </span>
                </button>
              )}
              {nav.page === "Home" && (
                <div className="home-summary" aria-label="Workspace summary">
                  <button onClick={() => update({ filter: "working" })}>
                    <strong>{working.length}</strong>
                    <span>Working now</span>
                  </button>
                  <button onClick={() => update({ filter: "attention" })}>
                    <strong>{attention.length}</strong>
                    <span>Need your attention</span>
                  </button>
                  <button onClick={() => update({ filter: "completed" })}>
                    <strong>
                      {available.filter((s) => s.state === "completed").length}
                    </strong>
                    <span>Ready to review</span>
                  </button>
                  <button onClick={() => update({ page: "Activity" })}>
                    <Activity size={22} />
                    <span>Recent activity →</span>
                  </button>
                </div>
              )}
              <div className="board-toolbar">
                <div
                  className="filters"
                  role="group"
                  aria-label="Filter agents"
                >
                  {[
                    ["all", "All agents", available.length],
                    ["working", "Working", working.length],
                    ["attention", "Needs you", attention.length],
                    [
                      "completed",
                      "Completed",
                      available.filter((s) => s.state === "completed").length,
                    ],
                  ].map(([key, label, count]) => (
                    <button
                      key={key}
                      className={nav.filter === key ? "active" : ""}
                      onClick={() => update({ filter: String(key) })}
                    >
                      {label}
                      <span>{count}</span>
                    </button>
                  ))}
                </div>
                <div className="search-box">
                  <Search size={16} />
                  <input
                    id="search"
                    aria-label="Search agents"
                    placeholder="Find an agent…"
                    value={nav.search}
                    onChange={(e) => update({ search: e.target.value })}
                  />
                  <kbd>{shortcutKey} K</kbd>
                </div>
              </div>
              {project && (
                <div className="project-context-row">
                  <FolderOpen size={15} />
                  <span title={project.path}>{project.path}</span>
                  <button
                    className="text-button"
                    onClick={() => setModal("project-context")}
                  >
                    Project context <ChevronRight size={14} />
                  </button>
                </div>
              )}
              {!loaded ? (
                <div className="empty">
                  <LoaderCircle className="spin" />
                  <h2>Making room…</h2>
                </div>
              ) : visible.length === 0 ? (
                <div className="empty">
                  <div className="empty-art">
                    <Leaf size={42} />
                  </div>
                  <h2>
                    {data.projects.length === 0
                      ? "Make yourself at home."
                      : "A little breathing room."}
                  </h2>
                  <p>
                    {data.projects.length === 0
                      ? "Choose a project folder, then give your first agent something to work on."
                      : "No agents match this view. Start a new task or change your filters."}
                  </p>
                  <button
                    className="primary"
                    onClick={() =>
                      data.projects.length === 0
                        ? run(() => api.AddProject())
                        : setModal("launch")
                    }
                  >
                    <Plus size={17} />
                    {data.projects.length === 0
                      ? "Open a project"
                      : "Start something new"}
                  </button>
                </div>
              ) : (
                <div className="agent-grid">
                  {visible.map((s) => (
                    <button
                      key={s.id}
                      className={`agent-card ${s.state === "waiting" ? "card-waiting" : ""}`}
                      onClick={() => select(s.id)}
                    >
                      <div className="card-top">
                        <span className={stateClass(s)}>
                          <span className="status-dot" />
                          {stateLabels[s.state]}
                        </span>
                        <span className="card-menu">
                          <ArrowRight size={16} />
                        </span>
                      </div>
                      <div
                        className={`avatar-stage stage-${s.avatar.color % 6}`}
                      >
                        <Avatar session={s} large />
                        {s.state === "completed" && (
                          <span className="done-spark">✧</span>
                        )}
                      </div>
                      <div className="card-copy">
                        <h2>{s.title}</h2>
                        <p>{s.activity}</p>
                      </div>
                      <div className="card-footer">
                        <span className="card-project">
                          <Folder size={13} />
                          {
                            data.projects.find((p) => p.id === s.projectId)
                              ?.name
                          }
                        </span>
                        <span className="provider-label">
                          <span className={"provider-glyph " + s.provider}>
                            {s.provider === "claude" ? "✳" : "◈"}
                          </span>
                          {data.providers.find((p) => p.id === s.provider)
                            ?.name || s.provider}
                        </span>
                      </div>
                    </button>
                  ))}
                  <button
                    className="add-agent-card"
                    onClick={() => setModal("launch")}
                  >
                    <span>
                      <Plus size={24} />
                    </span>
                    <strong>A fresh pair of eyes</strong>
                    <small>Give another idea a little room</small>
                  </button>
                </div>
              )}
              <footer className="board-footer">
                <span>
                  <span className="tiny-leaf">✳</span> A good place to do good
                  work.
                </span>
                <span>
                  {available.length} agents · {data.projects.length} projects
                </span>
              </footer>
            </>
          )}
        </div>
      </main>
      {selected && (
        <section className="detail" aria-label="Agent details">
          <div className="detail-top">
            <button
              className="icon-button"
              aria-label="Back to overview"
              onClick={() => update({ selected: "" })}
            >
              <ArrowLeft size={20} />
            </button>
            <span>{currentProject?.name}</span>
            <button
              className="icon-button"
              aria-label="Rename agent"
              onClick={() => setModal("rename")}
            >
              <Pencil size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Close agent details"
              onClick={() => update({ selected: "" })}
            >
              <X size={20} />
            </button>
          </div>
          <div className="detail-identity">
            <Avatar session={selected} />
            <div>
              <span className={stateClass(selected)}>
                <span className="status-dot" />
                {stateLabels[selected.state]}
              </span>
              <h2>{selected.title}</h2>
              <p>
                {data.providers.find((p) => p.id === selected.provider)?.name ||
                  selected.provider}{" "}
                ·{" "}
                {selected.isolated
                  ? "Separate worktree"
                  : "Shared project folder"}
              </p>
            </div>
          </div>
          <div className="detail-actions">
            {active(selected.state) ? (
              <button
                className="secondary"
                disabled={pending}
                onClick={() => run(() => api.Stop(selected.id))}
              >
                <Square size={13} />
                Stop agent
              </button>
            ) : (
              <button
                className="secondary"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    api.Send(selected.id, "Continue from where we left off."),
                  )
                }
              >
                <RefreshCw size={14} />
                {selected.providerId ? "Resume" : "Start again"}
              </button>
            )}
            <button
              className="text-button"
              onClick={() => run(() => api.Reveal(selected.id))}
            >
              <FolderOpen size={15} />
              Open folder
            </button>
            <button
              className="icon-button"
              aria-label="Archive session (keeps files)"
              disabled={pending}
              onClick={async () => {
                await run(() => api.Archive(selected.id));
                update({ selected: "" });
              }}
            >
              <Archive size={16} />
            </button>
          </div>
          {(error || selected.error) && (
            <div className="detail-error" role="status">
              <TriangleAlert size={16} />
              {error || selected.error}
            </div>
          )}
          <div
            className="detail-tabs"
            role="tablist"
            aria-label="Session views"
          >
            {[
              "Conversation",
              "Canvas",
              "Activity",
              "Changes",
              "Context",
              "Output",
            ].map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={nav.tab === tab}
                onClick={() => update({ tab })}
              >
                {tab}
              </button>
            ))}
          </div>
          <div
            className="detail-content"
            key={selected.id + nav.tab}
            ref={(el) => {
              if (el && el.dataset.restored !== "yes") {
                el.scrollTop = nav.scroll[selected.id + nav.tab] || 0;
                el.dataset.restored = "yes";
              }
            }}
            onScroll={(e) => {
              const key = selected.id + nav.tab;
              const top = e.currentTarget.scrollTop;
              setNav((n) => ({ ...n, scroll: { ...n.scroll, [key]: top } }));
            }}
          >
            {nav.tab === "Canvas" && (
              <SessionCanvas
                projectId={selected.projectId}
                sessionId={selected.id}
                events={history[selected.id] || []}
              />
            )}
            {nav.tab === "Conversation" && (
              <>
                <div className="session-intro">
                  <Leaf size={17} />
                  <span>A new idea has a place to grow.</span>
                </div>
                <Conversation events={history[selected.id] || []} />
                {data.approvals
                  .filter((a) => a.sessionId === selected.id)
                  .map((a) => (
                    <ApprovalCard
                      key={a.id}
                      approval={a}
                      disabled={pending}
                      answer={(r) => run(() => api.Respond(r))}
                    />
                  ))}
                {active(selected.state) && selected.state !== "waiting" && (
                  <div className="live-activity">
                    <span className="activity-pulse" />
                    {selected.activity}
                  </div>
                )}
              </>
            )}
            {nav.tab === "Activity" && (
              <div className="activity-list">
                {(history[selected.id] || [])
                  .filter(
                    (e) => !["delta", "output", "provider_id"].includes(e.kind),
                  )
                  .map((e) => (
                    <div key={e.sequence}>
                      <span className="timeline-dot" />
                      <div>
                        <strong>{e.approval?.title || e.text || e.kind}</strong>
                        <small>
                          {new Date(e.time).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </small>
                      </div>
                    </div>
                  ))}
              </div>
            )}
            {nav.tab === "Output" && (
              <>
                <p className="help">
                  Command output is shown here when the provider exposes it.
                  Authentication details and raw protocol messages are not
                  logged.
                </p>
                <pre className="output">
                  {(history[selected.id] || [])
                    .filter((e) => e.kind === "output")
                    .map((e) => e.text)
                    .join("")
                    .slice(-128 * 1024) || "No command output yet."}
                </pre>
              </>
            )}
            {nav.tab === "Context" && (
              <>
                <div className="context-summary">
                  <GitBranch size={17} />
                  <div>
                    <strong>{selected.branch || "Project folder"}</strong>
                    <small>{selected.cwd}</small>
                  </div>
                </div>
                <div className="permission-note">
                  <strong>Access & permissions</strong>
                  <p>{selected.capabilities.sandbox}</p>
                  <p>
                    Attached context is not an access boundary. Provider and
                    organization policies still apply.
                  </p>
                </div>
                <ContextEditor
                  items={selected.context}
                  save={(items) =>
                    run(async () => {
                      await api.Context(selected.id, items, false);
                      return true;
                    })
                  }
                />
              </>
            )}
            {nav.tab === "Changes" && (
              <ChangesView id={selected.id} run={run} />
            )}
          </div>
          {nav.tab === "Conversation" && (
            <form
              className="composer"
              onSubmit={async (e) => {
                e.preventDefault();
                const text = nav.drafts[selected.id] || "";
                const ok = await run(async () => {
                  await api.Send(selected.id, text);
                  return true;
                });
                if (ok)
                  update({ drafts: { ...nav.drafts, [selected.id]: "" } });
              }}
            >
              <textarea
                aria-label="Message agent"
                placeholder={
                  active(selected.state)
                    ? "Draft your next thought…"
                    : "What’s your next thought?"
                }
                value={nav.drafts[selected.id] || ""}
                onChange={(e) =>
                  update({
                    drafts: { ...nav.drafts, [selected.id]: e.target.value },
                  })
                }
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div>
                <span>
                  {active(selected.state)
                    ? "Send when this turn finishes, or stop it first."
                    : "Context changes apply to your next message."}
                </span>
                <button
                  className="send"
                  aria-label="Send message"
                  disabled={
                    pending ||
                    active(selected.state) ||
                    !(nav.drafts[selected.id] || "").trim()
                  }
                >
                  <ArrowUp size={20} />
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {modal === "launch" && (
        <Modal
          error={error}
          title="Give an idea a little room."
          onClose={() => setModal("")}
        >
          <LaunchForm
            data={data}
            project={nav.project}
            pending={pending}
            add={() => run(() => api.AddProject())}
            submit={async (r) => {
              const s = await run(() => api.Launch(r));
              if (s) {
                setModal("");
                select(s.id);
              }
            }}
          />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          error={error}
          title="Make yourself at home."
          onClose={() => setModal("")}
          wide
        >
          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="theme-options">
              {[
                ["light", Sun],
                ["dark", Moon],
                ["system", Monitor],
              ].map(([value, Icon]) => {
                const I = Icon as typeof Sun;
                return (
                  <button
                    key={String(value)}
                    className={nav.theme === value ? "chosen" : ""}
                    onClick={() => update({ theme: String(value) })}
                  >
                    <I size={22} />
                    {String(value)}
                    {nav.theme === value && <Check size={14} />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-section">
            <h3>
              Your agents{" "}
              <button
                className="text-button"
                disabled={pending}
                onClick={() => run(() => api.RefreshProviders())}
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </h3>
            <p className="help">
              Nook uses your installed agents and their existing sign-in. No API
              key is required by Nook.
            </p>
            {data.providers.map((p) => (
              <div className="provider-setting" key={p.id}>
                <span className={"provider-glyph " + p.id}>
                  {p.id === "claude" ? "✳" : "◈"}
                </span>
                <div>
                  <strong>
                    {p.name}
                    <span
                      className={p.available ? "installed" : "not-installed"}
                    >
                      {p.available ? "Found" : "Setup needed"}
                    </span>
                  </strong>
                  <small>{p.problem || p.version}</small>
                  <small className="path">{p.path}</small>
                </div>
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() => run(() => api.ChooseExecutable(p.id))}
                >
                  Locate
                </button>
              </div>
            ))}
          </div>
          <div className="settings-section">
            <h3>Keep things quiet</h3>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={nav.completionNotifications}
                onChange={(e) =>
                  update({ completionNotifications: e.target.checked })
                }
              />
              Notify me when a turn completes
            </label>
            <p className="help">
              Questions and failures notify you when Nook is unfocused. Quitting
              stops your agents and saves their sessions.
            </p>
          </div>
          <div className="settings-footer">
            <Leaf size={18} />
            Nook 0.1.0 · Development preview
            <br />
            Platform and account validation is in progress.
          </div>
        </Modal>
      )}
      {modal === "project-context" && project && (
        <Modal
          error={error}
          title={project.name + " · Context"}
          onClose={() => setModal("")}
        >
          <p className="help">
            Defaults for new sessions. Existing agents keep their own
            assignments.
          </p>
          <ContextEditor
            items={project.context}
            save={(items) =>
              run(async () => {
                await api.Context(project.id, items, true);
                return true;
              })
            }
          />
        </Modal>
      )}
      {modal === "rename" && selected && (
        <Modal
          error={error}
          title="Give your agent a name"
          onClose={() => setModal("")}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const title = new FormData(e.currentTarget).get(
                "title",
              ) as string;
              const ok = await run(async () => {
                await api.Rename(selected.id, title);
                return true;
              });
              if (ok) setModal("");
            }}
          >
            <label>
              Name
              <input
                name="title"
                defaultValue={selected.title}
                maxLength={120}
                required
              />
            </label>
            <button className="primary" disabled={pending}>
              Save name
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Conversation({ events }: { events: SessionEvent[] }) {
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
function ApprovalCard({
  approval: a,
  answer,
  disabled,
}: {
  approval: Approval;
  answer: (r: Parameters<typeof api.Respond>[0]) => Promise<unknown>;
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
function LaunchForm({
  data,
  project,
  pending,
  submit,
  add,
}: {
  data: Snapshot;
  project: string;
  pending: boolean;
  submit: (r: Parameters<typeof api.Launch>[0]) => Promise<void>;
  add: () => Promise<unknown>;
}) {
  const [pid, setPid] = useState(
      project === "all" ? data.projects[0]?.id || "" : project,
    ),
    [provider, setProvider] = useState(
      data.providers.find((p) => p.available)?.id || "codex",
    ),
    [shared, setShared] = useState(false);
  const p = data.projects.find((p) => p.id === pid);
  useEffect(() => {
    if (!pid && data.projects[0]) setPid(data.projects[0].id);
  }, [data.projects, pid]);
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit({
          projectId: pid,
          provider,
          title: String(f.get("title") || ""),
          prompt: String(f.get("prompt") || ""),
          shared,
        });
      }}
    >
      <p className="modal-subtitle">
        Pick a collaborator. Point them toward something worth doing.
      </p>
      <label>
        Project
        <select value={pid} onChange={(e) => setPid(e.target.value)} required>
          <option value="" disabled>
            Choose a project
          </option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {!data.projects.length && (
        <button type="button" className="secondary" onClick={add}>
          <Plus size={15} />
          Open a project
        </button>
      )}
      <label>Agent</label>
      <div className="agent-picker">
        {data.providers.map((p) => (
          <button
            type="button"
            key={p.id}
            className={provider === p.id ? "chosen" : ""}
            disabled={!p.available}
            onClick={() => setProvider(p.id)}
          >
            <span className={"provider-glyph " + p.id}>
              {p.id === "claude" ? "✳" : "◈"}
            </span>
            <strong>{p.name}</strong>
            <small>
              {p.available
                ? "Your installed agent"
                : "Setup needed in Settings"}
            </small>
            {provider === p.id && <Check size={16} />}
          </button>
        ))}
      </div>
      <label>
        What are we working on?
        <textarea
          name="prompt"
          rows={4}
          placeholder="Describe an idea, ask a question, or hand over a task…"
          required
          maxLength={100000}
        />
      </label>
      <label>
        A name for this task <span className="optional">optional</span>
        <input
          name="title"
          placeholder="A short name to find it later"
          maxLength={120}
        />
      </label>
      {p?.git ? (
        <div className="worktree-choice">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={!shared}
              onChange={(e) => setShared(!e.target.checked)}
            />
            Give this agent a separate worktree
          </label>
          <p>
            {shared
              ? "Agents in the shared folder can edit the same files at the same time."
              : "Starts from the current committed HEAD. Uncommitted edits are not copied. Your original folder stays separate."}
          </p>
        </div>
      ) : (
        <p className="help">
          This agent will use the project folder. Concurrent agents can edit the
          same files.
        </p>
      )}
      <p className="help">
        Opening an agent trusts this project’s provider configuration, hooks,
        and instructions. Review unfamiliar projects first.
      </p>
      <button
        className="primary full"
        disabled={
          pending ||
          !pid ||
          !data.providers.some((p) => p.id === provider && p.available)
        }
      >
        {pending ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Plus size={17} />
        )}
        Let’s get started
      </button>
    </form>
  );
}
function ContextEditor({
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
function ChangesView({
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
