# Implementation plan: from the Rust runtime and Presentation Agent to a first release

Written 2026-10-16 from a read-through of the code and every document in the repository. It records what is and is not implemented, where the documentation is out of date, and the phases that follow. Sizes are rough guesses for one developer pairing with Claude Code (S is days, M one to two weeks, L two to four), not commitments.

## Implementation progress — 2026-10-16

First Phase 0 slice implemented locally:

- **0.1 (partial):** ignored `.claude/worktrees/`. Existing uncommitted migration preserved; no branch publication or remote CI run performed in this slice.
- **0.2 (partial):** replaced the deleted Go runtime's commands in both GitHub workflows with Rust tests/builds. Main CI now formats, tests and lints the backend, and caches both Rust projects. Native validation runs the Rust `nook-check` binary.
- **0.5 (partial):** smoke test reads all 23 desktop `METHODS`, checks that each reaches the backend, creates a persisted workflow, validates the presentation request path, and shuts down. Fixed unknown commands with empty arguments incorrectly returning `Missing argument`, which would hide missing dispatch entries. Added a successful standard-presentation stdio regression test. Golden Rust/TypeScript fixtures were completed in Phase 2.
- **0.6 (partial):** stopping/archiving a terminal session preserves its outcome and activity; active sessions still stop. Regression coverage includes all seven states and persistence across reopening. The unused `seen` field and other housekeeping remain outstanding.
- IPC request accounting now uses `OnDrop`, so a request panic releases the shutdown wait.

Validation on macOS: 53 backend tests passed, followed by the newly added standard-presentation stdio test (54 total); backend format and Clippy checks passed; frontend type checking and 23 unit tests passed; expanded sidecar smoke test passed. The hook test needed loopback access outside the filesystem sandbox. No live provider, Windows, packaged desktop or remote CI claim is made here.

**Baseline correction:** this checkout still uses `tiny_http`; it does not contain the hand-written hook parser described below. The initial snapshot and test counts below are historical observations from the planning session, not the current checkout. Parser-specific Phase 0.3 work must be reconciled before implementation.

### Streamlining pass — 2026-10-16

- Extracted session conversation, approval, launch and changes components, the context editor, and the shared modal from `App.tsx` (1,740 → 1,227 lines).
- Split the 2,237-line stylesheet into five ordered files; the entry point preserves the original rule order and declarations.
- Removed unused `Session.seen` from Rust, TypeScript and demo data. The existing legacy-storage test now includes this retired field to verify backward compatibility.
- Removed the unreferenced `scripts/package-macos.mjs`; Tauri remains the packaging path.
- Enabled TypeScript unused-local/parameter checks and removed stale imports.
- Stabilized the Canvas contrast audit by disabling transitions for the audit and waiting for the selected theme.

Backend tests (54), frontend unit tests (23), production build, and backend Clippy passed. Browser verification initially passed 35/36 cases; the remaining theme-transition timing failure was addressed in the audit itself and passed three consecutive runs in each browser (6/6). This is structural cleanup; the remaining implementation phases retain their original scope.

### Phase 1 implementation — 2026-10-17

Implemented 1.1–1.7 locally. Handoffs keep the full bounded audit and derive at most 48 KiB of conversation/outcomes, with explicit omissions. All accepted ancestors share a 128 KiB serialized reference budget; goals, briefs and rejection feedback fit within the 256 KiB launch limit. Accepted Git artifacts freeze HEAD, Changes and diff stat; acceptance checks both event revision and inspected code identity. No patch is applied automatically.

Reject preserves an attempt and prepares a fresh, manually started session. Cancellation persists its gate before stopping active sessions, and canceled/archived workflows cannot resume through the generic session command. Draft editing, archival, attempt inspection, acceptance/failure attention items and opt-in workflow notifications are wired through the backend, native map and browser simulator. Live and example workflow models share state/task contracts; example-only presentation fields remain separate.

