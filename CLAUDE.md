# CLAUDE.md — puddle

Puddle is a self-hosted orchestrator for CLI coding agents with first-class SSH support: a persistent daemon (`puddled`) runs on whatever machine hosts the work — your own laptop (`puddle launch`) or a remote box (`puddle launch user@host`) — and owns agent PTYs, git worktrees, and session state; a web UI provides project workspaces with terminals, editing, diffs, git history, and port forwarding. The full design is in `SPEC.md` — read it before making architectural changes.

**Read `HUMANS.md` at the start of every session.** It is the human-authored design brief for the UI's feel (minimalism, transparency, no boxes/borders, hover responsiveness) and it overrides SPEC §12 and any framework default wherever they conflict. Any UI work that ignores it is wrong by definition.

## Repo map

```
packages/
├── shared/    # the protocol package: zod schemas for REST + WS messages (the single source of
│              # truth for API shapes) + PROTOCOL_VERSION — read its PROTOCOL.md before schema changes
├── daemon/    # puddled: Hono HTTP/WS server, PTY manager, worktree manager, SQLite
│   ├── src/storage/      # capacity monitoring, admission checks and bounded runtime persistence recovery
│   ├── src/security/     # private host control, monotonic connection leases and resource revocation
│   ├── src/agents/       # adapters own flags, cached native catalogue discovery, and exact lifecycle integration
│   ├── src/puddlang/     # trusted TypeScript runner, bounded operations and durable run/event records
│   ├── src/compilation/  # provider-neutral compile modes, scheduling, dependency observation, and artefacts
│   ├── src/code/         # manual single-file execution recipes, host tool discovery and managed output
│   ├── src/latex/        # local TeX discovery/recipes, managed outputs, and inverse SyncTeX
│   ├── src/notebooks/    # daemon-owned Jupyter kernels, bounded bridge and explicit lifecycle
│   ├── src/sessions/     # immutable placement service + stable live runtimes + watched conversation catalogue
│   └── src/worktrees/    # worktree lifecycle plus repository-aware Git inspection/mutations
├── web/       # React UI: Tailwind v4 + owned shadcn-style components (src/components/ui/)
│   ├── src/styles/tokens.css   # THE colour source; scripts/check-tokens.mjs guards it in lint/CI
│   ├── src/lib/       # browser authorisation, TanStack Query hooks, singleton WS manager, theme registry
│   ├── src/features/  # dashboard, workspace (sidebar/tabs/xterm), editor/explorer/changes/search/worktrees
│                      # (Monaco tabs + drafts + dirty-diff gutter, file tree + transfer, repository-aware
│                      #  source control + commit-graph SVG, filename+content search), scratchpad + layouts (top-bar
│                      #  popovers), settings, ⌘K palette
│   ├── src/features/guide/ # public deployed-app /guide; edit guide.md for setup/upgrade instructions
│   └── src/features/remote/ + mobile/ # remote account/pairing/settings + host-grouped project cards,
│                                     # Files/Terminals workspace, session rail and touch terminal keys
├── remote-transport/ # standalone Noise XX + bounded encrypted framing (remote protocol 4)
├── connector/ # outbound host connector: exact device approval, route allowlist, manual host leases
├── remote/    # self-hosted Better Auth service + opaque bounded WSS relay; no host content storage
├── cli/       # @puddle-code/cli (the command is `puddle`): serves the UI at localhost:7433 and
│   │          # proxies /api + /ws + /proxy to the daemon on 127.0.0.1:7434 (through the ssh
│   │          # tunnel remotely); bootstrap/handshake/attach live in src/lib/ (no process/TTY
│   │          # access there — the desktop shell reuses it; src/lib/index.ts is the deliberate
│   │          # embedder surface), the bin in src/cli/
│   ├── src/lib/auth/    # connection authority, host-only inspection and protected launcher IPC
│   └── scripts/build.mjs   # esbuild bundle + embeds both installers + copies web assets into dist/
└── desktop/   # @puddle-code/desktop (private): the Electron shell — a thin main process calling
               # startLocal() from @puddle-code/cli/lib and opening a BrowserWindow on the
               # embedded cockpit. Shell concerns only (windows, OS links, notification raise);
               # anything both shells need goes in cli/src/lib, NEVER here. Build mirrors the
               # CLI's (scripts/build.mjs); `pnpm --filter @puddle-code/desktop dist` packages it.
deploy/remote/       # self-hosted service/static app images, Caddy TLS ingress and private env example
scripts/build-tarball.mjs   # self-contained puddled release tarball for the CURRENT platform
scripts/build-cli-tarball.mjs # self-contained CLI archive; shares scripts/lib/node-runtime.mjs
scripts/install.sh          # internal daemon bootstrap, embedded in CLI/desktop; never published alone
scripts/install-cli.sh      # public CLI installer, published as install.sh
scripts/stage-installers.mjs # stage only the public CLI installer as install.sh
docs/assets/          # README imagery: cockpit hero screenshots (dark chromeless, light in Mac chrome)
docs/changelogs/      # archived per-version changelogs (see Changelog discipline)
docs/acceptance/      # manual per-phase acceptance scripts (real-agent verification CI can't do)
docs/roadmap/         # deferred feature designs with resolved decisions and implementation seams
docs/reports/         # dated investigation write-ups (root cause + measurements), e.g. perf/battery
```

