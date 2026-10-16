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
| Workflow and loop workspaces | Inspection examples only; no scheduler, execution, retry enforcement, pause/stop or actionable approval backend |
| Canvas | Deterministic recorded-event presentation; structured test/metric rendering needs actual backend evidence adapters |
| Presentation Agent | Typed catalog and validation foundation only; no model invocation, authorized retrieval service, persistent cache, cancellation or refocus |
| Permissions | Existing provider capability descriptions; context assignments are not access restrictions |
| Navigation | Main section saved; session drafts/detail scroll preserved. Cross-entity global search and deep links are still pending |
| Native platforms | Shared frontend exercised in Chromium/WebKit on macOS; Windows packaging and native UI acceptance remain separate release gates |

The full v0.3 product is not complete. Next vertical slice: persist workflow definitions/tasks and immutable artifacts in the Go store, expose authorized snapshot/event commands through Rust, then replace the example adapter. Implement loop execution only after retry/time budgets, human gates and verification evidence are enforceable by the backend. Connect a Presentation Agent after scoped evidence retrieval and cache invalidation exist. No requested review gate is treated as approval of this unfinished runtime work.

## Validation recorded on macOS ARM64

- `npm --prefix frontend run build`: passed (strict TypeScript + production Vite bundle).
- `npm --prefix frontend run test`: 17 tests passed across four files.
- `npm --prefix frontend run test:e2e`: 24 tests passed across Chromium and WebKit. Includes 15 sessions, approvals, draft/theme persistence, launch/stop/resume, keyboard search, reduced motion, workflow dependency/artifact inspection, loop attempt evidence, Canvas revision parity and stale refresh, context navigation, and light/dark axe checks.
- `go test ./...`: passed; existing native service/process/provider/storage regression coverage preserved. This is not a fresh signed-in provider or installed desktop acceptance run.
- Screenshots visually inspected: [Home](validation/ui/nook-home.png), [avatar playground](validation/ui/nook-avatar-playground.png), [loop example](validation/ui/nook-loop.png), [dark density](validation/ui/nook-dark-density.png), [dark workflow](validation/ui/nook-workflow-dark.png).
- Fixed dark root text and accent foreground contrast identified by the expanded axe checks.
- Windows native build, installed-package behavior, native assistive technology and frame-time profiling were not run in this slice. Browser success does not substitute for those checks.

Files changed for this slice: `frontend/src/App.tsx`, `Avatar.tsx`, `style.css`; new `features/avatars/*`, `features/canvas/*`, `features/work/*`, `shared/events.ts` and its tests; `frontend/e2e/alignment.spec.ts`; README and architecture/implementation documentation. No backend wire commands, dependencies or persisted database schemas were changed.
