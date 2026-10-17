# UI alignment plan — 16 October 2026

Priority/dependency order:
1. Preserve the existing Tauri → Rust → Go runtime and session/approval/context flows. Replace avatar rendering through a compatibility adapter, leaving stored identity untouched.
2. Establish eye-led SVG anatomy, pure expression resolution, motion/density policies, and an embedded playground.
3. Add workspace navigation and inspectable workflow/loop examples. Production must display a disconnected integration state rather than sample execution as live work.
4. Add revision-bound Canvas with a small validated evidence catalog and Visual/Chat/Raw modes over actual session events. No generated executable code or native actions.
5. Add contract and browser regression tests, inspect screenshots, document remaining native and orchestration work.

Initial findings: existing frontend has a coherent light/dark shell, 15-session demo, persisted navigation, real provider controls, approvals, context editing and diffs. Avatar anatomy is small-eyed and monolithic; workflow/loop/evidence models do not exist. Backend states have seven values and must be mapped explicitly rather than silently renamed. Existing context assignments are knowledge delivery, not enforced access grants. Existing upstream notices record one reused MIT component and unlicensed behavioral references; preserve these boundaries.

## Delivered in this slice

- Preserved the Tauri/Rust/Go process and approval architecture and existing native commands.
- Added primary Home, Agents, Workflows, Loops, Context and Activity navigation. Home summaries use actual snapshot counts; context inspection opens the existing editable assignments.
- Six original layered SVG identities; eight expressions; bounded hero gaze; eyelids; seeded blinking; subtle density mode; one-shot reactions; offscreen/hidden and reduced-motion policies. Playground includes size, motion, theme, state cycling and 15-agent review.
- Reusable typed `WorkflowTeamView` and `LoopRunView`, separate workflow/task/agent/loop states, inspectable dependencies, handoffs, attempt selection, checks and source views. Their current workspace adapters are explicitly simulated.
- Session Canvas backed by real stored events in native mode. Visual/Chat/Raw share a captured revision, source inspection and stale/refresh behavior. Replayed events are deduplicated without rewriting original evidence.
- Allowlisted catalog and schema checks for text, metrics, tables, comparisons/charts, tests and relationship lists. No generated HTML, JS, native commands, or action handlers.
- Unit tests for expression bounds, attention priority, malicious presentation fields, scope/revision binding and event replay. Browser checks cover both old and new interactions, source parity, stale refresh, reduced motion and accessibility.

## Integration status and remaining work

| Area | Status |
|---|---|
| Home / Agents / Context / Activity | Existing native snapshot/command integration; browser demo explicitly separate |
| Avatar playground | Fully interactive local simulation, independent of provider execution |
| Workflows | Saved definitions, manually started native sessions, dependency gates, revision-checked human acceptance and immutable event handoffs; no automatic scheduler or file transfer |
| Loops | Inspection examples only; retry/time budgets and verification execution pending |
| Canvas | Recorded-event presentation: streamed chunks are one record, process chatter is excluded, records are labelled. Evidence is text only; structured test/metric/table rendering still needs backend evidence adapters |
| Presentation Agent | Claude Code sessions only: backend-served revision-bound evidence, opt-in model arrangement by the session's own Claude Code (tool-less, validated, cached, cancellable, refocusable) with a deterministic fallback and visible reason. See "Presentation Agent slice" below |
| Permissions | Existing provider capability descriptions; context assignments are not access restrictions |
| Navigation | Main section saved; session drafts/detail scroll preserved. Cross-entity global search and deep links are still pending |
| Native platforms | Shared frontend exercised in Chromium/WebKit on macOS; Windows packaging and native UI acceptance remain separate release gates |

The full v0.3 product is not complete. Saved workflow definitions/tasks and immutable artifacts are now connected to the Rust store and native commands. Next workflow work includes attempt history and code-change handoffs. Implement loop execution only after retry/time budgets, human gates and verification evidence are enforceable by the backend. The Presentation Agent now exists for Claude Code sessions (below); extending it needs evidence adapters for structured kinds and a Codex path. No requested review gate is treated as approval of this unfinished runtime work.

## Presentation Agent slice — 16 October 2026

The Canvas Visual mode can now be arranged by a model, on request, without changing what the evidence says.

