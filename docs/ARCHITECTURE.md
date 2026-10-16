# Architecture and interaction contract

## Desktop boundary

Tauri 2 owns native windows, dialogs, notifications, application lifetime, and packaging. React/TypeScript communicates only through the `backend_call` Rust command. Rust enforces a command allowlist and forwards requests over a private stdio pipe to one bundled Go sidecar. It routes responses by request ID and emits `nook:changed` events. No shell execution or general filesystem permission is granted to frontend JavaScript. Production CSP excludes remote scripts and network calls from the webview.

The Go sidecar owns provider discovery/adapters, process supervision, SQLite, Git operations, and workspace state. JSONL messages carry `{id, method, args}` and `{id, result, error}`; events carry `{event, result}`. EOF means desktop ownership was lost and triggers cleanup. Tauri requests Shutdown on normal exit and then reaps the sidecar. This retains the reusable Go components while accepting the explicit Rust integration layer required by the user's Tauri decision.

`internal/model` is the wire-contract source, mirrored by `frontend/src/types.ts`. `Project`, `Session`, `ContextAssignment`, `ApprovalRequest`, `ProviderCapabilities`, and `SessionEvent` are independent of the desktop framework. SQLite schema version 1 stores projects, sessions, globally ordered events, and navigation settings. Session mutation and event insertion share a transaction. Databases from a newer schema fail clearly instead of being downgraded.

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

`agent-deck` supplied MIT-licensed ring-buffer code and worktree patterns with regression coverage; the exact revision and license are recorded in THIRD_PARTY_NOTICES.md. No tmux runtime was adopted. `agents-deck` is a behavioral reference only; no unlicensed source or characters were copied. `loop-engineering` informs future workflows but there is no automatic orchestration in this release.

Sources: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude Windows setup](https://code.claude.com/docs/en/setup).


## UI alignment slice (v0.3 handoff)

`frontend/src/features/avatars` owns persistent character definitions, a pure runtime/interaction pose resolver, SVG anatomy and the playground. Wire states remain unchanged: starting → thinking, waiting → waiting_for_input, stopped → idle, failed → error. Stopped is not relabeled as a resumable pause. Decorative motion pauses offscreen/hidden, compact avatars do not track gaze, and reduced motion overrides animation. Completion/error reactions settle after entry. Provider labels are separate from identity.

Home, Agents, Context and Activity project existing runtime snapshots. Context uses the existing editor and native commands. The new workflow/loop interfaces use their own typed states; their fixtures live only in `features/work/fixtures.ts`, behind an explicit example button and persistent simulation banner. There is no workflow/loop execution command or implicit scheduler. Definitions, runs, attempts and agent runtime are separate types.

Canvas maps recorded session events to evidence with session/project/revision provenance. Session sequences are replay-deduplicated without replacing existing evidence. The mounted Canvas retains a source snapshot for all three modes and marks it stale on new events. Explicit refresh advances all modes together; changing identity or scope discards the old snapshot. Caching is local to the mounted view, not a shared or persistent authorization cache. Raw shows the unmodified stored event payloads, not an unavailable provider wire transcript. Agent prose remains agent-reported; no test counts are inferred from text.

The catalog accepts only known component names and evidence references of the matching kind. It rejects unknown fields, action fields, cross-project/source/revision references, duplicate block IDs, oversized block lists, and unknown schema versions. React renders all text; no HTML insertion, script evaluation, generated styles, URLs, or native actions are accepted. Explore actions (mode switch, inspect, expand) are owned by trusted components. Native actions remain in the established session/approval UI. This is the deterministic Presentation Agent foundation, not a deployed model planner. A backend evidence selector and policy-aware model integration must precede privileged generated actions or shared caches.

### Structured UI investigation

Reviewed [json-render's core catalog/schema API](https://github.com/vercel-labs/json-render/blob/main/packages/core/README.md) and [A2UI's renderer lifecycle](https://github.com/a2ui-project/a2ui/blob/main/docs/public/reference/renderers.md). json-render provides catalog validation, specifications and action mapping; A2UI defines a multi-platform message/render lifecycle. Both expose more runtime surface than this deterministic local slice needs. Nook's small evidence-binding view model is deliberately not advertised as compatible with either protocol. Reassess json-render when connecting the actual planner; do not add a streaming/model dependency just to render already-structured records. No upstream renderer code was copied or installed. Licensing and pinned-version review remain required before adoption.

Upstream local inspection retained the existing reuse decision: agent-deck `8d0f1fe` is MIT and its ring buffer is already adapted; agents-deck `561c5e5` has a tmux supervisor and no root license, so no code is incorporated; loop-engineering `ab47bfa` is MIT and its `tools/loop/src/status.ts` reads Markdown/ledger artifacts rather than implementing the native task scheduler Nook needs. No additional upstream source was copied.
