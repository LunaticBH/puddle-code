# The puddle communication protocol

Protocol 25.7 adds optional `platform` (the daemon's `process.platform`) and, on
Windows hosts, `osBuild` (the Windows build number) to GET `/api/host`; absent
`platform` means a POSIX host on an older daemon, and clients infer each path's
style from the path itself. A Windows daemon emits canonical native absolute
paths (`C:\Users\a\repo`), while root-relative paths use `/` on every host. It
may answer the Windows-only error codes `invalid_name` (400, a name Windows
cannot store), `path_busy` (409, a rename or delete refused because another
program holds the entry open or permission is denied; `details.cause` keeps
the system code, `EBUSY`, `EPERM` or `EACCES`), `source_not_removed` (409, a
move to another drive copied everything but could not remove the whole
source) and `unsafe_repository` (400, refused by git `safe.directory`), and
`worktree_busy` gains an open-handle cause. The private host control channel gains the strict
`shutdown` request, answered by `shutting_down` before the daemon stops;
Windows supervision uses it in place of signals, and older daemons answer
`invalid_control`. On Windows the private control `open` and `shutdown` requests may carry an optional `challenge` (64 hex), and the `authority`, `shutting_down` and `error` answers to it carry `proof`, an HMAC-SHA256 under the home's private IPC key; Windows clients believe only a proven answer, and POSIX exchanges are unchanged. An interactive agent session on a Windows host may answer `prompt_too_long` (400) when its first prompt cannot fit the Windows command line. The cockpit launcher pipe accepts `shutdown` (answered
`stopping`), and the cockpit remote-access status may report availability
`unsupported` (Windows hosts). Remote protocol and operation allowlists remain
unchanged.

Protocol 25.6 adds `logRetentionDays` to host configuration and its patch, defaulting
to three days when omitted (zero disables age-based cleanup). New clients gate the
setting on 25.6. Retention compacts inactive bulk output while preserving the entire
replay tail and all snapshots/history needed for archived terminal restoration.
Remote protocol and operation allowlists remain unchanged.

Protocol 25.5 adds local/SSH-only GET `/api/storage` with available space/inodes,
log and database persistence health, plus optional `Session.persistence_pending`
for observed runtime status awaiting persistence. New clients gate polling on
25.5. Remote profile leases and the connector deny host-wide storage paths;
remote protocol remains 4.

Protocol 25.4 adds local/SSH-only POST `/api/notebooks/widgets` for bounded
widget snapshots and incremental comm events, and POST `/widgets/comm` for
explicit widget actions bound to an exact kernel generation. Reconnects only
observe state; writes are never replayed. Remote leases and the connector
continue to deny the notebook namespace; remote protocol remains 4.

`@puddle/shared` is the protocol package: the zod schemas in `src/` are the
single, executable description of every REST shape and WebSocket message
exchanged between the `puddle` CLI (and the UI it serves) and `puddled`. There
is deliberately no prose copy of the schema — prose copies drift. This file
only defines how the protocol is versioned. The full design is SPEC §6,
"Protocol versioning and compatibility".

## Two version numbers

- **App version** — the npm/tarball semver. Says nothing about compatibility.
- **Protocol version** — `PROTOCOL_VERSION = {major, minor}` in
  `src/protocol.ts`, reported by `GET /api/version`. This is the
  compatibility contract.

## The rule

**Same `major` ⇒ compatible, in both directions.** Everything within a major
is additive-only. When the CLI's handshake finds an older daemon `major`, it
requires explicit approval before updating it; a newer daemon tells the user
to update the CLI. There are no compatibility shims: old majors are not served.

## When you change a schema in this package

| Change                                                       | Action                      |
| ------------------------------------------------------------ | --------------------------- |
| New endpoint, new WS message type                            | bump `minor`                |
| New **optional** request/response field                      | bump `minor`                |
| New enum value that peers may safely ignore                  | bump `minor`                |
| Removing or renaming an endpoint, field, or WS message       | bump `major`, reset `minor` |
| Changing a field's type, or the meaning of an existing value | bump `major`, reset `minor` |
| Changing auth, the token flow, or the WS handshake           | bump `major`, reset `minor` |
| Comment/doc-only edits, refactors with identical wire shapes | no bump                     |

Bump the constant **in the same commit** as the schema change, update the
current-version assertion in `test/api.test.ts`, and note the bump in
`CHANGELOG.md`.

## Wire rules that keep additive changes safe

1. Receivers **ignore unknown WS message types** (an unrecognised `t` is
   dropped, not an error).
2. Receivers **tolerate unknown JSON fields** — schemas use loose objects
   wherever extension is expected.
