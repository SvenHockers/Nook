# Validation and release gates

This is a development preview, not a claim of completed first-release acceptance. Build configuration is not evidence of target compatibility. Recorded local checks were performed on **macOS 15.7.3 (24G419), Apple Silicon ARM64**, on 2026-10-16.

| Area                              | Actual evidence                                                                                                                                                                                    | Release status                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Go runtime                        | Race tests: persistence, fragmented provider streams, simultaneous approvals, cancellation, stale responses/events, descendant cleanup, Unicode/space paths, dirty worktrees and committed changes | Passing locally                                                                |
| Frontend                          | TypeScript, production bundle, unit tests; 15-card launch/stop/resume, approvals, navigation/drafts/themes, reduced motion and axe checks in Chromium and WebKit                                   | Passing locally; browser fixtures supplement native checks                     |
| Tauri                             | Cargo check/clippy; native ARM64 application bundle                                                                                                                                                | Passing locally                                                                |
| Codex signed-in route             | codex-cli 0.162.1: two tool-free turns through actual app-server, streaming response checked, process stopped and thread resumed                                                                   | Basic route passes; real questions/approvals and full GUI/package gate pending |
| Claude installed route            | Installed 2.1.187 is below the required 2.1.295 hook version                                                                                                                                       | Blocked on updating installed CLI                                              |
| Claude current route              | Isolated 2.1.301 validation used existing sign-in and returned expired OAuth authentication; installed CLI unchanged                                                                               | Blocked on provider sign-in; no API-key fallback used                          |
| Windows Go backend                | Cross-compilation of process supervision and runtime                                                                                                                                               | Compile evidence only                                                          |
| Windows 11 x64                    | Hosted build/NSIS workflow configured; no actual Windows 11 machine run recorded                                                                                                                   | Not validated; release blocked                                                 |
| Signing/notarization              | No signing credentials configured                                                                                                                                                                  | Unsigned artifacts are development only                                        |
| 15 live agents / human acceptance | Deterministic parallel runtime and browser coverage                                                                                                                                                | Sustained native load and five-second attention study pending                  |

Machine-readable account results are in `docs/validation/`. They contain versions and outcome only, not credentials or transcripts. The `nook-check` tool never auto-approves tools; it is deliberately insufficient to certify real approval flows.

## CI

`.github/workflows/ci.yml` runs Go tests/vet, TypeScript/frontend tests, fake-provider contracts, Chromium/WebKit interactions and accessibility, sidecar IPC, Rust tests/clippy, native builds, and package generation on versioned macOS 15 ARM64 and Windows 2025 x64 runner images. Toolchains and dependencies are pinned by version/lockfile. Hosted Windows is Windows Server and does not establish Windows 11 compatibility. CI has been authored but cannot be claimed green before a remote run.

`.github/workflows/target-validation.yml` is manual only, default-branch only, and uses the `target-validation` protected environment with dedicated self-hosted labels `nook-validation` plus `macOS-ARM64` or `Windows11-X64`. Configure required reviewers and restrict the environment to the default branch before attaching signed-in machines. Never execute untrusted PR branches on these runners. Install Go, Node, Rust, Git and native prerequisites on these machines. Initial sign-in remains the user's provider setup step.

## Required installed-package acceptance

On each target, build the package from the reviewed default-branch commit, install it into the ordinary application location, and record OS/build, architecture, Nook revision, provider executable/version, package hash, signer, and result. For Windows, include WebView2-absent installation and the bootstrapper result. For macOS distribution, configure Developer ID signing and notarization using protected release secrets and verify Gatekeeper. Do not distribute unsigned CI artifacts as a supported release.

Run these steps for both providers in disposable Git projects whose paths include spaces and Unicode. Keep credentials out of all uploaded evidence.

1. Launch installed Nook. Verify discovery with ordinary signed-in accounts, unavailable executable, incompatible version, expired sign-in, and organization restriction states.
2. Add a project with uncommitted edits. Launch a task in the default worktree; verify current committed HEAD, unique branch, original edits unchanged. Repeat shared and non-Git modes.
3. Use a task that requests a harmless restricted command and a user question. Verify graphical accept/decline/custom answer, two simultaneous approvals in different sessions, and cancellation. Expire a bridge request and disconnect it; neither may become a grant.
4. Stop work while output is streaming and while a permission request is waiting. Verify no descendants remain. Resume and verify continuity of the original provider session, not an unrelated replacement.
5. Complete a task through the GUI, inspect changes/output, export a tracked patch, reveal the folder, archive and find it again. Reopen Nook and verify conversation/context/drafts/selection/scroll and retained worktrees. Work must not restart automatically.
6. Interrupt the backend and restart the app. Verify kernel process identity reconciliation, unrelated PID protection, SQLite recovery, and visible resume errors when the worktree/provider session was removed.
7. Run 15 sessions with output bursts. Type while output arrives, switch cards/projects/themes, answer simultaneous requests, and verify no lost input or reordered cards. Check reduced motion, high-DPI displays, native shortcuts and notifications while unfocused.
8. Have a person find every attention-required card within five seconds and finish a complete task without a terminal. Record findings and fix usability failures before marking acceptance complete.

Record results rather than checking this list speculatively. The unresolved account, target-machine, signing, and native-interaction gates block a first usable release declaration.