- **Boundary.** The model receives recorded evidence as JSON data and answers only with `{evidenceId, type}` pairs. The backend builds every block, id, version and timestamp itself and rejects the whole reply if any block names an unknown component, unknown or repeated evidence, or evidence of a kind that component cannot render. The frontend validates the result a second time against the exact source it asked for. Any failure leaves the deterministic layout with the reason shown. No generated text, HTML, script, URL or action can reach the view.
- **Retrieval.** `PresentSession {sessionId, revision, focus, arrange}` rebuilds evidence in the backend from stored events up to exactly `revision`, which must be an event the caller has seen. The backend issues the source scope. Records come from conversation, approvals and outcomes only; process identities and progress chatter are excluded and streamed chunks join into one record.
- **Model call.** The session's own `claude` runs once with `--print --output-format json --tools "" --no-session-persistence --strict-mcp-config --disable-slash-commands --setting-sources project` in an empty private folder, using the existing sign-in and no API key. Session text never goes to a provider other than the session's own, so Codex sessions are not arranged. Ignoring user settings keeps plugins and hooks out of a JSON-only reply, but means sign-in configured through settings (for example a cloud provider's environment) does not apply and arranging then falls back with an authentication reason.
- **Consent.** Arranging is a button with a visible disclosure, never automatic. The browser demo labels its result "Sample arrangement · no model ran" and sends nothing.
- **Cache, cancel, refocus.** Validated arrangements persist in SQLite (schema v3), keyed by project, session, revision, scope, format version, provider and focus, and are pruned to the newest 20 per session. Cancel kills the owned process group; so do leaving the tab, refreshing the view and quitting. One arrangement runs per session, bounded at 75 seconds so the shell's 90-second call limit never hides the cause. A new focus is a new arrangement.
- **Visible effect.** `Finding` gets an accent, `TerminalExcerpt` and `CodeDiff` render monospaced. Records are labelled "You", "Agent", "Approval", "Problem" or "Status", and the view says when it shows only the latest records.

Not done: Codex arranging; evidence adapters for tests, metrics, tables or diffs (every native record is text, so a model can only choose among text components); sign-in configured through settings; a shared or cross-session cache; json-render or A2UI interoperability.

Validation recorded on Windows 11 x64 (Rust 1.93.0 GNU target, Chromium): `cargo test` passed 50 tests, including cancellation, timeout, output-shape and one-arrangement-per-session contracts against the fixture agent; `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean; `npm run test` 23 tests; `npm run test:e2e` Chromium 18 tests including arrange, focus, cancel, stale reset and a scoped axe scan in light and dark. One real arrangement was run against Claude Code 2.1.301 with synthetic evidence and produced a valid layout. That run found that `--output-format json` returns either one object or an array of every message depending on the user's settings, so the parser accepts both. macOS, WebKit, the Tauri shell build and a real Claude session in the desktop app were not run.

## Validation recorded on macOS ARM64

- `npm --prefix frontend run build`: passed (strict TypeScript + production Vite bundle).
- `npm --prefix frontend run test`: 17 tests passed across four files.
- `npm --prefix frontend run test:e2e`: 24 tests passed across Chromium and WebKit. Includes 15 sessions, approvals, draft/theme persistence, launch/stop/resume, keyboard search, reduced motion, workflow dependency/artifact inspection, loop attempt evidence, Canvas revision parity and stale refresh, context navigation, and light/dark axe checks.
- `go test ./...`: passed; existing native service/process/provider/storage regression coverage preserved. This is not a fresh signed-in provider or installed desktop acceptance run.
- Screenshots visually inspected: [Home](validation/ui/nook-home.png), [avatar playground](validation/ui/nook-avatar-playground.png), [loop example](validation/ui/nook-loop.png), [dark density](validation/ui/nook-dark-density.png), [dark workflow](validation/ui/nook-workflow-dark.png).
- Fixed dark root text and accent foreground contrast identified by the expanded axe checks.
- Windows native build, installed-package behavior, native assistive technology and frame-time profiling were not run in this slice. Browser success does not substitute for those checks.

Files changed for this slice: `frontend/src/App.tsx`, `Avatar.tsx`, `style.css`; new `features/avatars/*`, `features/canvas/*`, `features/work/*`, `shared/events.ts` and its tests; `frontend/e2e/alignment.spec.ts`; README and architecture/implementation documentation. The initial visual foundation did not change wire commands or storage. The later workflow and Presentation Agent slices add native commands and storage as documented above.

## Manual workflow validation — 16 October 2026, macOS ARM64

The live workspace supports saved definitions, provider assignments, dependency inspection, individual task launch, history, and explicit output review/acceptance. Starts and acceptance use revision checks and atomic storage; accepted event evidence is immutable. Provider completion alone does not unlock dependencies. Stop/resume stays in the assigned agent session. Browser demo execution is simulated and lasts only for the current visit.

Handoffs transfer recorded events, not file changes or independently verified results. The serialized event payload, including structured approvals, is capped at 1 MB and 10,000 events; the downstream prompt has a separate 256 KB limit. Oversized handoffs fail visibly. At the time of this 16 October record, loop execution, automatic scheduling, workflow retries and real-provider workflow acceptance remained pending. The 17 October slice below supersedes the workflow retry/handoff status.

Fresh checks: frontend production build; 23 frontend unit tests; 36 browser tests across Chromium/WebKit including workflow acceptance and Presentation Agent controls; 50 Rust backend tests plus the new structured-payload limit regression; Tauri shell compilation through cargo test; clean backend and shell Clippy checks; bundled sidecar stdio/persistence/shutdown smoke. The [saved-workflow screenshot](validation/ui/nook-saved-workflow.png) was visually inspected. The corrected reference-example label was rechecked in both browsers. These checks do not establish installed-app acceptance on Windows or a signed-in native workflow run.

## Workflow recovery slice — 17 October 2026

Saved workflows support draft edits, rejected attempts followed by explicit retry, cancellation, and archival. The inspector retains links to every attempt and shows the downstream handoff size, omitted record count, HEAD, status, diff stat and bounded diff. Acceptance submits both the inspected event revision and code fingerprint; changes require another inspection. Needs attention links directly to workflow tasks awaiting acceptance or recovery. Workflow notifications follow the completion opt-in. `WorkflowForm.tsx` owns draft editing separately from the live workspace.

The browser simulator implements the lifecycle commands and is covered by recovery/attention tests. Real-provider validation and remaining manual/native gates are recorded in `VALIDATION.md`.


### Phase 2 — native evidence and checks

The session Canvas now includes Record evidence and Verification checks. Project configuration accepts a JSON array of named argv commands, timeout seconds and output cap bytes. Users see the exact saved commands and working directory; first-use confirmation is scoped to the saved configuration and resets on edits. Checks show running/cancel and recent outcomes, with full records in Canvas Raw and exit-code TestReport evidence after Refresh. The demo explains that native capture/execution is unavailable instead of inventing measured results. Browser tests cover command review, cancellation of confirmation and the demo boundary.