3. A newer client on an older daemon **feature-detects** against the daemon's
   `minor` and hides what the daemon cannot do; it must not fail.

## Non-bumps worth recording

- **Phase 6 serving switch (2026-07-14)**: the CLI took over UI serving and
  the daemon's default port moved 7433 → 7434. Verified non-wire-affecting —
  no schema changed, ports are deployment configuration (the Host/Origin
  guard has always ignored them), and the `?host=`/`#token=` boot params are
  browser-side conventions that never reach the server. `PROTOCOL_VERSION`
  stayed 5.1.
- **SSH-attached daemon fallback (2026-08-13)**: the CLI now owns the daemon's
  process lifetime through an SSH exec channel when a host reaps detached
  `nohup` children. This changes bootstrap and transport lifecycle only; REST
  and WebSocket schemas, authentication, token flow, and the protocol
  handshake are unchanged. No protocol bump.
- **Public remote signup (2026-09-21)**: remove the deployment email allowlist
  and fix registration policy to the already supported open-signup behaviour.
  OAuth verification, cookies, host authority and all wire shapes are unchanged;
  remote protocol remains 2 and daemon/cockpit protocol remains 19.0.
- **Follow-clone default (2026-09-30)**: repository registration now defaults
  to the already supported empty base-branch setting, and migration 023 resets
  existing saved defaults once. Explicit empty/non-empty values, PATCH omission,
  session requests and response shapes are unchanged. This changes the default
  policy, not the meaning of a supplied value; daemon/cockpit remains 22.0 and
  remote protocol remains 3.

## Remote transport

`REMOTE_PROTOCOL_VERSION = 4` versions the separate service/connector/browser
contract in `src/remote/`. Its strict envelopes and Noise prologue require an
exact match; incompatible peers fail closed. Its introduction did not change
daemon protocol 18.0. Turning the existing server WS union into an equivalent
zod schema did not change that wire contract. Protocol 18.1 adds local/SSH
`/cockpit/remote` administration; it does not change the remote envelope or
host-authority semantics. Older connector builds are capability-detected before
the cockpit invokes their administrative commands.

Breaking changes to daemon operations exposed by the remote allowlist also
require a remote protocol bump: an unchanged envelope does not make changed
application messages compatible with a previously deployed browser build.

Remote protocol 2 removes email login from the service discovery/auth contract.
Daemon/cockpit protocol 19.0 accompanies its changed pairing invitation literal
in `/cockpit/remote`; host lease and operation semantics remain unchanged.
Deploy the service, browser and host connectors together.

Daemon/cockpit protocol 19.1 adds local/SSH registration deletion and an optional
capability in cockpit status. Older connectors keep their existing controls;
deletion is hidden and rejected until the host advertises support. The encrypted
remote admin schema excludes deletion, so remote protocol remains 2.

Daemon/cockpit protocol 20.0 adds desktop-initiated registration: an authenticated
cockpit polls a machine-only service endpoint with an ephemeral verifier, while
the signed-in application approves its public SHA-256 hash. This is a new token
flow, so the cockpit major advances. The existing connector code redemption,
Noise envelopes, pairing and host leases are unchanged; remote protocol remains 2.
The service and application must be updated to expose the new handoff endpoints.

Daemon/cockpit protocol 21.0 adds host-authenticated registration retirement via
machine-only `POST /remote/unregister`. The existing routing credential authorises
removal of its own service record only; browser Origin/cookies are rejected and
retries are idempotent. This adds an authentication flow, so the cockpit major
advances. Noise envelopes, pairing and host leases are unchanged; remote protocol
remains 2. Update the service and host connector for automatic cleanup; an older
service leaves private retirement requests queued until it is upgraded.

Daemon/cockpit protocol 21.1 adds `GET /api/worktrees/:sid/preview-asset`:
bounded base64 JSON for read-only remote previews. It uses the existing browse
root and host lease; the connector explicitly allowlists it. Existing operations
and remote envelopes are unchanged, so remote protocol remains 2. Update the
host daemon, connector and static app (including the sandboxed preview shell's
response CSP); newer clients hide the toggle below daemon 21.1.

Daemon/cockpit protocol 21.2 adds connector-local chunked image uploads and the
optional `remote_image_uploads` version capability. New browsers check that flag
before calling `/api/worktrees/:sid/paste-upload`; older connectors retain small
legacy pastes. Each chunk uses the existing bounded encrypted request envelope,
and finish uses the existing host-local paste route. Noise, authentication and
host leases are unchanged; remote protocol remains 2.

