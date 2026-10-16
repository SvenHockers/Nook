// Explicitly simulated records. Never merged into runtime snapshots or sent to native commands.
import type { Evidence, Source } from "../canvas/model";
import type { LoopDefinition, LoopRun, Workflow } from "./model";
export const sampleSource: Source = {
  projectId: "sample-project",
  id: "sample-workflow",
  revision: "sample-r3",
  permissionScope: "sample-only",
};
const evidence = (id: string, data: Evidence["data"]): Evidence => ({
  id,
  data,
  projectId: sampleSource.projectId,
  sourceId: sampleSource.id,
  revision: sampleSource.revision,
  timestamp: "2026-10-16T08:30:00Z",
  attribution: "sample",
});
export const sampleEvidence: Evidence[] = [
  evidence("checks-1", {
    kind: "tests",
    checks: [{ name: "Unit tests", result: "failed" }],
  }),
  evidence("checks-2", {
    kind: "tests",
    checks: [{ name: "Type checking", result: "failed" }],
  }),
  evidence("checks-3", {
    kind: "tests",
    checks: [
      { name: "Unit tests", result: "passed" },
      { name: "Integration tests", result: "running" },
      { name: "Lint", result: "passed" },
    ],
  }),
  evidence("api-contract", {
    kind: "text",
    text: "Sample API contract, revision 3. The review task receives the documented request and response shapes; no source files are changed by this example.",
  }),
  evidence("handoff", {
    kind: "edges",
    edges: [
      {
        from: "API contract",
        to: "Security review",
        relation: "handoff · api-contract@r3",
      },
      {
        from: "Sign-in interface",
        to: "Security review",
        relation: "depends_on",
      },
    ],
  }),
  evidence("timeline", {
    kind: "table",
    columns: ["Time", "Task", "Event"],
    rows: [
      ["08:20", "API", "Started"],
      ["08:21", "Interface", "Started in parallel"],
      ["08:30", "Review", "Awaiting both contributors"],
    ],
  }),
];
export const sampleWorkflow: Workflow = {
  id: "sample-workflow",
  goal: "A welcoming, secure sign-in",
  checkpoint:
    "Applying changes requires review of both outputs. This example has no actionable approval request.",
  state: "running",
  tasks: [
    {
      id: "api",
      title: "API contract",
      owner: 0,
      state: "running",
      agentState: "working",
      dependsOn: [],
      acceptance: "Document the authentication request and error responses.",
      context: ["Authentication notes"],
      artifactIds: ["api-contract"],
    },
    {
      id: "ui",
      title: "Sign-in interface",
      owner: 3,
      state: "running",
      agentState: "working",
      dependsOn: [],
      acceptance: "Keyboard-accessible sign-in with clear error recovery.",
      context: ["Design system"],
      artifactIds: [],
    },
    {
      id: "review",
      title: "Security review",
      owner: 2,
      state: "blocked",
      agentState: "idle",
      dependsOn: ["api", "ui"],
      acceptance: "Review both outputs before requesting human approval.",
      context: ["API contract", "Threat model"],
      artifactIds: ["handoff"],
    },
  ],
  history: [
    { time: "08:20", text: "Clio began the API contract." },
    { time: "08:21", text: "Sunny began the interface in parallel." },
    {
      time: "08:30",
      text: "Draft contract r3 passed to Vale. Review awaits both tasks.",
    },
  ],
  handoffs: [
    {
      from: "api",
      to: "review",
      artifactId: "api-contract",
      revision: "r3",
      time: "08:30",
    },
  ],
};
export const sampleDefinition: LoopDefinition = {
  id: "repair-ci",
  objective: "Repair CI failures",
  trigger: "manual",
  maxAttempts: 5,
  verification: ["Unit tests", "Integration tests", "Lint"],
  approval: "Human review before applying changes",
};
export const sampleRun: LoopRun = {
  id: "sample-run-14",
  label: "Run #14",
  activity: "Clio is idle while external verification runs.",
  definitionId: "repair-ci",
  state: "running",
  owner: 0,
  agentState: "idle",
  attempts: [
    {
      number: 1,
      phase: "decide",
      outcome: "failed",
      timestamp: "08:10",
      checks: [
        { name: "Unit tests", result: "failed", evidenceId: "checks-1" },
      ],
      note: "Unit checks failed. Retry permitted by the sample policy.",
    },
    {
      number: 2,
      phase: "decide",
      outcome: "failed",
      timestamp: "08:20",
      checks: [
        { name: "Type checking", result: "failed", evidenceId: "checks-2" },
      ],
      note: "Compilation failed. Retry permitted by the sample policy.",
    },
    {
      number: 3,
      phase: "verify",
      outcome: "running",
      timestamp: "08:30",
      checks: [
        { name: "Unit tests", result: "passed", evidenceId: "checks-3" },
        {
          name: "Integration tests",
          result: "running",
          evidenceId: "checks-3",
        },
        { name: "Lint", result: "passed", evidenceId: "checks-3" },
      ],
      note: "External verification is running. The responsible agent is idle.",
    },
  ],
};
