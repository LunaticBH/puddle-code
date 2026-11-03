# Short-lived connection tokens

Status: implemented for local and SSH access in protocol 18.0. This document
is the implementation contract; mobile, gateways and relays remain deferred.
[Connection authentication](connection-auth.md) retains the trust-boundary
rationale, and [mobile access](mobile-access.md) describes later consumers.
Automated verification uses existing Vitest, Node processes/HTTP and `ws`;
actual browser and desktop checks are recorded separately in
[connection authority acceptance](../acceptance/connection-authority.md).

## Outcome and scope

Replace the browser's reusable daemon master token with separate browser
authorisation and short-lived host connection tokens. A local or SSH cockpit
keeps its current connection token in process memory. The daemon validates
the associated lease and can revoke its live connections. The master
credential stays on the host, including during SSH bootstrap and upgrades.

An SSH outage leaves a valid browser login intact while remote access is
unavailable. Recovery obtains fresh connection authority and restores terminal
views. Expired or revoked browser authorisation still requires reauthentication.
Neither path repeats terminal input or mutations of uncertain delivery.

Cover local/SSH launch, background/foreground cockpits, desktop embedding,
raw terminal attach, authenticated CLI inspection/management, REST, main WS,
proxy HTTP/WS, and cockpit-local controls. Preserve existing agent processes,
placements, worktrees, and terminal history, subject to the existing lifetime
of an SSH-attached fallback daemon.

Exclude mobile presentation, remote device enrolment, public listeners,
Tunnel/Access deployment, relay services, and end-to-end encryption. This
phase keeps current localhost and SSH transport and introduces no profile
permissions or multi-user security model.

## Authority and ownership

| Concept                    | Owner                              | Purpose                                                                             |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Master/bootstrap authority | Trusted host process               | Establish connection authority locally; never sent to a browser or SSH client       |
| Connection lease           | Daemon-side authentication service | Track permitted access, connection identity/generation, expiry, and revocation      |
| Connection token           | CLI/cockpit process                | Present delegated authority to daemon REST/WS/proxy entry points                    |
| Browser authorisation      | Browser and its cockpit            | Permit access to that cockpit independently of upstream availability                |
| Bootstrap invitation       | Trusted local launcher and browser | One-time establishment of browser authorisation; never contains a daemon credential |

These identities are independent of Puddle placements, native conversations,
and live agent runtimes. Do not reuse `sessions.id`, runtime ids, SSH pids,
local port numbers, or the current process-lifetime `DaemonLease` as an
authentication lease identifier.

Use cryptographically random opaque connection tokens and store their digests
in the host authority registry. Keep raw tokens out of files, logs, process
arguments, URLs, error payloads, and cockpit records. Track live authority on
the host rather than relying on an expiry claim in a stateless token. A daemon
restart invalidates its ephemeral leases; clients re-establish authority.
No placement/database migration is needed merely to retain ephemeral leases.

## Local issuance and the SSH control channel

Add a host-local bootstrap/control interface that authenticates the trusted
OS user's helper before it can create, renew, replace, or revoke a lease.
Use the protected Unix socket described in the resolved decisions. Loopback reachability alone
is not bootstrap authority; the normal browser API must not issue leases in
exchange for an expired or ordinary connection token.

Local mode opens the control channel directly. SSH mode starts a host-side
helper through authenticated SSH; the helper accesses the bootstrap authority
locally and returns only delegated connection credentials. This replaces
the former `readToken(ssh)` and endpoint structures that returned the master
token to the client. Restrict the helper's output to bounded, schema-validated
control messages; credentials never become general diagnostic command output.

Keep the control channel open for the logical connection. Lease renewal must
prove current client participation through that channel. A helper remaining
alive and renewing on its own would incorrectly preserve authority after a
network partition. Possession of a data token cannot mint or renew tokens.

Provide explicit readiness, loss, renewal, and generation-change signals to
the cockpit. The current `tunnel-down`/`tunnel-up` events are debounced user
notifications and cannot serve as the security lifecycle. SSH multiplexing
also means the forwarding child can exit while its master retains the forward.
Support both multiplexed and non-multiplexed SSH without inferring authority
from a child pid or an accepting local port.

