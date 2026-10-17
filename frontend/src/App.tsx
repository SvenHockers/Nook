import { Conversation } from "./features/sessions/Conversation";
import { ApprovalCard } from "./features/sessions/ApprovalCard";
import { LaunchForm } from "./features/sessions/LaunchForm";
import { ContextEditor } from "./features/context/ContextEditor";
import { ChangesView } from "./features/sessions/ChangesView";
import { Modal } from "./shared/Modal";
import { workflowAttention } from "./features/work/attention";
import { LiveWorkflows } from "./features/work/LiveWorkflows";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
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
  Archive,
  RefreshCw,
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
import { VerificationPanel } from "./features/checks/VerificationPanel";
import { SessionCanvas } from "./features/canvas/PresentationCanvas";
import {
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
export function App() {
  const [data, setData] = useState(empty),
    [nav, setNav] = useState<Nav>(initial),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [modal, setModal] = useState(""),
    [pending, setPending] = useState(false),
    [history, setHistory] = useState<Record<string, SessionEvent[]>>({});
  const [workflowFocus, setWorkflowFocus] = useState<{
    workflowId: string;
    taskId: string;
  }>();
  const taskAttention = workflowAttention(data);
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
    if (nav.completionNotifications) {
      for (const item of workflowAttention(data)) {
        const key = `workflow:${item.key}`;
        if (!notified.current.has(key)) {
          notified.current.add(key);
          if (!document.hasFocus())
            api.Notify(`Nook · ${item.title}`, item.reason).catch(() => {});
        }
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
              .length +
              taskAttention.length >
              0 && (
              <span className="count attention-count">
                {data.sessions.filter((s) => !s.archived && needsAttention(s))
                  .length + taskAttention.length}
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
            <LiveWorkflows
              key={
                workflowFocus
                  ? `${workflowFocus.workflowId}:${workflowFocus.taskId}`
                  : "workflows"
              }
              initial={workflowFocus}
              data={data}
              refresh={refresh}
              openSession={select}
            />
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
                {nav.page === "Home" && (
                  <img className="home-mascot" src="/mascot.png" alt="" />
                )}
                <div className="page-heading-text">
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
              {nav.filter === "attention" &&
                taskAttention.filter(
                  (item) =>
                    nav.project === "all" || item.projectId === nav.project,
                ).length > 0 && (
                  <section
                    className="work-surface"
                    aria-label="Workflow attention"
                  >
                    <h2>Workflow tasks needing you</h2>
                    {taskAttention
                      .filter(
                        (item) =>
                          nav.project === "all" ||
                          item.projectId === nav.project,
                      )
                      .map((item) => (
                        <button
                          className="secondary"
                          key={item.key}
                          onClick={() => {
                            setWorkflowFocus(item);
                            update({ page: "Workflows", selected: "" });
                          }}
                        >
                          <strong>{item.title}</strong>
                          <span>
                            {item.reason} · {item.goal}
                          </span>
                        </button>
                      ))}
                  </section>
                )}
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
              <>
                <VerificationPanel
                  session={selected}
                  events={history[selected.id] || []}
                />
                <SessionCanvas
                  projectId={selected.projectId}
                  sessionId={selected.id}
                  provider={selected.provider}
                  events={history[selected.id] || []}
                />
              </>
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
