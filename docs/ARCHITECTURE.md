# Architecture and interaction contract

## Desktop boundary

Tauri 2 owns native windows, dialogs, notifications, application lifetime, and packaging. React/TypeScript communicates only through the `backend_call` Rust command. Rust enforces a command allowlist and forwards requests over a private stdio pipe to one bundled runtime sidecar. It routes responses by request ID and emits `nook:changed` events. No shell execution or general filesystem permission is granted to frontend JavaScript. Production CSP excludes remote scripts and network calls from the webview.

The Rust sidecar (`backend/`) owns provider discovery/adapters, process supervision, SQLite, Git operations, and workspace state. JSONL messages carry `{id, method, args}` and `{id, result, error}`; events carry `{event, result}`. EOF means desktop ownership was lost and triggers cleanup. Tauri requests Shutdown on normal exit and then reaps the sidecar. The runtime was ported from Go; it stays a separate process so EOF ownership loss and its `--permission-host` helper mode work unchanged.

`backend/src/model.rs` is the wire-contract source, mirrored by `frontend/src/types.ts`. `Project`, `Session`, `ContextAssignment`, `ApprovalRequest`, `ProviderCapabilities`, and `SessionEvent` are independent of the desktop framework. SQLite schema version 3 stores projects, sessions, globally ordered events, navigation settings, workflows, immutable handoff artifacts and presentation arrangements. Session mutation and event insertion share a transaction. Databases from a newer schema fail clearly instead of being downgraded.

## Frontend organization

`App.tsx` owns navigation, workspace subscriptions, and the application shell. Session conversation, approvals, launch and changes views live in `features/sessions/`; the assignment editor lives in `features/context/`. `shared/Modal.tsx` owns the common dialog and focus restoration. Feature components receive their existing state and callbacks rather than owning a second workspace store.

`style.css` is an ordered entry point for base layout, session details, forms, theme/responsive overrides, and workspace styles. Preserve import order when moving rules: theme overrides depend on the cascade. TypeScript checks unused locals and parameters as part of the normal build.

The unused session `seen` field has been removed from both wire models. Older JSON session rows containing it remain readable without a schema migration; completion continues to mean a turn is ready for review, not a separate unread state. Packaging uses Tauri's configured bundles through `npm run tauri -- build`.

## Runtime ownership

A session has a stable ID, avatar identity, provider resume ID, working directory, initial Git commit, and explicit state. A runtime generation scopes incoming events: output and responses from stopped/replaced processes cannot update the new generation. Stop invalidates pending approvals before terminating the runtime. Provider completion only ends a turn; the card stays available for review/resume.

macOS creates an owned process group and sends interrupt followed by a bounded forced group stop. Windows starts suspended, assigns a kill-on-close Job Object, then resumes the process so descendants cannot escape during initialization. Reopening checks the recorded process ID and kernel birth time before reconciling a surviving process. Restored cards do not auto-start.

The provider interfaces expose start, send, interrupt, stop, and response handling; resume is an explicit provider identifier supplied on start. Discovery probes executable version rather than reading credentials. Global provider configuration remains in force. Unknown protocol requests fail closed.

Codex uses the installed `codex app-server --listen stdio://`, initialization, threads, streamed turns, command/file approvals, user questions, interruption, and thread resume. Claude uses the installed CLI's structured input/output, an explicit session UUID, temporary session settings, a session-specific MCP permission host, and authenticated loopback HTTP hooks for AskUserQuestion/ExitPlanMode. A random per-session token stays in the child environment, is compared in constant time, and is not stored in SQLite or hook settings. Cancellation, timeout, bad authentication, and bridge disconnection never grant approval. Claude versions before 2.1.295 are unavailable because they cannot guarantee the required HTTP-hook failure behavior.

Permission controls are provider controls, not a promise of OS isolation. Native Windows Claude is labeled as lacking its OS sandbox. Context assignments describe supplied knowledge, not a filesystem access boundary. Nook does not rewrite global settings or copy auth tokens.

## Interaction model

- **Overview:** stable creation-order cards grouped through project navigation and filters. Identity uses six original eye-led vector silhouettes and six gradient palettes through a compatibility adapter over stored numeric identities. Status always includes text. No invented progress percentage or continuous decorative animation.
- **Attention:** questions, approvals, failures, and disconnected sessions. Actionable notifications occur while unfocused; completion notifications are opt-in. Cards do not reorder as state changes.
- **Detail:** conversation first, then activity, changes, context, and secondary output. Drafts, selected session, filters, theme, and per-view scroll are retained. The composer remains useful for drafting during work and sends only when the turn is ready.
- **Launch:** select installed provider and project, enter the task, use a separate worktree by default for Git projects. Shared-folder mode is explicit and warns of simultaneous edits. Non-Git projects share their folder.
- **Context:** central project defaults seed new sessions; session assignments are editable independently. Notes and text file contents are supplied on the next turn; folders are references. Removing context cannot retract prior information.
- **Review:** completion means the provider ended its turn. Tracked diffs are relative to the starting commit, including agent commits; untracked files are listed and explicitly excluded from patch export. Reveal exposes retained work files. Archive preserves files and history, and archived cards remain browsable.
- **Quit/reopen:** stop all owned processes, flush local state, restore cards without work restarting. Resume failures remain visible and do not silently create a different session.