## Lease lifecycle

The host records each lease's identity, generation, allowed operations,
deadlines, and attached resources. Check validity at request/message dispatch
as well as scheduling expiry cleanup; a delayed timer must not admit work
past its deadline. Use monotonic time for in-process deadlines.

| Event                                  | Required behaviour                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Authenticated control channel opens    | Create fresh connection authority; make the data path ready only after compatibility checks          |
| Valid control renewal                  | Extend authority within its bounded policy; return any replacement credential over that channel only |
| Known control closure or explicit stop | Revoke its lease and close associated data connections                                               |
| Missing client participation           | Let the host-enforced deadline expire even if TCP or the helper still appears alive                  |
| Replacement connection becomes ready   | Replace the predecessor generation atomically; old callbacks cannot affect the successor             |
| Daemon restart                         | Reject old tokens and require fresh local/SSH bootstrap                                              |
| Browser logout or expiry               | Revoke that browser's access and close its streams without invalidating other browsers               |

Set and test a short renewal deadline, an absolute credential lifetime, and a
rotation policy before implementation. Rotation must specify the bounded
overlap, if any, and how already-open streams reauthenticate or close. A stolen
old token must not gain a renewed lifetime merely because the legitimate
connection obtains a replacement. Never silently upgrade a stream authenticated
with a retired credential to new authority without authenticating its owner.

Expiry and revocation reject future dispatch and terminate associated REST
streams, terminal/status sockets, and proxy sockets. Remove queued work that
has not been dispatched; already-started operations may have taken effect.
Detaching a viewer does not stop its daemon-owned agents. Short-lived CLI
commands release their authority when they finish; long-running attach uses
the same renewal and cleanup rules as a cockpit.

One cockpit can serve multiple browser windows. Browser authorisation and its
stream ownership remain per browser; the upstream lease can be owned by the
cockpit connection. Closing one window must not revoke siblings, while closing
the cockpit or revoking its upstream lease invalidates all dependent streams.
Separate cockpits have separate upstream authority even if they share SSH.

## Browser and proxy boundary

Turn the CLI UI server into the browser's authentication boundary. It accepts
only its own browser credential, validates access, strips supplied upstream
credentials, and applies its current connection token when forwarding. The
daemon rejects browser credentials; the cockpit rejects daemon credentials
presented as browser authorisation. Credential audiences must not overlap.

The browser bootstrap link contains a short-lived, single-use invitation,
cleared from the address bar and consumed atomically. Protect the exchange
against replay, guessing, and foreign origins. Returning to an existing cockpit
from `puddle launch` must obtain a fresh invitation through an authenticated
local launcher channel, rather than reusing a persisted secret or exposing an
unauthenticated HTTP endpoint that creates new browser logins.

Choose browser credential storage explicitly. Local HTTP and multiple localhost
ports cannot simply copy an HTTPS cookie design; cookies are not isolated by
port. Retain Host/Origin checks and define exact browser-origin acceptance for
mutations and WS upgrades. If cookies are chosen, require CSRF protection.
Remove the old master-token localStorage entry and manual master-token gate.

HTTP forwarding, the main WS auth exchange, `/cockpit/refresh`, and
`/cockpit/local-sync` all use the new boundary. The cockpit authenticates the
daemon WS itself; its current raw byte splice cannot translate auth messages.
Browser connection state must distinguish upstream recovery from rejected
browser authority so an upstream 401 does not clear a valid browser login.

Preserve detected-port restrictions for `/proxy`. Navigations and proxy WS
upgrades need a browser-facing credential mechanism with authority confined
to the permitted proxy target, not a daemon token in a cookie or query string.
Tie any such credentials and live proxy sockets to the owning browser and
connection lease. Strip Puddle credentials before forwarding to development
servers. Specify behaviour on expiry, refresh, and subsequent navigation;
cover it with integration tests rather than leaving proxy auth on the legacy
master-token path.