## Commands

```
pnpm install            # workspace install
pnpm dev                # daemon (watch) + web (vite) for local development
pnpm build              # all packages; web assets land inside the CLI (packages/cli/dist/public)
pnpm test               # vitest across workspaces
pnpm lint               # eslint + prettier check
pnpm test:e2e           # after build: isolated daemon/cockpit process tests, no browser download
pnpm test:remote        # transport, host authority and live relay authentication tests
pnpm test:mobile        # after build: isolated HTTPS browser/connector/daemon flow (Playwright Chromium)
pnpm test:ssh           # after build: loopback OpenSSH integration (sshd + ssh-keygen required)
pnpm build:tarball      # self-contained puddled tarball for this platform (dist-release/)
pnpm build:cli-tarball  # standalone CLI archive (after build; same output directory)
pnpm --filter @puddle-code/desktop start   # run the Electron shell (after pnpm build; NOT from
                                      # inside an agent session — see the puddled warning below)
pnpm --filter @puddle-code/desktop dist    # package it (dmg/zip/AppImage via electron-builder)
```

For manual testing before a release exists: `pnpm build && pnpm build:tarball`, then
`node packages/cli/dist/index.js launch --tarball dist-release/puddled-v*.tar.gz` (or
`launch user@host --tarball …`). The daemon default port is 7434; the CLI serves the
UI at 7433. `launch` backgrounds itself once ready — pass `--foreground` when
developing so the cockpit stays attached to your terminal (`puddle list` / `puddle
kill` manage backgrounded ones; `puddle refresh` is kill-then-launch in one step, also
reachable from the UI's connection banner).

`puddle install <daemon|desktop>[@version] [user@host]`,
`puddle upgrade [cli|daemon|desktop][@version] [user@host]`, and
`puddle remove <cli|daemon|desktop> [user@host]`
manage the three components (SPEC §10): install ensures presence, upgrade
moves to newest (or the named version; bare `upgrade` covers the installed local
daemon and macOS desktop, then the CLI), remove uninstalls behind y/N confirmations — daemon
removal keeps ~/.puddle's data unless purged, and sweeps worktrees for
uncommitted/unpushed work first. cli/desktop are client-machine only;
`upgrade desktop` still installs the macOS app when none exists (writable
`/Applications`, else `~/Applications`); Linux desktop stays in-app-update
only (an AppImage has no fixed install path).

Standalone CLI installs live under `~/.local/share/puddle/cli` (XDG/`--prefix`
overrides supported), with a `~/.local/bin/puddle` wrapper. CLI upgrade/removal
uses the actual installation channel; daemon removal cannot delete the CLI.
Keep old standalone release trees during upgrades: live cockpits serve their assets.
The remote app and new GitHub releases publish only the CLI installer at
`/install.sh`. Install daemon/desktop components through the CLI; the embedded
daemon bootstrap still fetches GitHub archives automatically on first local/SSH
connection. Rebuild the app when installer logic changes. See SPEC §10 and
`docs/mobile-access.md`.

On an SSH host where the installer selected `nohup` but the host reaps that
child as soon as its exec channel closes, `puddle launch` falls back to an
SSH-attached daemon for the cockpit's lifetime. Closing that cockpit cleanly
interrupts live PTYs; SQLite state, worktrees, logs, agent configuration and
agent session refs stay under `~/.puddle`, and boot reconciliation/auto-resume
restores them on the next launch by default (or leaves them resumable when
host auto-resume is disabled). The fallback is allowed only after the
recorded nohup PID is dead — never start a competing daemon beside a live or
supervised one.

> **Never launch `puddled` from inside a coding-agent session** (e.g. a Claude Code terminal, including these dev sessions). The daemon inherits that agent's orchestration env vars — `CLAUDECODE=1`, `CLAUDE_CODE_*` — and passes them to the agents it spawns (PtyManager uses `{...process.env}` by design). A `claude` that sees `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` treats itself as a nested child and **does not write a resumable conversation transcript**, so `--resume` silently fails with "no conversation found" (verified against Claude Code 2.1.209: the identical session persists a transcript with these unset and writes nothing with them set). Start the daemon from a plain shell (systemd/launchd does this in production, so real deployments are unaffected). If a session won't resume during development, check the daemon's env first (`ps eww <pid> | tr ' ' '\n' | grep CLAUDE`).

## Conventions

- The `pudl` command ships with the CLI and executes puddlang programmes as trusted single-file TypeScript on an existing local/SSH daemon (protocol 24.0, host Node 22.21.1+). Agent control belongs in provider folders under `agents/`: all four supported agents offer persisted interactive/headless modes. Codex interactive control uses its existing proxy; other interactive controls correlate prompt hashes through native hooks/plugins. Headless control resumes exact native refs and requires a successful structured result plus exit zero. Keep flags and parsers provider-owned; never infer replies from terminal quietness or catalogue discovery. Human input takes over hook-driven asks; custom stop hooks may continue past interactive completion (see the usage guide). Keep runs distinct from placement/conversation/runtime identities, recheck profile ownership per operation, retain account selection without fallback and never replay interrupted runs. Remote leases and the connector allowlist exclude puddlang. Automatic agent MCP binding, delegated credentials and descendant budgets remain deferred; see `docs/puddlang.md`.

- **British English everywhere**: comments, documentation, commit messages, UI copy, and identifiers you choose (`colour`, `initialise`, `behaviour`, `licence` as the noun). Exception: never rename third-party API surface — CSS `color`, `Array.prototype.normalize`-style library methods, and external config keys keep their canonical spelling.
- TypeScript strict; no `any` without a comment justifying it.
- Every REST/WS shape is a zod schema in `packages/shared`; daemon validates input, web imports the inferred types. Never define an API shape locally. The schemas are a versioned protocol: any wire-shape change bumps `PROTOCOL_VERSION` per `packages/shared/PROTOCOL.md` in the same commit (additive → minor, breaking → major).
- Launcher compatibility and daemon-update approval share `cli/src/lib/handshake.ts`, reached through host control/inspection before API access. Desktop and CLI supply confirmation callbacks; background CLI launches relay the prompt over private parent/child IPC. Cancellation, missing approval and `--no-upgrade` never update an older live daemon. Later HTTP/reconnect checks only verify; never add a second upgrader or bypass the host authority boundary.
- Connection authority lives in daemon `security/` and CLI `lib/auth/`; browser credentials, connection tokens, host authority and agent signal nonces have separate audiences. Never read a remote master token into the client, persist a connection token, or put invitations in registry records/background logs. Renew streams only through explicit resource ids on the client-participating control channel. Revocation detaches viewers without stopping agents; reconnect never replays uncertain writes. The shared production browser gateway also fronts Vite. Settings → Remote & Sync uses cockpit-local `lib/remote-access.ts` over the current local/SSH transport; registration secrets travel through stdin and host inspection returns public metadata only.
- Mobile access uses self-hosted Better Auth Google/GitHub OAuth only (at least one provider, public signup with provider-verified email, no email/password delivery or recovery), separately trusted application delivery, maintained Noise XX and exact host-approved browser keys. Remote protocol 4 is separate from daemon/cockpit protocol 24.0. Each host/profile has an independent registration, account binding, identity and browser grants under `remote/profiles/<profile_id>/`; the single supervised connector reloads only changed profiles. Remote leases carry a host-selected profile; daemon `security/profile-access.ts` checks HTTP access and filters WS events. Local/SSH leases stay host-wide. Profiles still share OS-level terminal/filesystem authority. Startup deletes legacy host-wide registrations and revokes their grants; no profile inherits them. Desktop-led account registration uses a five-minute browser-approved hash; its one-use verifier remains in cockpit memory and goes only to the machine status/redemption endpoints. Host identity generation and browser approval remain on the host. `puddle remote … --profile <profile-id>` and Settings → Remote & Sync manage host registration, pairing, approval/revocation, disable and local/SSH-only identity reset; desktop settings also delete saved registrations, revoking browsers while retaining the host identity and revoked audit records. Deletion/replacement retires the old relay record through machine-only `/remote/unregister`; private `retired/` files under each registration retain at most 32 routing contexts for bounded, idempotent retry, including supervisor starts without an active config. Disable/offline hosts remain registered; never deduplicate by label. Deletion is capability-detected and never exposed through the encrypted remote admin protocol; configuration lives in `~/.puddle/remote`. The complete remote operation allowlist is `connector/src/policy.ts`. New remote operations require review there and in daemon `security/profile-access.ts`; never bypass the shared host lease boundary. See `docs/mobile-access.md` and `docs/acceptance/mobile-access.md`.
- Authentication verification uses isolated temporary homes, sanitised subprocess environments and deterministic fake agents. `test:e2e` exercises actual built cockpit replacement; `test:ssh` provisions an ephemeral loopback SSH server. Browser/desktop rendering and interactive SSH acceptance remain manual in `docs/acceptance/connection-authority.md`.
- Puddle home initialisation migrates owned legacy `0755` directories to `0700` before authority access; never rely on `mkdir`'s mode to change an existing directory. Keep `scripts/install.sh` aligned with shared `initialisePrivateHome`; symlinked, foreign-owned and group/other-writable homes remain rejected, and authority subdirectories retain strict validation. Migration tests must include legacy permissions, not only private `mkdtemp` homes.
- Agent-specific behaviour (flags, env vars, session-file locations, status regexes, foreground process recognition) lives ONLY in that agent's folder under `packages/daemon/src/agents/<id>/`; `index.ts` exports its adapter. Shared contracts and provider-neutral helpers stay at the `agents/` root. Core session logic must stay agent-agnostic. When you verify a CLI flag against an installed agent version, record the version you checked in a comment in the adapter.
- Terminal-session agent icons are transient hints from `sessions/terminal-agent-monitor.ts`, using the main PTY’s foreground process ancestry and adapter-owned `matchesProcess` hooks. Never convert the placement to an agent, adopt its conversation, change its activity status, or inspect extra shell tabs to choose the session icon; clear hints on exit/suspension and retain terminal-blue styling. A separate notification observation uses the recognised main-PTY agent’s adapter patterns: explicit busy evidence arms one idle notification; a successful process scan can establish child exit, whereas suspension, backgrounding and inspection failure cannot.
- Desktop SSH authentication keeps only the latest askpass request per original SSH target; replace visible and queued stale requests, cancel on helper disconnect/SSH parent exit, and keep distinct hosts serial. Attach prompts to the target's cockpit window (the connect dialogue/picker during initial connection), display the target, and cancel queued/visible requests and reject late helpers when that host closes. Never infer host identity from password/2FA prompt text or the focused window.
- Native file-manager reveal belongs in `cli/src/lib/file-manager.ts`, shared by local browser and desktop cockpits. `GET/POST /cockpit/file-manager` requires cockpit browser authority and exact mutation Origin; advertise and dispatch only for the actual local target, never from a localhost URL heuristic. Keep paths bounded and absolute, pass literal OS arguments without a shell, recheck authority after filesystem inspection, and never open a file through its associated application. File rows, folders, empty tree space and path-backed tabs share the menu action; remote transports and older cockpits omit it.
- Desktop forwarding links obtain an application-scoped proxy invitation in the authorised renderer before opening the system browser, which does not share Electron's login. Terminal links and port chips share `ports/forward-link.ts`; browser cockpits keep the reusable landing page and synchronous tab opening.
- Desktop notification focus requires trusted typing, pasting or clicks inside the notifying session’s main terminal within five seconds; passive window/tab focus, scrolling and PTY output never suppress alerts. Desktop clicks explicitly activate or open the exact session tab even when its URL is already selected. Desktop notifications use bounded main-frame IPC and native Electron delivery; never treat the preload bridge as an OS permission grant. All desktops show host/project, session and preview in that order: native subtitle on macOS, escaped ToastGeneric text blocks on Windows (retain silent audio), and session-first body on Linux. Capability-detect `notificationSubtitles` before sending the optional subtitle to older shells. Settings exposes a test and the last delivery result, with permission/signing guidance for macOS `UNErrorDomain` code 1. macOS releases without a Developer ID certificate use an ad-hoc app signature, verified during release; unset empty `CSC_LINK`/`CSC_KEY_PASSWORD` before packaging and pass `--publish never` so only the release job publishes artefacts; never disable signing with `identity=null`, which leaves an unbound Electron linker signature. Notification delivery still requires system approval; removing quarantine is not notification authorisation, local ad-hoc delivery and click handling were verified manually; release signature checks never emit test notifications.
- Terminal URL and file-path links share `terminal/link-buffer.ts` for bounded wrap reconstruction and cell coordinates. Keep URL joins conservative (there is no host existence check); file paths retain resolve-validated alternatives. Standalone copied links are normalised in `terminal/copy-text.ts`, preserving surrounding prose and other Markdown.
- Terminal Mermaid/LaTeX rendering reads bounded xterm buffer regions through `terminal/rich-output-buffer.ts` and fits overlays to the original cells. Reuse the Markdown renderers and theme/security settings; never rewrite PTY bytes or resize its grid for rich output. Keep source toggles, selection, redraw invalidation, scrollback and alternate buffers covered.
- Terminal clipboard handling lives in `terminal/clipboard.ts`: unsolicited OSC 52 writes are stashed; explicit copy gestures may accept one delayed reply. Keep replay/focus cancellation, clipboard-read denial and Command+C versus interrupt semantics covered. Agent-owned mouse selection remains intact.
- Outside tmux, Codex 0.157.1 skips OSC 52 after a successful native clipboard write unless an SSH marker exists. Its adapter supplies an empty `SSH_TTY` when absent (preserving real values); the separate lifecycle app-server retains its own environment. Clipboard acceptance must use separate host/client clipboards: same-machine native copying can mask missing terminal output. See `docs/reports/2026-09-26-codex-clipboard.md`.
- Terminal attach and disk snapshots must preserve mouse encoding as well as tracking. The pinned xterm serialiser omits encoding; `pty/xterm-mouse-encoding.ts` restores it from emulator state. Keep normal/alternate buffers, disabled tracking and encoding resets covered when changing this boundary.
- Compilable file support uses providers under `packages/daemon/src/`: generic mode/watch/run orchestration stays in `compilation/`, while tool discovery, command arguments, dependency parsing, artefact promotion, and source navigation stay in the provider (LaTeX in `latex/`). The web consumes advertised extensions, actions, eager support and artefacts; never hard-code a generic compile path to TeX. Code providers in `code/` run only on demand. Their only execution path is a terminal (25.0): clients open a fresh terminal placement in the source project/worktree, run from the source directory, and retain a shell after exit/interrupt. Compiled recipes build in that same terminal and execute a fresh managed binary only after a successful build. Never replay the command on resume; retain active run directories until their terminal exits. There is no captured-output fallback for programming languages. Notebook cells use Puddle Monaco editors over the shared JSON buffer, drafts, undo and conflict handling. Protocol 25.2 adds explicit cell/range execution and live output; header/open-tab Run All shares that path, while Run to Executed Copy retains compilation artefacts. Apply results by stable cell id and source snapshot without replacing newer edits, and preserve outputs during typing. `notebooks/` owns persistent Jupyter kernels keyed by canonical notebook path until explicit restart/shutdown or daemon exit; Interrupt preserves variables, dead kernels never replay a run, and live execution reuses the same bounded Jupyter bridge. Notebook Python selection (25.1) discovers incomplete environments too; only explicit installation invokes fixed packages through that interpreter's pip. Private temporary kernelspecs pin the exact Python, preserving venv symlinks; never overwrite host kernelspecs. New blank `.ipynb` files receive a version 4 notebook template, while saves of existing files remain literal. Shared bounded process execution lives in `compilation/process.ts`. Settings → Editor uses a language picker and the same command form as per-file tab settings. Resolve commands as file override → profile language default → source-aware provider default; preserve existing file overrides and keep host-specific commands out of portable settings sync.
- Agent storage lookup hooks may be asynchronous. Any account-wide discovery must yield to the daemon event loop, bound file reads to the metadata actually needed, and reuse unchanged results across polls; putting synchronous filesystem work inside a background promise still freezes every API and PTY.
- Native conversation discovery returns normalised metadata only and never transcript bodies. The core owns eligibility, canonical-worktree mapping, watch debounce, adaptive fallback polling, missing confirmation, and placement materialisation; adapters own store roots and parsing. Exact live rebinding comes only from an adapter lifecycle channel — catalogue recency must never be used to guess the active conversation.
- Hook/plugin lifecycle channels declare an adapter-owned installed-version check; a failed or unsupported check must launch normally with `native_sync: fallback`, never claim full synchronisation optimistically.
- A live agent is an internal stable runtime whose `activeSessionId` may change after a native clear/resume/fork. Keep PTYs, shells, sidecars, environment, signal nonce, ports, logs/screens, and the one-runtime-per-conversation index together when changing this path; placement switching is serialised by the lifecycle mutex.
- Adapters whose CLIs mint conversation ids (currently Codex and OpenCode) snapshot their existing account/cwd refs before spawn and resolve only a newly appeared ref; recovery validates cwd + native conversation creation time when catalogued, falling back to the placement creation time for legacy rows. Never recover them as merely "the newest conversation in this directory" — concurrent/shared-worktree sessions then collapse onto one agent session ref.
- **Resolved status finding (2026-08-03):** Codex 0.146.0's live idle composer is `› … <model> · <directory>` after ANSI stripping; the older `? for shortcuts` guess never appears. The adapter and Phase 7 acceptance table pin the observed regex. OpenCode and Gemini CLI status patterns remain awaiting live verification.
- Storage exhaustion must not interrupt live PTYs. `storage/` owns asynchronous capacity checks and bounded, coalesced runtime observation retries; log/snapshot writers own bounded history and retry backoff. User writes and native switches are never replayed. Keep GET `/api/storage` local/SSH-only (host-wide paths), and preserve 507 errors plus explicit unsaved-state warnings.
- SQLite is the source of truth for sessions; PTYs are ephemeral attachments. Schema changes require a migration in `packages/daemon/src/db/migrations/`.
- Every Git mutation shares the `WorktreeManager` mutex keyed by the canonical Git common directory (`gitMutexKey`), so linked worktrees, source-control actions, fetches, and worktree lifecycle commands cannot race Git's lock files.
- New repositories default to an empty `default_base_branch`; migration 023 clears all existing defaults once, preserving later explicit choices. An empty repository default follows the branch currently checked out at its registered clone path for each new agent/terminal (detached HEAD falls back to `main`). Resolve it under the Git mutex; keep the setting empty and existing placement branches fixed. Explicit session branches/directories take precedence. The new-session dialogue must not submit an automatic branch/directory preview as a fixed choice. Sharing the registered clone also accepts its current unborn branch before the first commit; resolve that directory before requiring a branch ref, without synthesising a commit.
- This is a public MIT repo: no company-, team-, or person-specific names anywhere (code, tests, docs, examples). Do not copy code from AGPL-licensed projects.
- **Terminology**: a "session" is always an immutable _Puddle placement_ (`sessions.id`: project + canonical worktree + conversation overlay). An agent's own thread is a "native conversation", stored in `agent_conversations`; its public identifier is the "agent session ref" joined onto `Session.agent_session_ref`. A live "runtime" owns the PTYs and may move between placements. Never conflate these three identities in code, comments, or UI copy.
- Design tokens in `packages/web/src/styles/tokens.css` are the single source for colour, type, radius, and spacing; the Tailwind config, xterm theme, and Monaco theme derive from them. Never hard-code a hex value or font stack in a component. UI conventions live in `SPEC.md` §12.
- Remote Web Push is an explicit device opt-in. Connector-local `/api/notifications/push` and `/test` bind to the admitted Noise device under its participating lease; browsers never supply a device id. The daemon sends a bounded conversation preview and exact placement ids over the owning profile’s private connector IPC after checking notification preferences and project mute. Adapter-owned `notificationOutput` reads exact bounded assistant text; other agents use the terminal emulator tail. Dispatch rechecks host enablement and exact device grants without creating or renewing a browser lease. The service stores private vendor subscriptions and VAPID keys, routes only opaque AES-GCM previews (legacy subscriptions retain generic alerts), restricts vendor destinations, and expires dead subscriptions. Capability-detect `remote_notifications`/`push_public_key`, then `remote_notification_previews` (daemon 22.5 plus connector) and `push_encrypted_previews` before exchanging a device preview key inside Noise. Keys never reach the service. Worker/native clicks carry validated project/session destinations and remote host ids across reloads. Every received push must show a notification (Safari’s visible-only requirement); opted-in mobile push also alerts while focused. Live delivery is suppressed for confirmed push bindings, and identical event tags replace racing alerts. Live web/mobile alerts and encrypted push use `[ABBRV] Session title`, sharing the project rail’s saved abbreviation or derived fallback through `shared/project-abbrev.ts` and the bounded title formatter. Prefix only the private push copy, preserving plain live event titles for native desktop subtitles. Never cache host content in the notification worker. Notification tests expose progress and results beside their controls, bound browser reads, and reconfirm the host subscription; late browser replies must not resume a timed-out test.
- Remote/mobile UI distils the cockpit: reuse dashboard card content, session glyphs, shared dialogues and the new-session dialogue. Read each profile's desktop project/session order and use the shared ordering helper. The terminal title opens the shared dropdown for active-project sessions; the host/project breadcrumb returns home. Keep host catalogue connections separate from the singleton workspace transport, scope caches/drafts to service/account/host, and detach hidden terminals. The mobile session rail sits on the left and expands over the content from that edge; it fits five-character project labels, uses desktop gold controls with status-coloured session glyphs, and aligns its collapse control with the workspace toolbar. It shows only the active project's non-archived sessions; Files uses bounded tree/file reads and an eye toggle for the shared Markdown/HTML/media previews, including validated custom host roots. Long-pressing a file opens Download, using the same 8 MiB JSON `preview-asset` route as remote previews (21.1); pending saves cannot cross hosts or connection generations. PDF.js consumes fetched bytes directly because the remote CSP forbids blob requests; HTML scripts run only inside the sandboxed `/preview.html` shell with its separate response CSP, never by relaxing the app’s script policy. The terminal image picker shares desktop image paste, preserves images up to 4 MiB, recompresses larger originals up to 20 MiB with a notice, shows progress/cancellation, and inserts into the last-used input (composer draft or terminal) without submitting or crossing connection generations. Connector-local `paste-upload` stages at most one 4 MiB image per browser connection in acknowledged 64 KiB chunks, then dispatches the existing paste route under the host lease; feature-detect `remote_image_uploads` before calling it (21.2). Ordinary requests retain their 256 KiB cap. Remote allowlist additions belong in `connector/src/policy.ts` with denial tests for neighbouring operations.
- Collapsible disclosures use `components/ui/disclosure.tsx`: native keyboard semantics with a Lucide chevron, never browser triangle markers. Connected browsers share compact account-style cards; desktop wraps them in the shared disclosure, and pending identities remain visible before approval. Registration opens the browser directly from the UI click on the client machine, never through a daemon opener. Remote status polls must not disable or relabel controls; only explicit operations show pending state. Remote access and profile sync share Settings → Remote & Sync; both browser lists hide revoked records while the host retains the audit history.
- Shared terminal touch gestures distinguish quick scrolling from held local selection. Selection must never send agent mouse input or copy automatically; Copy requires an explicit tap. The same terminal menu offers Paste even on empty cells; read the clipboard only on tap, preserve xterm paste encoding without adding Enter, and cancel insertion after a terminal/host/connection change. Mobile file text uses native DOM selection with held-drag extension and the same Copy action, and its path dialogue resolves files/directories against the current browse root through the existing nil-session directory target.
- iOS terminal input lives in `terminal/ios-input.ts`: it keeps xterm's hidden textarea filled with blank padding (never typed text) so the spacebar trackpad requires two native caret steps per arrow key and ignores smaller movements, and forwards only keyless insertions/IME commits that would otherwise edit that padding. Never mirror or reconstruct the application's input; taps stay with xterm so mouse-aware applications receive them. Other platforms keep xterm's input unchanged. Key strips use `mobile/TerminalKey.tsx`: one-shot Ctrl/Opt/Shift modifiers live in `terminal/input.ts` and `touch-modifiers.ts`, accept CSI/SS3 arrows without consuming device replies, and unmodified arrows follow the live cursor mode. Keys activate on touch release, and `keepTerminalFocus` makes any strip tap keep or raise the keyboard.
- Editor view state lives in bounded browser-local stores under `features/editor/`, scoped to transport and tab/layout identity. Save Monaco state before model disposal; consume explicit source reveals once. Restore preview positions before publishing scroll, and terminal positions only after replay. PDF tabs use the owned PDF.js viewer; only generated LaTeX PDFs enable inverse SyncTeX. Restore after page geometry is ready, anchor pinch zoom after layout, and never capture loading or hidden zero-sized surfaces.
- Every hook in a React component runs **above** that component's loading gate. `pnpm lint` enforces `react-hooks/rules-of-hooks`: a hook after an early return changes the hook count when the gate flips and React blanks the whole page (this shipped once, in v0.0.22).
- Layout-tree node ids are **unique within a tree** (`layout-tree.ts` "Node identity"). Anything that COPIES a tree re-ids the copy (`reidNodes`) and anything that combines trees deduplicates (`dedupeIds`): ids are the tiling area's React keys and resizable-panel ids, so a repeat aliases panes and throws "Panel ids must be unique" mid-render (this shipped in v0.0.22–v0.0.23, when it blanked every window).
- A render throw is now caught (`components/error-boundary.tsx`, mounted around the routed view and at the root — SPEC §12), so a crash is a legible message rather than a white page. That is a net, NOT a licence: it neither fixes nor hides anything, the console still gets the error and component stack, and the two invariants above are still what keep the app rendering.
- Prefer small modules with one responsibility over utils grab-bags. If a file passes ~300 lines, look for a seam.
- Web production builds use `vite.build.config.ts` with only web dependencies; the default `vite.config.ts` adds the authenticated development cockpit gateway. Keep CLI imports out of the production configuration so filtered Docker installs remain buildable.
- Remote runtime images explicitly make package metadata, configuration and public assets readable by their unprivileged users. The service's `/data` must start at mode `0700`, owned by UID 10001: Docker copies this metadata into fresh volumes. CI builds from a private checkout and runs `node deploy/remote/test-images.mjs` with a real service volume, read-only filesystems and dropped capabilities; never rely on the operator's umask or relax permissions on deployment secrets. The app's Caddy binary must have no privileged-port file capability: it serves port 8080.

- Remote Settings pairs this device through `PairDeviceDialog` (camera or pasted link); host registration starts on desktop. Keep scans inside the current app context so a Home Screen app uses its own IndexedDB identity. Validate invitations through the shared schema and retain exact host approval. Camera frames are decoded locally, and tracks stop on dismissal/backgrounding, including late permission grants. The application permits its own camera; sandboxed previews deny it.

## Housekeeping — read this, future agents

Notebook widgets use a persistent, separately addressed Jupyter IOPub subscriber
alongside cell execution. Protocol 25.4 exposes bounded widget snapshots/events
and explicit comm writes tied to the current kernel generation; reconnect only
observes and must never replay a widget action. Keep Output capture owned by this
subscriber between runs, binary buffer paths intact, and remote notebook access
denied by both the connector and profile authority. The official HTML widget manager
runs only in an opaque-origin iframe with a validated comm-only MessagePort. Bundle
core controls locally; load compatible AMD extensions by their declared npm
module/version, requiring explicit consent for saved notebook extensions. Never
expose cockpit credentials or execution APIs to widget code, relax the main CSP,
or execute widgets in remote/mobile previews. Persist state through the shared
notebook draft, including executed-copy metadata. See the Jupyter integration
audit in `docs/reports/2026-10-25-jupyter-integration.md`. CI provisions an isolated,
pinned Python environment for real-kernel and Chromium widget tests; keep saved
state, binary uploads, reconnect and echo-disabled persistence covered.

This file is living documentation and part of the definition of done for every change:

- If your change alters the repo map, commands, conventions, adapter interface, or resolves an open question from `SPEC.md` §15 — update this file (and `SPEC.md` where relevant) **in the same commit**.
- **`SPEC.md` must never drift from the code.** Any change to API surface, data model, behaviour, or design decisions updates the corresponding SPEC section in the same commit — an endpoint, flag, or colour that exists only in code (or only in SPEC) is a bug.
- Prune as you go: stale instructions are worse than missing ones. If you find a section here that no longer matches the code, fix it even if your task didn't touch it.
- Keep this file skimmable. Details belong in `SPEC.md` or code comments; this file is the map, not the territory.
- Record resolved design decisions (e.g. "codex resume verified as `codex resume <id>` on v0.x.y") in the place a future agent will look first: the adapter comment, and a line in the changelog.

## Changelog discipline

CI and release jobs install dependencies through `scripts/install-ci.mjs`, which
uses the running Node installation's bundled headers for native source builds.
Keep that header override scoped to installation so Electron packaging can use
its own headers; preserve the Linux release compiler and ABI settings.

The npm release job uses GitHub OIDC trusted publishing, with npm 11.21.0 and
job-scoped `id-token: write`; it never reads `NPM_TOKEN`. Configure the package's
trusted publisher for this repository and `release.yml`, with direct publishing
allowed and no environment name. Keep the source checkout on the triggering
release tag so npm provenance names the built commit. See SPEC §10 for recovery.

`CHANGELOG.md` in the repo root is the **rolling changelog for the next release**. Rules:

1. Every user-visible or behaviour-affecting change updates `CHANGELOG.md` **in the same commit/PR** as the change. Internal-only refactors with zero behaviour change may be skipped.
2. Structure follows [Keep a Changelog](https://keepachangelog.com): a single `## [Unreleased]` section with `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security` subsections (include only non-empty ones). One line per change, imperative mood, reference the PR/issue when it exists.
3. **On publishing version X.Y.Z**:
   - Append `X.Y.Z` and that release's exact protocol to `RELEASE_PROTOCOLS` in `packages/cli/src/lib/component-versions.ts`; this immutable offline ledger identifies older installed components without executing them. Daemon archives also carry `CONNECTOR_PROTOCOL`; keep the historical connector lookup in that module accurate. The displayed `cN` suffix is informational and never enters CLI/desktop compatibility checks.
   - Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
   - Copy the file to `docs/changelogs/CHANGELOG-vX.Y.Z.md` (this is the permanent archive).
   - Reset the root `CHANGELOG.md` to the empty template (see the file's header comment), pointing at `docs/changelogs/` for history.
4. Never edit archived changelogs in `docs/changelogs/` except to fix factual errors.