Daemon/cockpit protocol 21.3 accepts an empty `default_base_branch` on repository
creation and update to follow the clone's current branch for each new session.
At introduction, this added a previously rejected request value while non-empty
values and omitted fields retained their existing meaning (registration captured
the clone's branch; PATCH left it unchanged). Registration now defaults to empty
as described in the follow-clone default note above. Settings only offers clearing
the default on 21.3 or newer. Session requests, remote operations and authentication
were unchanged, so remote protocol remained 2.

Daemon/cockpit protocol 22.0 adds an optional profile to host-control `open` and
binds that profile to every resource in the lease. Remote connectors always
request this scope; local/SSH cockpit leases remain host-wide. The daemon filters
discovery and WebSocket events and checks direct session/project operations.
`/cockpit/remote` requires a profile query parameter; connector administration
uses validated profile envelopes on stdin (`cockpit controls 2`). This changes
authority semantics, so the daemon major advances. Remote protocol 3 accompanies
the change from host-wide to profile-only access. Upgrade the service, app,
daemon and connector together. Legacy host-wide registrations are deleted and
their approvals revoked; users register and pair each profile afresh.

Daemon/cockpit protocol 22.1 adds optional `Session.detected_agent_type`: a
transient icon hint for a recognised foreground agent inside a terminal session.
It leaves session kind, account, conversation identity and status unchanged.
Updates reuse the profile-filtered `sessions-changed` event; no remote operation
or authority changes, so remote protocol remains 3. Older daemons omit the hint
and newer clients retain the terminal glyph.

Daemon/cockpit protocol 22.2 adds the optional `notifications.when_focused`
profile preference (default true). Older peers retain their existing policy;
native notification delivery and its bounded result use capability-detected
desktop IPC only. Remote envelopes and host authority are unchanged.

Daemon/cockpit protocol 22.3 adds the `agent-notification` WS event for waiting
and unrequested agent exits, including observed agents in terminal placements.
It shares the existing session/profile-filtered status subscription. Older clients
ignore it; newer clients use status transitions on daemons below 22.3. Remote
protocol remains 3: envelopes, authority and allowed operations are unchanged.

Daemon/cockpit protocol 22.4 adds capability-detected connector-local push
subscription/test operations and private profile IPC attention signals. The remote
service adds optional `push_public_key` discovery and machine-only push operations
using the existing host routing credential; the connector binds registration to
its already-approved Noise device under the existing lease. No new authority,
token flow, handshake or strict envelope variant is introduced, so remote
protocol remains 3. Older services/connectors omit the capabilities; newer
browsers keep live notification delivery and explain why background push is
unavailable.

The daemon line in `puddle --version` may display `protocol 22.4c3`. The `c3`
reports the bundled connector's remote protocol, read from `CONNECTOR_PROTOCOL`
in the release archive (or a known historical release). It is display-only:
`PROTOCOL` remains the daemon's plain `major.minor`, and CLI/desktop handshake
comparisons never parse or compare the suffix. Unknown connector versions are
omitted rather than inferred from the running CLI.

Daemon/cockpit protocol 22.5 adds optional bounded content to `agent-notification`,
validated project/session notification destinations, and capability-detected
end-to-end encrypted push previews. New browsers send a preview key only when
the connector advertises `remote_notification_previews` and the service advertises
`push_encrypted_previews`; service registration explicitly rejects those keys.
The private connector IPC retries the legacy id-only request only after an explicit
rejection. Old clients ignore optional event content; old subscriptions retain generic
push. Noise admission, remote envelopes and host leases are unchanged (remote 3).

Daemon/cockpit protocol 23.0 adds local/SSH puddlang context, submission, status,
events and cancellation endpoints. Shared schemas also define runner IPC and
stdio MCP inputs. Existing authority/token flows are reused; remote profile
leases and the connector allowlist reject this namespace (remote protocol 3).
The major boundary is intentional for the puddlang rollout, despite the additive
endpoints. Upgrade daemon, CLI/desktop, and the remote connector/application to
matching daemon protocol 23.0. Existing launcher upgrade approval still applies;
puddlang itself requires an already compatible daemon and never upgrades one.

Daemon/cockpit protocol 23.1 adds optional `Session.agent_mode`, optional per-spawn
Puddlang `mode` (omission retains interactive), advertised adapter modes and
bounded native turn signals under the existing per-runtime nonce. Migration 025
preserves existing placements as interactive. `pudl` requires 23.1 so older runners
cannot silently discard the requested mode. Session creation through the public
REST API remains interactive; no remote operation or authority is added. Remote
protocol remains 3 and Puddlang remains excluded from remote leases/allowlists.

Daemon/cockpit protocol 24.0 renames the execution mode enum value `scripted` to
`headless` in Puddlang spawn/context and `Session.agent_mode`. This removes an
accepted value, so the major advances with no legacy wire alias. Migration 026
converts persisted placements and replaces the SQLite constraint; interactive
remains the default. Historical run source/events retain their original text.
Programmes using the old spelling must be updated explicitly.

Remote protocol 4 accompanies the renamed mode in allowlisted session responses.
Update CLI/desktop, daemon, connector, service and application together. Existing
registrations and device grants are retained; invitation/Noise admission requires
the new version. Puddlang remains local/SSH-only, with no allowlist or authority
expansion. The `scripted_turns` capability still describes automated turn support
in either mode; it is not an execution mode name.

Protocol 24.1 adds an optional bounded `subtitle` to the desktop notification
request schema. The desktop preload advertises `notificationSubtitles`; newer
renderers send a host/project title and session subtitle only with that capability.
macOS uses its native subtitle, Windows uses three native text blocks, and Linux
places the session on the first body line above the preview. Older shells and
browsers retain the session title and body. Daemon REST/WS
messages, remote envelopes and host authority are unchanged; remote protocol
remains 4.

Protocol 24.2 adds cockpit-local `GET /cockpit/file-manager` capability discovery
and `POST /cockpit/file-manager` with a bounded absolute path to reveal. Both
require browser authorisation; POST also requires the exact cockpit Origin.
Only local-host cockpits advertise or invoke a file manager. SSH cockpits refuse
the operation even though their UI also lives on localhost; remote browser
transports never call these routes. Older cockpits return 404 and the UI omits
the menu action. No daemon or connector operation is added; remote protocol
remains 4.

Protocol 24.3 adds optional compilation-provider `action` (`compile` or `run`).
Older clients ignore it; newer clients treat omission as compilation. Code and
notebook providers reuse the existing capability/run/settings/status schemas,
with `eager: false` and explicit execution only. Their artefacts use existing
file targets. No remote allowlist, authority or envelope changes; remote
protocol remains 4.

Protocol 24.4 adds POST/PUT `/api/compilation/defaults` for profile language
commands and an optional nullable `inherited_command` on file command slots.
Existing per-file overrides remain authoritative; null language defaults retain
provider-owned source and engine selection. Newer clients show the language
picker only after confirming 24.4. Compilation routes remain local/SSH-only;
remote protocol remains 4.

Protocol 24.5 adds optional nullable project `colour` fields to project responses,
creation and updates, using the profile icon palette. Omission on update preserves
the saved colour; null restores default styling. Newer clients hide colour controls
until the host advertises 24.5. Existing project routes and authority are unchanged;
remote protocol remains 4.

Protocol 24.6 adds the local/SSH-only `/api/notebooks/kernels`, `/status`, and
`/kernel` endpoints for installed kernel discovery and explicit lifecycle
controls. Existing notebook runs retain their compilation request/result shapes
and managed artefacts while reusing a daemon-owned kernel. Newer clients hide
kernel controls until confirming 24.6. No connector allowlist or remote envelope
changes; remote protocol remains 4.

Protocol 25.0 makes programming-language execution terminal-only. Providers
advertise `terminal`, and every ordinary run launches a new terminal placement
returned in the result. Both compilation and programme execution happen in that
PTY; a successful response confirms launch, with completion and errors shown in
the terminal. There is no terminal-selection request flag or captured-output
fallback for programming languages. This changes the meaning of existing code
run requests/results, so the major advances. Upgrade daemon and CLI/desktop
together through the normal handshake. LaTeX and notebook providers retain their
previews. Compilation remains local/SSH-only, outside the connector allowlist;
remote protocol remains 4.

Protocol 25.1 adds local/SSH-only POST `/api/notebooks/environments`, optional
Python environment details in kernel status, and `select-python`/`install-python`
kernel actions. Newer clients gate these controls on 25.1; registered-kernel
controls remain available on older hosts. Selection retains incomplete environments
and installation requires an explicit action; fixed package names run through the
selected Python's pip without a shell. Installation includes the displayed Python path and rejects a changed selection. Remote profile leases and the connector
continue to deny this namespace, so remote protocol remains 4.

Protocol 25.2 adds local/SSH-only notebook `/execute`, `/execution` and `/input`
operations for bounded cell source snapshots, observable live results and exact
run/prompt input replies. New clients feature-detect interactive execution; older
hosts retain Run to Executed Copy. The existing compilation API and kernel
lifecycle are unchanged. Remote leases and the connector deny this namespace.

Protocol 25.3 adds local/SSH-only POST `/api/notebooks/intelligence` for bounded
completion and inspection. Requests use Unicode codepoint positions and existing
idle kernels only. Dedicated shell clients have unique routing identities so
assistance never consumes execution/input replies. Remote access remains denied.