Validation: 60 backend tests (plus one opt-in live test), 25 frontend unit tests, 40 Chromium/WebKit cases, backend Clippy, frontend production build, Tauri check, and the 27-command sidecar smoke guard passed on macOS. The real Codex 0.162.1 two-task check passed using the signed-in account in disposable Git worktrees, without tools or file changes. See `docs/VALIDATION.md` and `docs/validation/workflow-codex.json`.

**Remaining exit gate:** the live run above exercises the runtime through IPC with programmatic review of exact output, not a person completing the workflow in an installed native app. Manual native acceptance, Windows, and real Claude approval validation remain unclaimed. Phase 2 was subsequently authorized and implemented below.

## 1. Baseline this plan describes

The Rust rewrite and the Presentation Agent are not on the remote. `origin/main` holds only `9adfdd1 project init`, and that is all GitHub has ever built.

| Where | What it holds |
|---|---|
| `origin/main` = local `main` HEAD (`9adfdd1`) | The Go-era project. |
| Working tree on `main` (uncommitted, about 60 paths) | Go runtime deleted, `backend/` (Rust) added, updated docs, frontend, new icons and mascot. **This is the baseline the plan describes.** |
| branch `presentation-agent` (`e1fa2da`) | Two commits: `8cc8c1f` Rewrite the backend sidecar in Rust, `e1fa2da` Add the Presentation Agent. |
| branch `worktree-rust-backend` (`8cc8c1f` plus uncommitted edits) | The hook-server rewrite (below). |

The working tree equals `presentation-agent` plus four things, found by diffing ignoring line endings:

1. `tiny_http` was dropped and the Claude permission-hook server in `backend/src/provider/claude.rs` is now a hand-written loopback HTTP parser (`read_head`, `hook`). A new test, `request_heads_are_bounded`, covers it, which is why the test count is 51, not the 50 the docs record.
2. `ipc.rs` releases the shutdown wait through `OnDrop`, so a panicking request cannot hang `Shutdown`.
3. Mascot, favicon and regenerated `src-tauri/icons/*` (raster art; see decision D6).
4. A Home-page mascot layout tweak in `App.tsx` and `style.css`.

Status words used below: **Done** (works end to end against real data), **Partial**, **Sample only** (UI over fixtures, no backend), **Not started**.

## 2. Status by area

| Area | Status | Evidence | Remaining gap |
|---|---|---|---|
| Desktop shell | Done | `src-tauri/src/main.rs`: 23-method allowlist, 90 s call limit, Shutdown on exit, no raw stderr forwarded. | No tests in `src-tauri`; package builds exist only in CI. |
| Runtime core (IPC, process supervision, SQLite, Git) | Done | Rust port is complete. Every Go test has a Rust counterpart (the two RingBuffer tests left with a type Go never read). | Verified on Windows with the GNU toolchain only (per `VALIDATION.md`). The macOS code paths (`process.rs` `bsd_info`, process groups) and MSVC have never been compiled by anyone but CI, and CI has not run them. |
| Providers: Codex (app-server), Claude (stream-json, HTTP hooks, MCP permission host) | Done, not validated | Adapters and fixture-agent tests exist. | No real approval or question flow validated with either provider. Codex re-run on the Rust runtime pending. Claude route blocked on sign-in. The new hook parser postdates the last recorded test run. |
| Sessions, approvals, context, changes, patch export, archive | Done | Matches the docs. | `Session.seen` is written and never read (G9). Archiving flips a completed session to stopped (G8). |
| Persistence | Done | SQLite `user_version=3`: projects, sessions, events, settings, workflows, workflow_artifacts, presentations. Newer DBs refused; v1→v3 migration tested. | Docs still say schema v1. |
| **Workflows** | **Partial (live, manual)** | Create, start, inspect evidence, accept. DAG validation, optimistic `revision`, atomic commit, one winner under races, evidence frozen at acceptance. UI is `LiveWorkflows` with a labelled example beneath. 7 backend tests, 1 e2e. | Docs say examples only. No reject, retry, cancel, edit or archive. Handoff carries conversation only (G3 to G7). |
| **Presentation Agent** | **Done for Claude, text only** | `presentation.rs` (pure boundary), `workspace/presentation.rs`, `provider/present.rs`. Tool-less one-shot `claude --print`, validated, cached per revision/scope/provider/focus, cancellable, 75 s limit. 22 Rust tests, 11 canvas unit tests, 5 e2e. | Codex not arranged. Only the 4 text components are reachable from real data. Workflow handoffs not arrangeable. Rules duplicated in Rust and TS (G10). |
| Canvas (Visual/Chat/Raw) | Done for text | `EvidenceView` renders all six evidence kinds. The catalog has 13 components. | Nothing in the backend produces metric, table, series, tests or edges evidence (grep confirms), so those render only from fixtures. |
| Loops | **Sample only** | Types in `features/work/model.ts`, fixtures, `LoopWorkspace` behind a "not connected" gate. No `Loop*` symbol anywhere in `backend/` or `src-tauri/`. | Everything (Phase 4). Docs are accurate here. |
| Home, Agents, Context, Activity, avatar playground | Done | Wired to snapshot and native commands. | Mascot branding undocumented. |
| Global search, deep links | Not started | `Cmd/Ctrl+K` only focuses the Agents filter. Docs list both as pending. | Phase 5. |
| CI, packaging, validation | Partial | Exactly one GitHub run exists, on `project init`: macOS-15 passed the whole pipeline, Windows-2025 failed at "Go checks and process contract tests". No run has ever built the Rust code. | Phase 0 and Track R. |

