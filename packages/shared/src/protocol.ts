/**
 * The communication-protocol version — NOT the app version (SPEC §6,
 * "Protocol versioning and compatibility").
 *
 * Same `major` ⇒ CLI/UI and daemon are compatible in both directions; an
 * older daemon `major` requires approval to update it. Bump rules
 * live in PROTOCOL.md at this package's root — read it before changing any
 * schema in this package.
 */
// 6.0 (2026-07-15): major bumped with no schema shape change, on purpose —
// forces every connected daemon to hit a major mismatch on the next handshake
// and auto-upgrade onto this release (see PROTOCOL.md, "The rule").
// 6.1 (2026-07-15): additive — `Session.osc_title` (the terminal-title
// "sequence" name) and the `renamed` message's `osc_title` field, plus the
// profile setting `tabTitleTemplate` (a loose key).
// 6.2 (2026-07-15): additive — POST /api/sessions/:id/unarchive (archive is now
// a reversible hide, not a teardown), and the profile setting `restartTemplate`
// (a loose key) for the resume-after-restart launch text.
// 7.0 (2026-07-17): breaking — workspace ui_state re-keyed from (project,
// profile) to profile alone (the editor area is shared across projects):
// GET/PUT /api/projects/:id/state moved to /api/profiles/:id/state, with no
// cross-profile seeding.
// 7.1 (2026-07-18): additive — the profile setting `sessionDefaults` (a loose
// key): per-kind seed defaults for the new-session modal (base branch,
// separate branch, separate directory).
// 7.2 (2026-07-20): additive — tree entries carry an optional `symlink` flag,
// and a symlink's `type` now reports its resolved target kind (`dir`/`file`)
// so symlinked directories are explorable; `symlink` stays reserved for a
// broken or worktree-escaping link. Old clients ignore the field and already
// handle the `dir`/`file` values.
// 7.3 (2026-07-20): additive — the Scratchpad endpoint group
// (GET/POST/PATCH/DELETE /api/scratchpad): a per-profile bank of prompts/notes,
// each project- or profile-scoped, plus the loose `right_panel` ui_state key
// selecting the right sidebar's sessions/scratchpad view.
// 7.4 (2026-07-20): additive — a profile carries an optional `icon` (lucide
// name) and `icon_colour` (theme-colour key); both settable via PATCH
// /api/profiles/:id. Old clients ignore the fields and render the default glyph.
// 7.5 (2026-07-20): additive — the `home` PTY stream (a project-less shell in
// the daemon host's home directory; `spawn-shell` on it reuses the live shell)
// and the `kill-shell` client message (terminate a shell term, never the agent).
// 7.6 (2026-07-21): additive — the profile setting `hotkeys` (a loose key):
// per-profile keyboard-shortcut overrides (action-id → binding string).
// 8.0 (2026-07-21): major bump with NO schema change, on purpose — forces every
// connected daemon to hit a major mismatch on the next handshake and auto-upgrade
// onto this build (see PROTOCOL.md "The rule"; mirrors the 6.0 bump). Rolls up the
// additive 7.x features whose daemon-side code an older 7.x install still lacks.
// 9.0 (2026-07-24): captured session environment (SPEC §4). Additive surface —
// GET/DELETE /api/sessions/:id/env (captured var names + byte sizes, never
// values) and the profile setting `captureSessionEnv` (a loose key, default
// true) — but bumped major by decision: the release also changes daemon-side
// PTY behaviour (shell hook injection, OSC 7733 stripping), so every connected
// daemon must auto-upgrade onto this build rather than sit on 8.x.
// 9.1 (2026-07-24): additive — editor tab refs carry an optional `view`
// ('source' | 'preview') so a markdown/HTML tab's rendered-preview mode
// persists in `ui_state.layout_tree` (SPEC §8). Old clients/daemons ignore or
// round-trip the field (the snapshot is a loose object).
// 9.2 (2026-07-27): additive — config.json gains `displayName` (a user-chosen
// host label, editable in Settings → Host) and GET /api/host reports it as an
// optional `displayName` the UI prefers over the OS hostname; the upload route
// (POST /api/worktrees/:sid/upload) now honours relative paths in multipart
// filenames, creating intermediate directories, so folder drag-and-drop works
// (old daemons flatten to basenames — the UI feature-detects via this minor).
// Also in 9.2: the retired `ui_state.right_panel` key (the Scratchpad left the
// right sidebar for a top-bar popover) went optional-without-default, so the
// daemon stops injecting `'sessions'` into every stored snapshot; peers in
// both directions tolerate its presence and absence.
// 9.3 (2026-07-28): additive behaviour — POST /api/sessions/:id/archive now
// accepts a LIVE session (the daemon kills it as part of archiving) and is
// idempotent on an archived one, instead of 409ing `session_live`. No shape
// change; a newer UI on a 9.2 daemon degrades to the old conflict toast.
// 9.4 (2026-07-28): additive — POST /agent-signal (outside /api: nonce-gated,
// no bearer), the agent-hook status side-channel. The daemon injects
// PUDDLE_AGENT_SIGNAL_URL/_NONCE into agent PTYs; hook processes report
// working/waiting_input, which overrides the regex detector once seen.
// 10.0 (2026-07-28): major bump with NO further schema change, on purpose —
// forces every connected daemon to auto-upgrade at the next handshake (see
// PROTOCOL.md "The rule"; mirrors the 6.0/8.0 bumps). This release changes
// daemon-side behaviour the UI silently depends on — hook-driven status
// detection (a 9.x daemon leaves sessions stuck green) and archive killing
// live sessions — so no daemon may sit on 9.x. Ships the unreleased 9.3/9.4
// additions above.
// 10.1 (2026-07-28): additive — optional computed `stale_running` on the
// session shape: a `running` agent whose transcript has been quiet for over
// an hour, advisory only (the UI hints, the daemon never intervenes).
// 10.2 (2026-07-31): additive — the read-only worktree routes (GET tree /
// file / media / download) accept an optional absolute `?root=` override for
// the explorer's parent-directory browsing (mutations and PUT never do), and
// `editorTabRefSchema` gains the matching optional `root` + `external` kind.
// 10.3 (2026-07-31): additive — profile-scoped untitled drafts (SPEC §8):
// POST/GET/PUT/DELETE /api/profiles/:id/untitled[/:name], plus the `untitled`
// editor-tab kind whose `session` is the nil uuid (worktree-agnostic).
// 10.4 (2026-07-31): additive — PUT /api/worktrees/:sid/file now accepts the
// `?root=` override (10.2 introduced it read-only): `external` tabs are full
// editors, saving to the absolute file their GET read. The fs mutation
// routes still never take a root.
// 10.5 (2026-07-31): additive — GET /api/agents entries gain optional
// `binary` (the executable the adapter spawns) and `available` (whether it
// resolves on the daemon's PATH). An unavailable agent is rejected up front
// with 424 `agent_not_installed` on login, session create/resume and migrate,
// instead of spawning a PTY that dies silently. Older daemons omit both
// fields and the UI then assumes available.
// 10.6 (2026-07-31): additive — POST /api/sessions/:id/handoff {account_id},
// the tier-2 cross-agent continuation (SPEC §5). Unlike /migrate it returns a
// NEW session: one created in the source's worktree and branch on a different
// agent, seeded with a briefing built from the source's transcript plus the
// branch's commits and status. The source session is left untouched and the
// pair is linked by `handed_off_to` / `handed_off_from` events.
// 10.7 (2026-07-31): additive — the `notice` WS server message: a failure the
// user must SEE (an agent or shell exiting non-zero without being asked to),
// carrying the process's own last output as `detail`. Broadcast to every
// status subscriber, not just clients attached to the stream, and surfaced as
// a toast. Older clients ignore the unknown `t` per PROTOCOL.md wire rule 1.
// 11.0 (2026-08-01): major bump with NO further schema change, on purpose —
// forces every connected daemon to auto-upgrade at the next handshake (see
// PROTOCOL.md "The rule"; mirrors the 6.0/8.0/10.0 bumps). This release
// changes daemon-side behaviour the UI silently depends on: three new agent
// adapters, the tier-2 hand-off endpoint, `agent_not_installed` refusals with
// the `binary`/`available` fields the accounts UI gates on, and the `notice`
// message that carries agent and terminal failures to the user. A 10.x daemon
// serves none of it and fails quietly rather than visibly — an unavailable
// agent would still read as "logged out" — so no daemon may sit on 10.x.
// Ships the 10.5/10.6/10.7 additions above.
// 11.1 (2026-08-02): additive — POST /api/sessions accepts an optional `cwd`
// on TERMINAL sessions (a worktree-relative directory the shell starts in,
// backing the file tree's "Open Terminal in Directory"), and the session shape
// reports it back as an optional nullable `cwd`. Confined to the worktree by
// the same guard the file routes use, and rejected outright on an agent
// session. PERSISTED (migration 017), so a resume returns to the directory.
// 11.2 (2026-08-03): additive — the ui_state snapshot gains `layout_mode`
// ('profile' | 'project', absent = profile) and `project_layouts` (project id
// → { layout_tree, active_session }), backing the client's project-based
// layout setting (SPEC §11): with it on, each project keeps its own tiling
// tree while the profile row still carries the whole snapshot. Both keys are
// optional-with-default, and the snapshot is a loose object, so old peers
// round-trip them untouched.
// 12.0 (2026-08-03): major bump with NO schema change beyond 11.2's additive
// keys, on purpose — forces every connected daemon to auto-upgrade at the
// next handshake (see PROTOCOL.md "The rule"; mirrors the 6.0/8.0/10.0/11.0
// bumps). Strictly, an 11.x daemon would keep working — project-based layout
// is client-driven, and the loose ui_state schema round-trips the new keys as
// unknown fields — but that tolerance is exactly what this bump retires as a
// long-term dependency: after it, every daemon PARSES `layout_mode` and
// `project_layouts` (validating slices instead of carrying them blind), and
// no deployment lingers on early 11.x. Ships the 11.1/11.2 additions above.
// 12.1 (2026-08-03): additive — projects gain an optional `abbrev` (≤5 chars,
// stored uppercase; nullable — null derives the collapsed-rail label from the
// name as before). Accepted on POST /api/projects and PATCH /api/projects/:id,
// reported on the project shape. Older daemons omit it and the UI derives.
// 12.2 (2026-08-03): additive — the saved-layouts endpoint group
// (GET/POST/PATCH/DELETE /api/layouts): named snapshots of the centre tiling
// tree, each profile- or project-scoped like the Scratchpad, backing the
// top-bar Layouts popover. The ui_state snapshot and each `project_layouts`
// slice gain an optional-with-default `layout_ref` (the saved layout the live
// layout was last loaded from or saved as); old peers round-trip it untouched.
// 12.3 (2026-08-03): additive — the worktree fs MUTATION routes (POST
// create/rename/copy/delete) and POST upload now accept the same optional
// absolute `?root=` override the read routes have taken since 10.2 (and PUT
// file since 10.4). Every `path`/`from`/`to`/`dir` is then relative to that
// root, guarded by the unchanged `containedPath` check against it, and the
// response's `path` is relative to it too. This makes the parent-directory
// browse tree the SAME tree as the worktree's — create/rename/delete/
// clipboard/drag-move/upload all work above the worktree (SPEC §8). An older
// daemon IGNORES the param and would resolve those paths against the
// WORKTREE, silently mutating the wrong files, so the UI gates every browse-
// tree mutation on this minor (the same stance browse entry takes on 10.2).
// 12.4 (2026-08-03): additive — a **directory target** for the worktree routes.
// The NIL uuid in place of `:sid` means "no session": the route then works
// against the absolute `?root=` it is given, which is what lets the left
// sidebar bind to a project's own repository directory instead of showing
// nothing at all in a project whose sessions are archived, or which has none
// yet, or which simply has none in focus (SPEC §8). `root` is required with
// it; a real session id is unaffected. In the same bump the GIT inspection
// routes (diff/git-status/file-at/log/show) start HONOURING `?root=`, which
// they had ignored since 10.2 — a `base` diff against a directory target
// compares with the default branch of the repo registered at that path (else
// `HEAD`, so it reads as "nothing ahead" rather than erroring). No persisted
// shape changed: the nil uuid is already a valid `sessionId` (the untitled
// convention, 10.3), so an `external` tab opened from a project directory
// round-trips on any client. An older daemon 404s the nil session id and
// ignores `root` on the git routes — it would answer with the WRONG
// repository's status — so the UI gates the whole project-directory binding on
// this minor, exactly as browse entry gates on 10.2 and browse mutations on
// 12.3.
// 13.0 (2026-08-03): major bump with NO schema change beyond 12.4's additive
// keys, on purpose — forces every connected daemon to auto-upgrade at the
// next handshake (see PROTOCOL.md "The rule"; mirrors the 6.0/8.0/10.0/11.0/
// 12.0 bumps). The 12.4 directory-target behaviour the project-directory
// sidebar binding depends on (the nil-session route and `?root=` on the git
// inspection routes) is daemon-side code an older 12.x install simply lacks:
// it 404s the nil id and answers git questions about the wrong repository.
// Rather than lean on the client's feature gate to hide the binding forever,
// this bump retires early 12.x as a dependency so every deployment serves it.
// Ships the 12.1/12.2/12.3/12.4 additions above.
// 13.1 (2026-08-05): optional `hint` on the login response — adapter guidance
// the login dialogue shows verbatim. Added for Claude Code's full-TUI login
// (the TUI sits in a REPL after sign-in, so the user must be told how to
// leave it). Additive; older daemons simply omit it.
// 14.0 (2026-08-06): major bump with NO schema change beyond 13.1's additive
// `hint`, on purpose — forces every connected daemon to auto-upgrade at the
// next handshake (PROTOCOL.md "The rule"; mirrors 6.0/8.0/10.0/11.0/12.0/
// 13.0). The login flows this release fixes are DAEMON-SIDE behaviour a
// client cannot feature-detect or work around: a 13.x daemon still spawns
// `claude auth login` (no method picker — subscription only) and `codex
// login` (a browser + localhost callback on the daemon host, i.e. an empty
// panel from any remote cockpit), trusts exit-code 0 instead of verifying
// via the agent's own auth status, and sends no login `hint`. Retiring 13.x
// makes the first-run-TUI login the flow every deployment serves.
// 14.1 (2026-08-06): `theme` client WS message — the client's resolved
// terminal fg/bg, so the DAEMON answers agents' OSC 10/11 colour queries
// (which fire at spawn, before any viewer attaches — a viewer-side answer
// misses them and auto-theming agents fell back to dark). Additive: a 14.1
// client feature-detects and keeps viewer-side answering on a 14.0 daemon.
// 14.2 (2026-08-06): `terminalAppShortcuts` in profileSettings (default true)
// — whether app shortcuts win over a focused terminal. Additive; the loose
// settings object means older daemons store and echo it untouched.
// 15.0 (2026-08-09): editor tab refs' `view` gains the `linked` value — a
// rendered preview that retargets to the most recently active renderable tab
// (SPEC §8). Major, not minor: `view` is a CLOSED enum inside the validated
// ui_state snapshot, so a 14.x daemon does not ignore the new value — it
// REJECTS any PUT /api/profiles/:id/state whose layout tree carries a linked
// tab, and every workspace save from a newer client would then fail. The
// major forces those daemons to auto-upgrade at the next handshake instead.
// 15.1 (2026-08-09): additive — the `account` WS server message (an account's
// `logged_in` flag changed), broadcast to status subscribers. The daemon only
// records the flag after the adapter's own auth check answers — asynchronously,
// after the login PTY has exited and the dialog has closed — so without a push
// the accounts UI showed a stale badge until an unrelated refetch. Older
// clients drop the unknown `t` per PROTOCOL.md wire rule 1. Also in this
// release (config-file semantics, not wire): `autoResume` now defaults to
// TRUE, with config version 3 migrating a pre-3 `false` — the old
// written-back default — exactly once.
// 15.2 (2026-08-09): additive — GET /api/worktrees/:sid/resolve answers for
// the whole daemon host, not just the worktree: a file outside it returns
// external-tab coordinates (`root` + `path` relative to it), a directory
// returns `kind: 'dir'` with its absolute path (the UI binds the file tree
// there as a pinned browse), and `~` expands against the daemon host's home.
// Both response fields are optional; a 15.2 client on an older daemon simply
// never sees outside paths or directories underlined (the old 404s stand).
// The reverse skew (an old UI on a 15.2 daemon) would mis-open a directory
// link as a file tab — accepted: the CLI serves the UI and upgrades the
// daemon in lockstep, so only a stale browser tab can skew.
// 15.3 (2026-08-11): additive — repository-aware source control under every
// worktree/directory target: discovery/status for the owning repository,
// ignored nested repositories, and recursive submodules; literal confined
// stage/unstage/commit/fetch/pull/push mutations; index and HEAD-baseline file
// reads; staged/unstaged diff areas; and optional `git_area` on diff tabs.
// New clients feature-detect this minor and keep the 15.2 read-only Changes
// view when connected to an older daemon.
// 16.0 (2026-08-13): editor tab refs' closed `view` enum gains `locked` — a
// linked rendered preview that also follows the active renderable tab's
// normalised vertical scroll position (SPEC §8). Major, not minor: a 15.x
// daemon rejects a ui_state PUT containing the unknown enum value instead of
// safely carrying it, so the handshake must upgrade the daemon before any
// workspace can persist this mode. Scroll positions themselves remain
// transient browser state and add no wire shape.
// 16.1 (2026-08-13): additive — a resolved directory inside the current
// worktree/directory target carries optional `relative_path`, allowing the
// command palette's Open path action to reveal and expand it in the existing
// Files tree instead of replacing that tree with a pinned external browse.
// 16.2 (2026-08-15): additive — GET /api/sessions/:id/env entries carry the
// optional captured `value`, allowing the authenticated cockpit to copy it by
// clicking the variable name. Older daemons omit it and the UI leaves those
// names non-interactive; older clients ignore the unknown response field.
// 16.3 (2026-08-16): additive — POST /api/worktrees/:sid/transfer copies or
// moves one entry from an explicitly identified source filetree into the
// URL-addressed destination filetree. New clients keep same-tree paste on the
// old copy/rename routes and hide only cross-tree paste on older daemons.
// 16.4 (2026-08-22): additive — native conversation catalogue metadata on
// Session, POST /api/projects/:id/conversations/refresh, lifecycle agent
// signals, session-switched / sessions-changed WS messages, and optional
// structured error details for already-live conversation conflicts.
// 17.0 (2026-08-23): major release bump — force every connected daemon to
// upgrade before using the 0.1.0 native conversation runtime.
// 17.1 (2026-08-28): additive — daemon-host compilation provider discovery,
// on-demand/eager compilation, generated artefact descriptors and LaTeX
// inverse SyncTeX navigation. Editor tabs may also retain their compilation
// mode and producing provider so restored tabs preserve their behaviour.
// 17.2 (2026-08-28): additive — compilation failures may include bounded
// compiler output and normalised source diagnostics for expandable notices
// and editor markers.
// 17.3 (2026-08-28): additive — project-scoped, canonical-file compilation
// command settings, with independent manual/eager overrides and provider-owned
// command templates/placeholders.
// 18.0: separate browser authorisation and host-controlled connection leases.
// 18.1: additive — authenticated cockpit-local remote-access administration.
// 19.0: remove email login and move cockpit pairing invitations to remote protocol 2.
// 19.1: additive — local/SSH registration deletion with connector capability discovery.
// 20.0: desktop-initiated account registration with a browser-approved, hashed handoff.
// 21.0: host-authenticated retirement of deleted/replaced remote registrations.
// 21.1: additive — bounded JSON file assets for remote previews.
// 21.2: additive — connector image-upload capability and bounded upload operations.
// 21.3: additive — accept an empty repository default to follow the clone's current branch.
// 22.0: profile-scoped remote registrations and host connection authority.
// 22.1: additive — transient foreground-agent icon hints on terminal sessions.
// 22.2: additive — notification focus preference; native desktop delivery diagnostics.
// 22.3: explicit agent-notification events include terminal agents and process exits.
// 22.4: opt-in background Web Push through the approved profile connector.
// 22.5: bounded conversation previews and exact session destinations in notifications.
// 23.0: local/SSH puddlang runs, exact agent turns and profile-bound run history.
// Intentional major release boundary: upgrade clients/hosts together for puddlang.
// 23.1: per-agent interactive/scripted modes and correlated native turn signals.
// 24.0: rename the scripted execution mode to headless; no legacy wire alias.
// 24.1: optional desktop notification subtitles for host/project and session headings.
// 24.2: authenticated local-cockpit file-manager discovery and reveal requests.
// 24.3: optional compilation-provider action distinguishes code runs from builds.
// 24.4: profile language defaults and inherited per-file compilation commands.
// 24.5: optional project colours drawn from the profile icon palette.
// 24.6: daemon-owned notebook kernels and explicit kernel lifecycle controls.
// 25.0: programming-language runs always compile and execute in a terminal.
// 25.1: Python environment discovery/selection and explicit notebook package installation.
// 25.2: bounded interactive notebook cell execution, live results and input replies.
// 25.3: bounded kernel completion and inspection for notebook cell editors.
// 25.4: bounded widget state, live comms and exact kernel-generation ownership.
// 25.5: local/SSH storage diagnostics and explicit unsaved runtime metadata.
// 25.6: configurable bulk terminal-log retention, preserving restoration tails.
export const PROTOCOL_VERSION = { major: 25, minor: 6 } as const;
