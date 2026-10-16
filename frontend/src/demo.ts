import { createWorkflowDemo } from "./features/work/demoWorkflow";
import type {
  API,
  Snapshot,
  Session,
  SessionEvent,
  Capabilities,
} from "./types";
const caps: Capabilities = {
  resume: true,
  interrupt: true,
  approvals: true,
  questions: true,
  sandbox: "Provider-managed permissions",
};
export function createDemo(onChange: () => void): API {
  const projects = ["Nook", "Studio website", "Research notes"].map(
    (name, i) => ({
      id: "p" + i,
      name,
      path: "/demo/" + name.toLowerCase().replaceAll(" ", "-"),
      git: i < 2,
      context: [],
    }),
  );
  const titles = [
    "Give onboarding a warmer welcome",
    "Explore a simpler navigation",
    "Review the accessibility basics",
    "Bring the new homepage to life",
    "Find the story in our interviews",
    "Tidy up the settings experience",
    "Check our release checklist",
    "Build a better search",
    "Summarize the landscape",
    "Polish the empty states",
    "Compare pricing approaches",
    "Make keyboard navigation seamless",
    "Review the latest changes",
    "Organize project references",
    "Write a friendly getting-started guide",
  ];
  const states: Session["state"][] = [
    "working",
    "waiting",
    "completed",
    "working",
    "working",
    "stopped",
    "failed",
    "working",
    "completed",
    "working",
    "stopped",
    "working",
    "waiting",
    "completed",
    "working",
  ];
  const activities = [
    "Editing the welcome screen",
    "Needs your approval",
    "Ready for your review",
    "Exploring layout options",
    "Reading interview notes",
    "Saved for later",
    "Authentication needs attention",
    "Thinking through the search flow",
    "Ready for your review",
    "Refining the small details",
    "Saved for later",
    "Checking focus order",
    "Has a question for you",
    "Ready for your review",
    "Writing the first draft",
  ];
  const sessions: Session[] = titles.map((title, i) => ({
    id: "s" + i,
    projectId: "p" + (i % 3),
    title,
    provider: i % 2 ? "claude" : "codex",
    state: states[i],
    activity: activities[i],
    error: i === 6 ? "Sign in to the installed agent and resume." : "",
    cwd: projects[i % 3].path,
    branch: "nook/demo-" + i,
    baseCommit: "abc123",
    isolated: i % 3 < 2,
    providerId: "demo-" + i,
    avatar: { shape: i % 5, color: i % 6, name: title },
    context: [],
    createdAt: new Date(Date.now() - i * 120000).toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    seen: false,
    capabilities: caps,
  }));
  const data: Snapshot = {
    workflows: [],
    projects,
    sessions,
    providers: [
      {
        id: "codex",
        name: "Codex",
        path: "/demo/codex",
        version: "Demo provider",
        available: true,
        problem: "",
        capabilities: caps,
      },
      {
        id: "claude",
        name: "Claude Code",
        path: "/demo/claude",
        version: "Demo provider",
        available: true,
        problem: "",
        capabilities: caps,
      },
    ],
    approvals: [
      {
        id: "a1",
        sessionId: "s1",
        kind: "approval",
        title: "Run the navigation tests?",
        detail: "npm run test -- navigation",
        questions: [],
        decisions: ["accept", "decline"],
      },
      {
        id: "a2",
        sessionId: "s12",
        kind: "question",
        title: "Which approach feels right?",
        detail: "",
        questions: [
          {
            id: "approach",
            text: "Should the review include documentation?",
            options: ["Include documentation", "Code only"],
            multi: false,
          },
        ],
        decisions: ["answer", "cancel"],
      },
    ],
    problem: "",
  };
  let seq = 0;
  const events: SessionEvent[] = sessions.flatMap((s) => [
    {
      sequence: ++seq,
      sessionId: s.id,
      kind: "user",
      text: s.title,
      itemId: "u" + s.id,
      time: s.createdAt,
    },
    {
      sequence: ++seq,
      sessionId: s.id,
      kind: "delta",
      text: "I’ll start by understanding the project and the patterns already in place. Then I’ll make a focused change and check the result.",
      itemId: "m" + s.id,
      time: s.updatedAt,
    },
  ]);
  const get = (id: string) => {
    const s = sessions.find((s) => s.id === id);
    if (!s) throw Error("Session not found");
    return s;
  };
  const push = (id: string, kind: string, text: string) => {
    events.push({
      sequence: ++seq,
      sessionId: id,
      kind,
      text,
      itemId: "m" + seq,
      time: new Date().toISOString(),
    });
    onChange();
  };
  const workflow = createWorkflowDemo(
    sessions,
    events,
    (r) => api.Launch(r),
    onChange,
    (id) => {
      const session = get(id);
      if (session.state !== "working") return;
      session.state = "completed";
      session.activity = "Demo output ready to review";
      push(
        id,
        "delta",
        "Simulated workflow output. No files changed and no checks were run.",
      );
      push(id, "completed", "Demo turn complete");
    },
  );
  const api: API = {
    ...workflow.api,
    Snapshot: async () =>
      structuredClone({ ...data, workflows: workflow.snapshot() }),
    AddProject: async () => projects[0],
    Launch: async (r) => {
      const s: Session = {
        ...sessions[0],
        id: "s" + sessions.length,
        title: r.title || r.prompt,
        projectId: r.projectId,
        provider: r.provider,
        state: "working",
        avatar: {
          shape: sessions.length % 5,
          color: sessions.length % 6,
          name: r.title || r.prompt,
        },
        createdAt: new Date().toISOString(),
      };
      sessions.push(s);
      push(s.id, "user", r.prompt);
      return structuredClone(s);
    },
    Send: async (id, text) => {
      const s = get(id);
      s.state = "working";
      s.activity = "Working on your task";
      push(id, "user", text);
      setTimeout(() => {
        s.state = "completed";
        s.activity = "Ready for your review";
        push(
          id,
          "delta",
          "This is a demo response. Your real agents run inside the desktop app.",
        );
        push(id, "completed", "Turn complete");
      }, 500);
    },
    Stop: async (id) => {
      get(id).state = "stopped";
      data.approvals = data.approvals.filter((a) => a.sessionId !== id);
      onChange();
    },
    Respond: async (r) => {
      data.approvals = data.approvals.filter((a) => a.id !== r.requestId);
      get(r.sessionId).state = "working";
      push(r.sessionId, "resolved", r.decision);
    },
    Events: async (id, after) =>
      structuredClone(
        events
          .filter((e) => e.sessionId === id && e.sequence > after)
          .slice(0, 1000),
      ),
    RefreshProviders: async () => data.providers,
    ChooseExecutable: async () => {},
    Context: async (id, items, project) => {
      if (project) {
        projects.find((p) => p.id === id)!.context = items as never[];
      } else get(id).context = items;
      onChange();
    },
    ChooseContext: async () => "/demo/reference.md",
    Archive: async (id) => {
      get(id).archived = true;
      onChange();
    },
    Rename: async (id, title) => {
      get(id).title = title;
      onChange();
    },
    Changes: async () => ({
      status: " M src/welcome.tsx\n?? notes.md",
      diff: "diff --git a/src/welcome.tsx b/src/welcome.tsx\n--- a/src/welcome.tsx\n+++ b/src/welcome.tsx\n@@ -1 +1 @@\n-<h1>Dashboard</h1>\n+<h1>A little space for big ideas.</h1>",
      truncated: false,
    }),
    ExportPatch: async () => "",
    Reveal: async () => {},
    Notify: async () => {},
    Navigation: async () => sessionStorage.getItem("nook-demo-nav") || "",
    SaveNavigation: async (v) => {
      sessionStorage.setItem("nook-demo-nav", v);
    },
  };
  return api;
}