## 3. Documentation that no longer matches the code

Nothing below is edited by this plan. It is the work list for Phase 0.

| File | Says | Reality |
|---|---|---|
| `README.md` ("UI handoff implementation") | "Workflows and Loops currently provide … examples, not live orchestration." | Workflows are live: persisted, dependency-gated, started and accepted by a person. Loops are examples. "What works" never mentions workflows. |
| `docs/UI_IMPLEMENTATION.md` | "Preserve the existing Tauri → Rust → Go runtime"; "Preserved the Tauri/Rust/Go process …". | Sidecar is Rust. Go is deleted. |
| same | Integration table: "Workflow and loop workspaces: Inspection examples only; no scheduler, execution …". | True for loops. Workflows have explicit start and acceptance commands. |
| same | "Next vertical slice: persist workflow definitions/tasks and immutable artifacts in the Go store, expose … commands through Rust, then replace the example adapter." | Already done (Go first, then ported). Replace with Phase 1. |
| same | "Validation recorded on macOS ARM64 … `go test ./...`: passed" and "No backend wire commands … or persisted database schemas were changed." | Historical, from before the port. Label it as such. |
| `docs/ARCHITECTURE.md` | "SQLite schema version 1 stores projects, sessions, globally ordered events, and navigation settings." | Version 3. Add workflows, workflow_artifacts, presentations. |
| same | "There is no workflow/loop execution command or implicit scheduler." | Workflows have `StartWorkflowTask` and `AcceptWorkflowTask`. Loops have none. |
| same | "fixtures live only in `features/work/fixtures.ts`". | Also `demoWorkflow.ts` and `demoPresent.ts` (browser-only simulators). |
| same | (absent) | No description of the workflow runtime: acceptance semantics, artifact immutability, the 1 MB / 10,000-event evidence cap, the 256 KB prompt cap. |
| `docs/VALIDATION.md` | CI paragraph: "authored but cannot be claimed green before a remote run." | One remote run exists and failed on Windows in the Go step. No Rust run. Add rows for workflows, the Presentation Agent and the hook parser. |
| same / `UI_IMPLEMENTATION.md` | "`cargo test` passed 50 tests". | 51 in the tree. |
| `THIRD_PARTY_NOTICES.md` | "All Nook character SVGs and the application icon are original code-authored assets." | The app icon and Home mascot are now raster art (`docs/appIconAndMascotte/`, `frontend/public/`). Provenance is not recorded (D6). |

