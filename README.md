# Nook

A local desktop workspace for Claude Code and Codex. Bring a project, give an agent a task, and follow its conversation, questions, changes, and context in one place.

**Development preview.** Nook now uses **Tauri 2**, React, TypeScript, and Vite, with a Go sidecar and SQLite. Tauri replaces the original Wails choice. The target platforms are macOS 14+ on Apple Silicon and Windows 11 x64; Windows and both providers' complete release gates are still pending. See [validation status](docs/VALIDATION.md) before treating this as a supported release.

## What works

- Stable agent cards, original vector characters, project navigation, attention inbox, light/dark/system appearance, keyboard shortcuts, and persistent drafts.
- Installed-provider discovery and executable picker. Codex app-server streams; Claude structured streams, session-scoped hooks, and a permission-host MCP tool. Existing provider sign-in and global policy remain in the provider.
- Graphical questions and approvals, cancellation, stop and resume, persisted conversation and activity events, and archived sessions.
- Project notes, text files, and folder references; assignments apply to the next turn. Context is not an OS access boundary.
- Separate Git worktrees from committed HEAD by default, explicit shared-folder mode, changes, tracked binary patch export, and reveal in folder. Worktrees are retained.
- Process groups on macOS, kill-on-close Job Objects on Windows, authenticated local permission transport, and PID/birth-time reconciliation after an interrupted run.

## UI handoff implementation

The sidebar now includes Home, Agents, Workflows, Loops, Context, Activity, and an avatar playground. The playground exposes six eye-led SVG characters, eight runtime expressions, gaze, motion/size/theme controls, state cycling and a 15-avatar density view. Existing session launch, approvals, stop/resume, context editing and changes remain connected to the native backend.

Open a session's **Canvas** tab to switch between Visual, Chat and Raw over the same recorded source revision. New events mark the view stale until refreshed. The initial catalog renders evidence-backed text, measurements, tables, charts, test reports and relationship lists; it never treats generated text as executable UI or verified measurements.

**Workflows and Loops currently provide explicitly labeled inspection examples, not live orchestration.** Model-driven presentation generation, persistent presentation caching, workflow execution and loop policies are pending. See [implementation status](docs/UI_IMPLEMENTATION.md) for the boundary between completed UI and pending integrations.

## Develop

Install Go, Rust, Node.js, Git, and Tauri's native build prerequisites (Xcode command-line tools on macOS; Visual Studio C++ build tools and WebView2 on Windows). CI pins Go 1.27.2, Rust 1.93.0, and Node 24. Dependency lockfiles are checked in.

```sh
npm ci
npm ci --prefix frontend
npm run dev
```

`npm run dev` builds the Go sidecar and starts Tauri with Vite. The desktop has a real, initially empty workspace. The browser-only fixture is explicitly available at `http://127.0.0.1:34115/?demo=1` after `npm run dev --prefix frontend`; it never starts real agents.

Install and sign in to the agents before first use. Nook does not require an API key. Claude Code **2.1.295 or newer** is required for fail-closed HTTP hooks. Nook accepts native executables; shell wrappers that cannot be safely resolved must be replaced by selecting the underlying executable in Settings. Authentication and organization errors remain separate from installation/version problems.

Use **Open a project → New agent**, choose a provider, describe the task, and launch. Git worktrees exclude uncommitted edits. The attention view collects questions, approval requests, and failures. “Ready to review” means a turn ended; it is not independent verification. Full quit stops owned processes. Reopening restores cards and transcripts without starting work.

Shortcuts: Cmd/Ctrl+K search, Cmd/Ctrl+N new agent, Cmd/Ctrl+, settings, Cmd/Ctrl+Enter send, Escape close detail/dialog.

## Check and package

```sh
go test -race ./...
go vet ./...
npm run build --prefix frontend
npm test --prefix frontend
cd frontend
npx playwright install chromium webkit
npm run test:e2e
cd ..
npm run desktop:prepare
node scripts/sidecar-smoke.mjs src-tauri/binaries/nook-backend-aarch64-apple-darwin
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
npm run tauri -- build
```

For the Windows sidecar smoke test, use `src-tauri/binaries/nook-backend-x86_64-pc-windows-msvc.exe`. Build on the target OS. Tauri produces an ARM64 app/DMG on macOS and an x64 NSIS installer on Windows. NSIS embeds the WebView2 bootstrapper, which may require internet during installation. Unsigned packages are development artifacts, not distribution-ready releases.

Opt-in real account checks consume a small amount of provider usage and never approve tools:

```sh
go run ./cmd/nook-check --live --provider codex --report codex-validation.json
go run ./cmd/nook-check --live --provider claude --report claude-validation.json
```

An optional `--executable /path/to/agent` selects a specific installed version. Real approval/question, native GUI, and installed-package acceptance steps are documented in [the validation guide](docs/VALIDATION.md).

## Local data and architecture

Nook stores `nook.sqlite` and retained worktrees under the platform configuration directory's `Nook` folder: `~/Library/Application Support/Nook` on macOS and `%APPDATA%\Nook` on Windows. Provider credentials remain with the installed provider. No Nook telemetry is configured. Conversations and supplied context are local application data; provider network use follows its policies.

- [Architecture and interaction contract](docs/ARCHITECTURE.md)
- [Validation matrix and release checklist](docs/VALIDATION.md)
- [Upstream attribution](THIRD_PARTY_NOTICES.md)

No tmux dependency, terminal multiplexer, external-session import, background execution after quit, automatic merge/worktree deletion, cloud sync, or autonomous scheduling is included.