This change does not make same-origin executable previews safe from script
injection. Preserve existing feature behaviour only with an explicit review of
the new credential exposure; do not claim that an HttpOnly cookie or a
short-lived bearer creates isolation from code running in the cockpit origin.

## Recovery and error semantics

On detected loss, suspend forwarding immediately and dispose of the affected
generation's resources. The host also enforces lease expiry independently,
bounding authority during a silent partition. Do not promise instantaneous
detection of physical network loss.

Re-establish SSH and verify the intended host; obtain fresh authority and
complete the protocol handshake before restoring browser access. Keep the
browser's authorisation and unsent drafts subject to their own lifetime.
Restore terminal attachments from canonical snapshots. Reject input while
disconnected and do not queue it for later replay. Automatic reauthentication
still depends on available SSH credentials; an interactive MFA challenge cannot
be silently answered by a detached cockpit.

Define separate shared error states for rejected browser authority, expired
upstream authority, reconnecting/unavailable transport, and protocol mismatch.
The cockpit may recover upstream authority without forwarding an operation;
it must not blindly retry a request whose execution outcome is unknown.

## Protocol and upgrade migration

Define all new REST/WS and control-message shapes in `packages/shared`. Bump
the protocol major under `packages/shared/PROTOCOL.md` when implementing this
auth/token-flow change. Keep ordinary API operation meanings intact. No
version bump occurs for this draft, and no legacy auth compatibility service
is retained after the new daemon takes over.

Bootstrap compatibility needs explicit handling: today's `/api/version` and
live-session inspection require the old token, while an old daemon cannot
mint a new lease. Query an older daemon through a trusted host-side helper
using its credential locally; return only validated identity/version and
upgrade-impact information. Honour `--no-upgrade`, refuse unsupported/newer
protocols clearly, and reacquire credentials after an upgrade. Never solve
this transition by copying the old master token back to the client.

Migration must rotate/invalidate the previously distributed master credential
and close legacy sockets as part of the coordinated daemon transition.
Persist any migration marker atomically so normal reconnect/restart does not
rotate the master again or repeatedly invalidate other clients. Retain local
administrative recovery if upgrade or reconnect fails. Agent interruption
caused by a daemon upgrade follows existing documented restart behaviour.

Clean old browser storage and token-bearing cockpit records on upgraded
clients. Legacy `browserUrl` records and launch logs can contain the master
token: replace records with non-secret identity/location data and stop logging
credential-bearing URLs. Existing logs and unreachable old clients cannot be
assumed clean, which is why host-side invalidation is mandatory. Do not claim
that deleting the current browser value revokes historical copies.

## Implementation workstreams

| Workstream                 | Existing code seams and deliverable                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host authority             | `daemon/src/security/`, `http/app.ts`, `ws/gateway.ts`, `proxy/`: lease registry, shared auth checks, resource ownership, expiry/revocation                                                         |
| Bootstrap/control          | CLI `lib/transport/` and `lib/connection/` (`cockpit.ts`, `daemon-client.ts`, `attached-daemon.ts`): protected helper/control channel and no remote master-token reads                              |
| Cockpit lifecycle          | CLI `lib/connection/start.ts`, `lib/connection/connect.ts`, `lib/transport/tunnel.ts`, `lib/serve/`: credential substitution, authenticated WS bridging, generation-safe recovery                   |
| CLI and desktop consumers  | CLI `cli/run.ts`, `cli/manage.ts`, `lib/connection/attach.ts`, `lib/transport/ws-client.ts`, registry/detach paths; desktop library consumers: preserve supported commands and startup/reopen flows |
| Browser                    | Web `lib/transport/` (`auth.ts`, `api.ts`, `ws.ts`), `App.tsx`, token gate, proxy links and cockpit controls: new bootstrap and independent browser/upstream state                                  |
| Protocol and documentation | Shared schemas/version; SPEC §§2, 6, 9, 10; CLAUDE.md; changelog and manual acceptance script                                                                                                       |