## 4. Gaps and defects found while cross-referencing

Severity is my judgment. "Read" means found by reading code, not reproduced.

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| G1 | High | None of the Rust or Presentation work is pushed, and no CI has built it. | 0 |
| G2 | High | The hand-written HTTP hook parser sits on the Claude permission path. It reads `Content-Length` only, so a chunked request becomes length 0 and is answered 400. That fails closed, but would break approvals if the real client ever chunks. Untested against real Claude 2.1.295 or newer. | 0, R |
| G3 | High | Handoff size mismatch. Acceptance allows evidence up to 1 MB / 10,000 events (`workflow_evidence`), but `start_workflow_task` refuses any prompt over 256 KB. Accepted tasks cannot be restarted and artifacts are immutable, so a verbose upstream task can leave its dependents unstartable. Evidence also includes every event kind, not just conversation. | 1 |
| G4 | High | Handoff carries no code. Dependents start from the project's committed HEAD, not from the upstream worktree, and the artifact holds no diff or commit. The UI admits "Files are not merged between worktrees." | 1 |
| G5 | Med | The workflow goal is shown in the UI but never sent to an agent (`start_workflow_task` sends `t.prompt` plus upstream evidence). | 1 |
| G6 | Med | No reject, retry, cancel, archive or edit. Backend `project()` never emits `failed` or `canceled` for a workflow, though the sample TS model has them. Live and sample TS types (`WorkflowRecord`, `Workflow`) diverge. | 1 |
| G7 | Med | A task waiting for human acceptance is not an attention item or notification. `needsAttention` looks only at session state. | 1 |
| G8 | Low | Read: `archive` calls `stop`, which sets `stopped` unconditionally, so archiving a completed workflow session blocks acceptance (needs `completed`) until the person sends another message, which also un-archives it. | 0 |
| G9 | Low | `Session.seen` is set false on completion and never read or cleared, so "ready to review" cannot clear. | 0 |
| G10 | Med | Evidence rules exist twice (`presentation.rs::build_evidence`, `model.ts::buildEvidence`), as do the standard layout and cache key. Nothing enforces that they agree. | 0, 2 |
| G11 | Med | The Tauri allowlist (`METHODS`) and the backend `dispatch` are equal today (23 and 23) by hand. No test enforces it. | 0 |
| G12 | Med | `sidecar-smoke.mjs` exercises `Snapshot`, `SaveNavigation`, `Navigation`, `Shutdown` only. | 0 |
| G13 | Low | The open session polls events every 700 ms on top of an event-triggered full `Snapshot` (all sessions, workflows, providers re-serialised per change). Probably fine at 15 cards; the sustained-load gate is unrun. | 5 |
| G14 | Low | `App.tsx` is 1,740 lines and `style.css` 2,237. `scripts/package-macos.mjs` is referenced by nothing. `.claude/` is untracked and not ignored. `build-sidecar.mjs` accepts only the Apple and MSVC targets, and this Windows machine has neither MSVC nor a global Rust toolchain, so `npm run dev` cannot run here. | 0, 5 |

## 5. Principles that stay fixed

Carried from the docs. Every phase below is designed inside them.

- Provider completion is not acceptance. A person accepts, bound to an inspected source revision.
- Agent prose is "agent-reported". Nook never infers test counts or metrics from it. Structured evidence comes from things Nook measured or ran.
- A model may choose which recorded evidence to show and which catalog component renders it. It cannot add content, URLs, actions or styles. The backend builds every block and validates the reply as a whole. The frontend validates again.
- Session text goes only to the provider that already holds that session.
- Unknown requests, bad authentication, timeouts and disconnects never grant approval.
- No background execution after quit, no automatic merge or worktree deletion, no telemetry, no API key requirement.
- Context assignments are knowledge, not an access boundary. Permission controls are the provider's, not OS isolation.