## Reuse and boundaries

`agent-deck` supplied MIT-licensed worktree patterns with regression coverage; the exact revision and license are recorded in THIRD_PARTY_NOTICES.md. No tmux runtime was adopted. `agents-deck` is a behavioral reference only; no unlicensed source or characters were copied. `loop-engineering` informs future workflows but there is no automatic orchestration in this release.

Sources: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude Windows setup](https://code.claude.com/docs/en/setup).


## UI alignment slice (v0.3 handoff)

`frontend/src/features/avatars` owns persistent character definitions, a pure runtime/interaction pose resolver, SVG anatomy and the playground. Wire states remain unchanged: starting → thinking, waiting → waiting_for_input, stopped → idle, failed → error. Stopped is not relabeled as a resumable pause. Decorative motion pauses offscreen/hidden, compact avatars do not track gaze, and reduced motion overrides animation. Completion/error reactions settle after entry. Provider labels are separate from identity.

Home, Agents, Context and Activity project existing runtime snapshots. Context uses the existing editor and native commands. The new workflow/loop interfaces use their own typed states; their fixtures live only in `features/work/fixtures.ts`, behind an explicit example button and persistent simulation banner. Saved workflows use CreateWorkflow, StartWorkflowTask, WorkflowEvidence and AcceptWorkflowTask through the native allowlist. Dependency gates require explicitly accepted artifacts; revision checks and transactions prevent duplicate starts or acceptance. Task sessions use the existing provider runtime. Accepted events remain immutable even if a session later resumes; file changes are not transferred between worktrees. Loops remain examples and there is no implicit scheduler. Definitions, runs, attempts and agent runtime are separate types.

Canvas maps recorded session events to evidence with session/project/revision provenance. Session sequences are replay-deduplicated without replacing existing evidence. The mounted Canvas retains a source snapshot for all three modes and marks it stale on new events. Explicit refresh advances all modes together; changing identity or scope discards the old snapshot. The standard layout's snapshot is local to the mounted view; only model arrangements are cached persistently (see Presentation Agent below). Raw shows the unmodified stored event payloads, not an unavailable provider wire transcript. Agent prose remains agent-reported; no test counts are inferred from text.

The catalog accepts only known component names and evidence references of the matching kind. It rejects unknown fields, action fields, cross-project/source/revision references, duplicate block IDs, oversized block lists, and unknown schema versions. React renders all text; no HTML insertion, script evaluation, generated styles, URLs, or native actions are accepted. Explore actions (mode switch, inspect, expand) are owned by trusted components. Native actions remain in the established session/approval UI. A model may arrange the view (below) but still cannot add content or actions; privileged generated actions or shared caches need a policy-aware design first.

### Presentation Agent

`backend/src/presentation.rs` is the pure boundary: it builds evidence from stored events, owns the component catalog, validates layouts, derives cache keys and builds the only prompt a model sees. `backend/src/workspace/presentation.rs` serves `PresentSession` and `CancelPresentation`: it rebuilds evidence up to the caller's revision, consults the SQLite cache, runs at most one arrangement per session through `backend/src/provider/present.rs`, and falls back to the deterministic layout with a reason on any failure. The provider call is a one-shot, tool-less `claude --print` in an empty private folder, killed with its whole process tree on cancel, timeout (75 s) or quit. Only the session's own provider is used, so session text is never sent to a different provider than the one that produced it. The model returns `{evidenceId, type}` pairs only; the backend constructs the layout and rejects the whole reply on any invalid block. `frontend/src/features/canvas/model.ts` mirrors the evidence rules for the browser demo and workflow handoffs and validates every backend result against the exact source requested. Reply parsing accepts both of Claude Code's `--output-format json` shapes, because the shape depends on the user's settings.

### Structured UI investigation

Reviewed [json-render's core catalog/schema API](https://github.com/vercel-labs/json-render/blob/main/packages/core/README.md) and [A2UI's renderer lifecycle](https://github.com/a2ui-project/a2ui/blob/main/docs/public/reference/renderers.md). json-render provides catalog validation, specifications and action mapping; A2UI defines a multi-platform message/render lifecycle. Both expose more runtime surface than this deterministic local slice needs. Nook's small evidence-binding view model is deliberately not advertised as compatible with either protocol. Reassess json-render when connecting the actual planner; do not add a streaming/model dependency just to render already-structured records. No upstream renderer code was copied or installed. Licensing and pinned-version review remain required before adoption.

Upstream local inspection retained the existing reuse decision: agent-deck `8d0f1fe` is MIT and its worktree approach is already adapted; agents-deck `561c5e5` has a tmux supervisor and no root license, so no code is incorporated; loop-engineering `ab47bfa` is MIT and its `tools/loop/src/status.ts` reads Markdown/ledger artifacts rather than implementing the native task scheduler Nook needs. No additional upstream source was copied.