Keep business services and agent-specific lifecycle adapters independent of
authentication transport. Avoid unrelated credential changes: agent-account
credentials, agent lifecycle signal nonces, and desktop SSH askpass credentials
retain their own purpose. Keep shared shell logic in the CLI library; the
desktop package consumes it rather than implementing a second auth stack.

## Acceptance and delivery

Implement host authority and shared schemas first, then local/SSH control
channels and all data paths, then browser bootstrap and migration. Release
only when the connected set works; a daemon that revokes HTTP tokens while
leaving authenticated sockets or proxy cookies valid is not a partial release.

| Check                  | Required evidence                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential containment | No master token in SSH responses, browser state/traffic, registry records, new logs, or proxy requests upstream                                         |
| Authorisation          | Missing, wrong-audience, expired, revoked, and old-generation tokens rejected across REST, WS, and proxy paths                                          |
| Control ownership      | A data token cannot issue/renew authority; a helper cannot renew after loss of client participation                                                     |
| Live revocation        | Active terminal/status sockets, streaming responses, and proxy upgrades terminate; unsent old-generation work is discarded                              |
| Expiry/rotation        | Test deadlines with a controlled clock, late timers, overlap limits, stolen retired credentials, and long-running streams                               |
| Isolation              | Concurrent browsers/cockpits and a shared ControlMaster remain independent; stale callbacks cannot revoke replacements                                  |
| Reconnect              | Silent partition, process crash, port change, daemon restart, and SSH reauthentication recover safely without replaying writes                          |
| Migration              | Existing token/storage/records, older daemon, newer daemon, `--no-upgrade`, failed upgrade, and repeated migration are handled explicitly               |
| Preserved workflows    | Local and SSH CLI/desktop launch, reopening a background cockpit, attach, inspection/management, file transfers, proxy HTTP/WS, refresh, and local sync |

Use focused unit/integration tests for authority, lifecycle, and protocol
behaviour, plus manual local/real-SSH and desktop acceptance. Never launch
`puddled` from an agent session to perform that manual verification. Run the
repository's required checks once the implementation exists. This milestone
requires no mobile browser, public gateway, relay account, or hosted service.

## Resolved implementation decisions

- Host bootstrap uses an owner-only Unix-domain socket in a short private
  runtime directory. The host helper is bundled with CLI, desktop and daemon
  distributions and can be staged with an older installation's Node runtime.
  Bounded JSON lines on a dedicated SSH channel carry delegated authority;
  diagnostics are separate and never contain credentials.
- Client participation is every 15 seconds, lease expiry 45 seconds, absolute
  token lifetime 60 seconds, rotation every 30 seconds. Invitations expire
  after five minutes and are consumed once. Explicit resource renewals prevent
  streams opened using stolen tokens from inheriting another client's activity.
- Browser credentials live in origin-scoped localStorage. Private cockpit state
  persists only verifiers with target/origin bindings and 30-day inactivity
  expiry. Launcher IPC issues fresh invitations for repeated launches without
  putting secrets in registry records or background logs.
- Application proxies use `127.0.0.1`; the cockpit uses `localhost`. A trusted
  landing page exchanges a target invitation for a host-only, HttpOnly,
  path-scoped application cookie tied to browser authorisation.
- Shared schemas and protocol 18.0 cover control, bootstrap, proxy grants,
  correlated refresh/status and distinct authentication failures. Atomic host
  authority migration retires the previously distributed master once. Old tabs
  run `puddle launch` once; subsequent ordinary refreshes retain login.
- `pnpm build && pnpm test:e2e` runs isolated built processes without a browser
  download or SSH server. `pnpm test:ssh` separately uses loopback OpenSSH with
  ephemeral keys and pinned host verification; CI installs its prerequisites.
  Unit tests use controlled clocks for deadlines and late dispatch. Manual
  acceptance covers browser-enforced origins/cookies, rendering, shortcuts,
  multiple tabs, drafts/layouts and real interactive SSH/desktop recovery.