## 6. Phases

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 4 (Loops)
  │            └────────► Phase 3 (non-text needs 2; 3.1 and 3.2 can start after 1)
  │                       Phase 5 overlaps 3 and 4;  Phase 6 last
  └── Track R (accounts and hardware) runs alongside; R1 to R3 land before Phase 2 design
```

The critical path is 0 → 1 → 2 → 4.

### Phase 0: Consolidate and verify (S to M)

**Goal.** Everything that exists is on the remote, builds on both targets, and the docs describe it.

- [ ] 0.1 Choose one line of history and push it. Suggested: commit the `main` working tree to a feature branch, open a PR, retire `presentation-agent` and `worktree-rust-backend` once their content is in. Add `.claude/worktrees/` to `.gitignore`.
- [ ] 0.2 First CI run on the Rust code, then fix what it finds. Known unknowns: MSVC with `+crt-static` (`backend/.cargo/config.toml`), the macOS process and identity code, `cargo fmt --check`, `src-tauri` compiling with the new allowlist, WebKit e2e on the Windows runner.
- [ ] 0.3 Re-run the backend suite on the tree with the new hook parser (51 tests). Add cases for duplicate or oversized `Content-Length`, folded headers and `Expect: 100-continue`. The toolchain recipe is in project memory (`local-rust-verification`).
- [ ] 0.4 Docs pass from section 3. Move "validation recorded" blocks under dated headings so the Go-era and Rust-era records cannot be confused.
- [x] 0.5 Guards (G10 to G12):
  - Extend `sidecar-smoke.mjs` to read `METHODS` from `src-tauri/src/main.rs`, call each with empty arguments, and fail on "Unknown method". Add `CreateWorkflow` and a standard-mode `PresentSession`.
  - Golden JSON fixtures written by a Rust test and read by vitest, for the wire types and for events→evidence parity.
- [ ] 0.6 Cheap defects: G8 (archive must not change a non-active session's state), G9 (either clear `seen` when a card is opened, which needs one new command, or remove it), G14 housekeeping.

**Exit.** CI green on macos-15 and windows-2025 for the PR. No statement in section 3 remains. The smoke test fails if an allowlisted method is missing from the backend.

### Track R: Real-provider and target validation (start now; needs your accounts and machines)

These are the existing `VALIDATION.md` gates. They need no new features, and a failure here can change later designs, so R1 to R3 come before Phase 2.

- [ ] R1 Claude: sign in, `nook-check --live --provider claude` (records currently "OAuth session expired").
- [ ] R2 Real approvals and questions with both providers (`AskUserQuestion`, `ExitPlanMode`, two simultaneous approvals, cancel, expiry). This also validates G2.
- [ ] R3 Codex re-run on the Rust runtime (the recorded run used the Go runtime).
- [ ] R4 Windows 11 native: MSVC build, NSIS install including WebView2-absent.
- [ ] R5 macOS re-run of the Rust sidecar.
- [ ] R6 15 live sessions with output bursts, then the five-second attention study.
- [ ] R7 Signing and notarization credentials (Phase 6 needs them).

### Phase 1: Workflows you can trust with real work (M to L)

**Goal.** A person runs a three-task workflow on a real repository, recovers from a bad result, and hands over code, not just chat. Fixes G3 to G7.

- [x] 1.1 **Curate the handoff** (G3). Build the downstream-facing evidence from conversation and outcomes only, reusing `build_evidence`. Keep the full event list as the audit record. Show the person the size at acceptance. Cap what is sent to the next agent below the 256 KB prompt limit, with an explicit "older records omitted" marker.
- [x] 1.2 **Hand over code** (G4, decision D1). At acceptance, store `git rev-parse HEAD` of the task's worktree and a bounded diff (`Changes`) in the artifact. New optional fields with serde defaults, so the JSON-body store needs no migration. Supply the diff stat to dependents as reference data.
- [x] 1.3 **Send the goal** (G5, D2). Prefix every task prompt with it.
- [x] 1.4 **Reject and retry** (G6). Add `RejectWorkflowTask {reason}`. It either sends the reason back to the same session or starts a new one. Give a task an attempt list (session id, outcome, reason) so history survives. Accepted artifacts stay immutable. Design this once, because Loops reuse the attempt record.
- [x] 1.5 **Lifecycle** (G6). Add `CancelWorkflow` and `ArchiveWorkflow`, plus task edits before any session starts. Emit `failed` and `canceled` from `project()` and merge the live and sample TS workflow types.
- [x] 1.6 **Attention** (G7). Acceptance-pending and failed tasks appear in the attention view. Notifications follow the existing opt-in rule.
- [x] 1.7 **Tests.** An integration test through `ipc::dispatch` with `nook-fixture`: A → B → C, B rejected once then accepted, C's prompt contains A and B evidence under the limit, restart mid-run restores every state. Add e2e cases for failure and reject. There are now 3 workflow e2e cases per browser.

Every new command goes in five places: `ipc.rs` dispatch, the `METHODS` allowlist, `types.ts`, the native map in `api.ts` and the browser simulator (`demoWorkflow.ts`). The 0.5 smoke guard catches a miss in the first two.

**Exit.** The 1.7 scenario passes. A two-task workflow on a disposable repo with a real provider is run by hand and recorded in `VALIDATION.md`.

### Phase 2: Structured evidence and verification (L)

**Goal.** Replace "every native record is text" with provenance-labelled structured evidence that nothing in the model path can forge, and give Loops their verification primitive.

- [x] 2.1 **Adapters from things Nook owns.** Each is a pure function with tests, attribution `recorded`:
  - Changes → Table (`FileChangeList`) from `git diff --numstat` and status, plus Text (`CodeDiff`).
  - Session timeline → Table (`TaskTimeline`): turn start and end, approvals, durations.
  - Workflow graph and accepted artifacts → Edges (`DependencyGraph`, `HandoffTrace`).
  - Metrics Nook measures itself (counts, durations), not provider claims.
- [x] 2.2 **Verification runner** (D3). A project's configured commands (name, argv, timeout, output cap) run in the session worktree, started by a button and never by agent text. They run under the existing process supervision, so cancel and quit kill the whole tree. They record start, end, exit code, duration and truncated output as a new `check` event kind in the session stream, so ordering, revisions and audit work unchanged. Produces `Tests` evidence whose result comes from the exit code only. Parsing JUnit or TAP is a later option. This is the first feature in which Nook itself executes project code: show the exact command, confirm on first use per project, and document that it is not sandboxed.
- [x] 2.3 **Prompt and catalog.** The arranger prompt currently lists text evidence only. Extend it to each kind with its legal components, and bump `PROMPT_VERSION` or `CATALOG` (both are already in the cache key).
- [x] 2.4 **Parity.** Keep the TS mirror (the stale-view logic needs client-side evidence without a round trip) and enforce it with the 0.5 golden fixtures for every new kind.

**Exit.** A real session with code changes shows `FileChangeList` and `CodeDiff` derived from git. A configured check shows `TestReport` from the exit code. Golden tests keep Rust and TS identical. Nothing is inferred from prose.

Phase 2 implementation uses explicit **Record evidence** snapshots and project **Verification checks** in the session Canvas. Native events retain their complete structured payload; git/metrics/graphs are never regenerated for an old revision. Provider ingestion discards structured fields and rejects reserved native event kinds. Catalog and arranger prompt versions are now 2. A Rust-generated fixture verifies all six kinds, layouts, standard cache identity and UTF-8 truncation in TypeScript. Real git and native executable IPC tests cover the exit criteria; manual installed-app and Windows acceptance remain release gates.

### Phase 3: Presentation Agent v2 (M to L)

**Goal.** Extend arranging beyond one provider and one source kind, without loosening the boundary.

- [ ] 3.1 **Arrange workflow handoffs.** `PresentSession` is session-scoped. Add a source discriminator or a sibling command so an accepted artifact, which is immutable and therefore an ideal cache key, can be arranged. The frontend already uses scope `local:{project}:{workflow}`.
- [ ] 3.2 **Codex arranging** (D5). Time-boxed spike first: can the installed Codex run one-shot, tool-less, with no persistence, in an empty folder, using the existing sign-in? If yes, add the branch beside `provider::arrange`, a fixture and a live check. If no, say "Claude Code only" in the UI and docs as a standing limit.
- [ ] 3.3 **Settings-based sign-in.** `--setting-sources project` ignores user settings, so a cloud provider's environment sign-in falls back with a reason. Decide after R1 and R2 show how real users sign in: pass through named environment variables, or keep the explained fallback.
- [ ] 3.4 **Long sessions.** The view keeps the latest 200 records and the prompt the latest 60 at 1,200 characters. Add "older records" paging to the standard layout before any model-side summarising, which would break "the model cannot add content".
- [ ] 3.5 **Still deferred.** Cross-session or shared cache and json-render or A2UI interoperability. Revisit only once a planner proposes more than `{evidenceId, type}`, and then only after a licence and pinned-version review.

**Exit.** Non-text evidence is arranged and validated end to end. Workflow handoffs can be arranged and cached by artifact. Codex is either arranged and live-checked, or documented as unsupported.

### Phase 4: Loops (L)

**Entry.** The Phase 1 attempt record and the Phase 2 verification runner. The docs set the bar: implement loop execution only once retry and time budgets, human gates and verification evidence are enforceable by the backend.

- [ ] 4.1 **Model.** Mirror the types already in `features/work/model.ts` (`LoopDefinition`, `LoopRun`, `LoopAttempt`) as Rust structs. Add schema v4 with `loops` and `loop_runs` as JSON bodies plus `revision`, the workflow pattern, with a v3→v4 migration test.
- [ ] 4.2 **Engine.** One run is a state machine over discover → execute → verify → decide. An attempt is a session plus the verification runner plus a human decision (accept, retry, stop). Enforce in the backend: `maxAttempts`, per-attempt and total wall-clock limits, a concurrent-run cap. Tool approvals stay with the person throughout.
- [ ] 4.3 **Triggers** (D4). Manual only at first. Scheduled or event triggers conflict with "no background execution after quit", so if added they run only while Nook is open, and the UI says so.
- [ ] 4.4 **Commands and UI.** Add the commands in all five places listed in Phase 1. Replace the `LoopWorkspace` gate with a live page in the `LiveWorkflows` pattern, keeping the labelled example behind a toggle. No invented progress percentages. Every attempt keeps its evidence.
- [ ] 4.5 **Tests.** Fixture-driven: retry until verification passes, budget exhaustion, cancel kills the process tree, restart marks an interrupted run resumable and not running.

**Exit.** A loop runs to acceptance and to budget exhaustion under fixtures, and one real-provider loop on a disposable repo is recorded.

### Phase 5: Product completeness (M, overlaps 3 and 4)

- [ ] 5.1 **Worktree lifecycle** (D8). List worktrees with size, branch and session. Add explicit removal that refuses on uncommitted or unmerged work unless confirmed, and never runs automatically.
- [ ] 5.2 **Search and deep links.** Search across sessions, events, workflows and context. Add `nook://session/<id>` through Tauri's deep-link plugin with a matching capability.
- [ ] 5.3 **Event-driven updates** (G13). Replace the 700 ms poll with a pushed `{sessionId, sequence}` and an incremental snapshot. Do it before the 15-session gate (R6).
- [ ] 5.4 **Split `App.tsx` and `style.css`** by feature as each area is touched, not in one pass.
- [ ] 5.5 **Diagnostics.** A bounded, redacted, user-exportable log. Provider stderr is discarded on purpose because it can hold secrets, so failures such as "exited before completing the turn" carry only an exit status. Opt-in; no telemetry.

### Phase 6: Release readiness (M plus external lead time)

- [ ] 6.1 Close Track R and record every row in `VALIDATION.md` in its existing format.
- [ ] 6.2 Developer ID signing and notarization on macOS and code signing on Windows, with protected release secrets.
- [ ] 6.3 The eight-step installed-package acceptance on both targets, as already written in `VALIDATION.md`.
- [ ] 6.4 Pick one version scheme (D7). Packages say 0.1.0, the docs say "v0.3".
- [ ] 6.5 Licence inventory for shipped Rust and npm dependencies, and the art provenance in D6.
- [ ] 6.6 Update and rollback policy. Schema upgrades already refuse newer databases; add what happens to a user who downgrades.

**Exit.** "Unsigned development artifact" is dropped only when every gate above is recorded as passing.

## 7. Decisions needed from you

Each has a default so work is not blocked.

| # | Question | Default |
|---|---|---|
| D1 | How should code flow between dependent tasks? | Capture a bounded diff and head commit into the artifact at acceptance. Do not base the downstream worktree on the upstream branch (conflicts, fan-in). Revisit "continue from upstream branch" for linear chains later. |
| D2 | Should every task agent receive the workflow goal? | Yes, as a prefix. |
| D3 | Is Nook allowed to run user-configured project commands (verification)? | Yes: per project, started by a button, with first-use confirmation, unsandboxed, documented as such. Authorized by the request to proceed with Phase 2 on 17 October 2026; implemented with per-configuration first-use confirmation. |
| D4 | Loop triggers? | Manual only. Scheduled only while Nook is open. |
| D5 | Is Codex arranging worth a spike? | Yes, time-boxed to one or two days. |
| D6 | Who made the mascot and icon art in `docs/appIconAndMascotte/`, and under what terms? | Unknown to me. `THIRD_PARTY_NOTICES.md` currently says all characters and the icon are code-authored SVG, which is no longer true. |
| D7 | Version scheme: `0.1.0` or the docs' "v0.3"? | Treat "v0.3" as the Phase 0 to 3 milestone and bump packages when Phase 1 lands. |
| D8 | Worktree cleanup and "apply to project"? | Explicit remove only, no merge. Patch export stays the way work leaves a worktree. |

## 8. Out of scope

Carried from the README and architecture notes: tmux dependency, external-session import, background execution after quit, automatic merge or worktree deletion, cloud sync, autonomous scheduling (D4 narrows this), telemetry, an API key requirement, treating context as an OS access boundary, generated executable UI, sending session text to a different provider than the session's own.

## Appendix: how this was checked

- **Read:** README, all of `docs/`, `THIRD_PARTY_NOTICES.md`; in `backend/`: `model`, `ipc`, `store`, `workspace` (all three files), `presentation`, `provider` (`mod`, `present`, the Claude hook server, outlines of the Claude and Codex adapters), `git`, `lib`, `main`, outlines of `process` and the two binaries, test names; in `frontend/`: `api`, `types`, the structure and state handling of `App.tsx`, `LiveWorkflows`, the head of `Workspaces`, `PresentationCanvas`, `canvas/model`, `work/model`, the head of `demoWorkflow`, e2e test names; `src-tauri` main, config and capabilities; both CI workflows; the scripts. CI history came from GitHub's public, unauthenticated API.
- **Ran:** `vitest run` in `frontend/` (23 passed, matching the docs). Counted tests: 51 Rust `#[test]`, 18 e2e per browser project.
- **Did not run:** any Rust (no toolchain in this session), Playwright, Tauri, a real provider, the app. Every Rust build and test status above is the docs' record, or reading, not a fresh result.
- **Not read in depth:** stream parsing in `claude.rs` and `codex.rs`, OS-specific code in `process.rs`, `style.css`, the avatar code, the Context, Changes and Activity components, `demo.ts`.
