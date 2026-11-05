# Self-hosted mobile access

Puddle runs agents on your machine and connects outward to your own relay. An
ordinary browser uses a separately served application. There is no Puddle-hosted
service, VPN requirement or public daemon port. Use a persistently supervised
daemon; an SSH-attached fallback stops with its cockpit and cannot provide
independent phone access.

## Deploy the service and application

Choose two HTTPS origins under the same site, such as `app.example.com` and
`relay.example.com`, and point their DNS records at your ingress. Ports 80 and
443 must reach that ingress. Keep daemon ports 7433/7434 private.

Daemon protocol 24.0 and remote protocol 4 rename the session mode `scripted` to
`headless`. Upgrade the daemon/connector, service and application together;
previous remote clients cannot connect across this version boundary. Existing
registrations and device grants are retained.

From a checkout of the version you intend to run:

```sh
install -m 600 deploy/remote/.env.example deploy/remote/.env
openssl rand -hex 32
```

Edit `.env`: set the origins, hostnames, a fresh random `BETTER_AUTH_SECRET` and
OAuth credentials. Keep this file private (`chmod 600 deploy/remote/.env`).
Configure Google, GitHub or both; startup rejects missing or incomplete provider
credentials. Anyone with a provider-verified email can create an account. Host
access still requires explicit browser approval at the host. Puddle sends no email
and has no password login or email recovery. Caddy manages HTTPS without an email
contact setting. Register these provider callback URLs, respectively:

- `https://relay.example.com/api/auth/callback/google`
- `https://relay.example.com/api/auth/callback/github`

Restrict the environment file itself rather than changing the shell's umask for
later Git operations. Runtime images explicitly make application metadata,
configuration and public assets readable by their unprivileged users, even when
the checkout has private file permissions.

On DigitalOcean, use a Docker Marketplace Droplet with public DNS for both
origins and inbound TCP 80/443 (SSH restricted to your own address). Copy this
checkout, including the mobile-access commits, onto the Droplet before running
Compose. Authentication uses outbound HTTPS to the configured providers; no mail
provider, mail server or SMTP port is needed.

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up --build -d
```

The example builds a Node service and a static application, with Caddy managing
TLS. Only ingress ports are published. The service runs as an unprivileged user
with a read-only root filesystem; its SQLite state is in `service-data`. Agent
homes, worktrees, SSH sockets and Docker sockets are never mounted into it.
The image creates `/data` with mode `0700`, owned by the service user (UID 10001),
so fresh Docker volumes satisfy the private-storage checks.
The app's service origin is fixed at build time. Changing it requires rebuilding
the app, not editing a pairing link.

CI builds both images from a checkout with private file permissions and runs
`node deploy/remote/test-images.mjs` to check service/database startup with a fresh
Docker volume, restart with retained state, and every static asset under the
production non-root, read-only, capability-free settings.
The application image removes Caddy's privileged-port file capability because it
serves port 8080; retaining that capability prevents execution with `cap_drop: ALL`.

The example has one infrastructure administrator. To protect against a relay
operator, put the application image and its TLS termination on separately
controlled infrastructure: the relay's operator must not be able to replace
its JavaScript or alter its deployment. The browser necessarily trusts the
application distributor with keys, terminal input and decrypted output. Separate
origins alone do not protect against a shared compromised root account.

Open the application and sign in with a configured provider,
and optionally enable authenticator MFA under Account security. Store the recovery
codes privately. Recover a lost provider login through Google or GitHub; signing
in again does not enrol a new browser at any host. Use the original provider:
matching email addresses do not automatically link different provider identities.

### Host the installer

The app image serves the CLI installer at its own HTTPS origin:

```sh
curl -fsSL https://app.example.com/install.sh | sh
```

It includes a Node runtime and does not use npm. It installs under
`~/.local/share/puddle/cli` (or XDG_DATA_HOME/`--prefix`), puts `puddle` in
`~/.local/bin` (or `--bin-dir`), and prints any necessary PATH setup.
Add `sh -s -- --version X.Y.Z` to pin a release.

Install the other components through the CLI:

```sh
puddle install daemon             # local daemon
puddle install daemon user@host   # remote daemon
puddle install desktop           # desktop app on this machine
```

A first `puddle launch user@host` still bootstraps a missing daemon automatically.
The CLI and desktop embed the daemon bootstrap and download daemon archives from
GitHub Releases; they do not fetch the public `/install.sh` for daemon installs.
There is no separately published daemon installer. The former `/install-cli.sh`
and `/install-daemon.sh` URLs return 404 after rebuilding the app.

Each build copies the CLI installer from the checkout, bakes in the repository
from CLI package metadata, and serves it as uncached plain text. The script
resolves the latest release when run, so ordinary releases need no server update.
Rebuild when the installer logic or configured repository changes. For a fork,
set `PUDDLE_REPO=owner/repo` in the deployment environment before building.
The installer fetches published archives and SHA256SUMS from GitHub; hosting it
does not mirror release binaries. Publish a release containing the new CLI
archives before using the standalone online installer.

After pulling an installer update, rebuild the app:

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up --build -d app
curl -fsSL https://app.example.com/install.sh | sh -s -- --help
```

Installer URLs bypass the application HTML fallback. CI checks the CLI script's
content, shell syntax, content type and cache headers, and verifies that removed
installer URLs return 404 under the production container restrictions.

### Edit the public guide

The deployed app serves `/guide` without sign-in. Edit
`packages/web/src/features/guide/guide.md` to change its setup and upgrade instructions,
then rebuild the app using the command above. `{{APP_ORIGIN}}` becomes the current
app origin in installation commands, so the same content works on any deployment.
The sign-in screen and signed-in project list link to this page; old `/faq` links
redirect to `/guide`. Keep the Markdown table of contents aligned with the heading
text (lowercase, punctuation removed, spaces replaced with hyphens). GitHub-style
`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION` alerts are supported,
including inside lists; indent every line of an alert to the same list depth.

### Repair a volume created by an older image

Earlier service images created `/data` with mode `0755`. The private-storage check
rejects this, causing a service restart loop and ingress responses of 502. If
service logs report `Puddle authority storage must be private and owned by the
current user`, tighten the existing volume's directory permissions:

```sh
cd deploy/remote
docker compose stop service
docker compose run --rm --no-deps --entrypoint chmod service 700 /data
docker compose up -d service
```

This runs as the existing service user and preserves the volume's contents. Image
updates do not change an existing volume's permissions, so this repair is needed
once for affected volumes. Keep the private-storage checks enabled; do not delete
the volume to resolve this error.

### Configure Google or GitHub

For Google, create an OAuth client of type **Web application** in your Google
Cloud project's Google Auth Platform. Configure the consent screen with an
**External** audience so people outside your Workspace organisation can sign up,
and register the exact Google callback URL above. Put the client ID in
`GOOGLE_CLIENT_ID` and client secret in `GOOGLE_CLIENT_SECRET`.
A Google Workspace address works as the login identity;
no Gmail API, app password or mail configuration is needed. See
[Google's web application setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
and [audience settings](https://support.google.com/cloud/answer/15549945).

For GitHub, register an OAuth App in **Settings → Developer settings → OAuth
Apps**. Set the homepage to your application origin and the authorisation callback
to the GitHub URL above. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from that
app. GitHub must report a verified email address; its primary email is used when
the public profile email is private. See
[GitHub's OAuth app setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

Leave both credential values empty for a provider you do not use. Credentials
belong only in the private service environment, never the static application's
build arguments. After changing credentials, recreate the service:

```sh
docker compose --env-file deploy/remote/.env -f deploy/remote/compose.yaml up -d service
```

### Upgrade an earlier email-login deployment

Rebuild the service/application and update host connectors together for remote
protocol 3 (daemon/cockpit protocol 22.0). Register each profile and create fresh
pairing invitations; earlier host-wide registrations and approvals are removed.

Startup deletes legacy password credentials and, when any are found, invalidates
all service sessions, pending authentication challenges and MFA confirmations.
Provider bindings and host records are preserved. Remove `PUDDLE_SMTP_URL` and
`PUDDLE_EMAIL_FROM` from old environment files. Accounts that only had a password
cannot sign in or be claimed through a matching provider email. If you used such
an account while testing, back up the service state and initialise a fresh service
database, then register the hosts again through local/SSH access and approve the
browsers again. This does not stop daemon-owned work.

## Register and pair a host

In a Puddle desktop window (local or connected over SSH), open **Settings → Remote &
Sync**. Remote access applies to the selected profile on the host open in that window.
Each profile registers independently and may use a different remote account. Its
approved browsers see only its projects and sessions. Switching profiles lets you
register another without replacing the first registration.
The application and relay fields start with `https://puddle.waddlelabs.ai` and
`https://charles.waddlelabs.ai`; both are editable for any self-hosted deployment.
Choose a host name and **Sign in and enable**. Puddle opens the application in a
browser on the machine displaying the UI, including when the host is reached over SSH. Electron uses that machine’s system
browser; the web cockpit opens a new tab directly from your click. Sign in with
Google or GitHub, complete MFA if enabled, compare the request
identifier with desktop, and choose **Confirm host**. Desktop finishes registration
automatically; there is no registration code to copy. Keep settings open while
signing in. Cancelling or closing them discards the pending verifier; a request
expires after five minutes. The host's cryptographic identity is generated locally,
not on the website. Browser pairing and approval remain separate.

An existing registration can be re-enabled directly. To change it, disable remote
access and choose **Change registration**: the existing origin fields become
editable in place. Cancel restores the saved values; completing sign-in replaces
the registration and revokes previous browser approvals and invitations.
The connector needs persistent systemd, launchd or (Windows) Task Scheduler supervision; the settings view
explains when the host needs configuration or an upgrade.

Choose **Pair a browser** on desktop. In the intended Puddle browser or Home Screen
app, choose **Pair this device → Scan QR code**, allow camera access and scan the
desktop code. You can also paste the pairing link there. Give this device a name
and request approval. Return to the desktop, expand **Connected browsers**,
compare the full browser identity and choose **Approve**. Status and
device requests refresh automatically while settings are open. Desktop and mobile
show compact browser cards; expand a card to see an approved browser’s identity
and expiry. Pending identities stay visible before approval. Each card has a
**Revoke browser** icon; revoked browsers disappear from the list.
Disable remote access detaches this profile’s remote viewers. Under Host identity recovery,
Reset host identity performs the same local/SSH recovery as `puddle remote reset`
after explicit confirmation. Codes and invitations are not stored in cockpit
settings or logs. Disable, revoke and delete remain available when the relay is
unavailable.

On iOS, open Puddle from its Home Screen icon before scanning. Scanning with the
system Camera app can open Safari, which uses a separate device identity. Pairing
Safari does not pair the Home Screen app. Puddle's scanner stays inside the app,
decodes camera frames locally and stops the camera when closed or backgrounded.
After approving this device, connect to the host before testing background
notifications. Web Settings contains pairing controls; new hosts are registered
from desktop Settings → Remote & Sync.

Choose **Delete registration** beside the other registration actions to disable
access, revoke this profile’s browsers and invitations, and remove its registration
from this host. Other profiles remain connected. Confirming returns settings to **Not configured**; connecting again needs
a new browser sign-in handoff (or CLI registration code) and fresh approvals.
Agents continue running. The host identity and revoked device records remain for audit/recovery. This local/SSH-only
action requires an updated host connector. It also removes the host from your
remote account’s host list. If the relay is unavailable, a private removal request
retains the old routing credential on the host until the relay acknowledges
removal. It retries when connectivity returns, including after a host restart. Replacing a registration also retires the previous entry. Disabling remote
access or taking a host offline keeps its registration.

For stale entries left by older connectors, open remote **Settings → Hosts**, use
the **Remove host registration** trash icon beside the obsolete entry, and confirm.
This works for offline hosts too; it removes only the selected registration.
Machines with identical names are kept separate.

Upgrade the service/application, desktop and host daemon/connector together for
remote protocol 3 and daemon/cockpit protocol 22.0. On connector startup, existing
host-wide registrations are deleted and their browser approvals revoked. Register
each profile again and pair its browsers afresh. Old relay entries are removed
immediately when reachable, or queued privately for retry. Agents keep running.

For CLI management, first register the host through desktop Settings → Remote &
Sync (local or SSH). Use the profile’s id from the desktop profile data. Re-enable
an existing registration on the machine running the daemon:

```sh
puddle remote enable --profile <profile-id>
```

Or re-enable it over SSH:

```sh
puddle remote enable --profile <profile-id> user@host
```

The existing `--service` / `--app-origin` registration flow remains available to
automation using a five-minute code from the authenticated service API; web
Settings no longer creates these codes. Supply the code through the hidden prompt
or stdin, never command-line arguments, shell history or background logs.
Systemd/launchd (on Windows, the home's Task Scheduler supervisor) supervises the connector independently of
the CLI and laptop. `remote enable` without origins re-enables an existing
registration. Registering again clears previous approvals and invitations. An
upgrade restarts the previously configured connector; daemon removal disables
remote access and removes its supervisor too.

For another persistent supervisor, `remote enable --foreground` writes the
configuration and `puddle remote run` runs the connector in the foreground.
Supervise **both** daemon and connector outside an agent session. No nohup or
cockpit-bound fallback is silently selected for mobile access.

```sh
puddle remote pair --profile <profile-id>                 # add user@host for an SSH host
```

Paste the printed link into **Pair this device** in the intended Home Screen app,
or open it directly in the intended browser. You can also scan the QR from an
already paired browser's Paired browsers dialogue. Give the browser a name and request approval.
Compare the browser identity shown on both devices, then on the host:

```sh
puddle remote devices --profile <profile-id>
puddle remote approve <request-id> --profile <profile-id>
```

The host must approve that exact browser. A copied invitation or successful
service login alone grants no terminal access. An already paired browser can
approve the new browser under Paired browsers instead of using SSH. Invitations expire
in five minutes and can enrol only one identity.

## Use, revoke and recover

Open a project card on the homescreen; projects are grouped by host. Tap a host's
chevron to collapse or expand its projects. Settings
contains appearance, account security, host disconnection and pairing management.
Disconnecting pauses this browser's connection for the current visit until you
choose Connect; it does not stop agents or remove the saved pairing.

Tap the terminal title to switch between the active project's agent and terminal
sessions in the shared dropdown; its three-dot button opens session details.
Files opens the file browser with navigation, path, changes and refresh in the
same toolbar. Its terminal icon returns to the terminal. Project cards and
sessions follow their profile's saved desktop order.

The compact left rail shows only the active project's non-archived sessions.
Tap a glyph to switch terminals; hold it for details and actions, including
archiving. Expand the rail for titles and branches, tap a project label to switch
projects, or tap the grey host/project breadcrumb to return home. New agent/terminal
buttons are at the top of the rail; archived sessions and their restore action
are behind the bottom icon.

Tap directly into a terminal to type. Hold and drag to select terminal text, then
tap Copy; a quick swipe scrolls. File contents support the same held-drag gesture
and Copy action with native text selection. The terminal's bottom strip supplies Escape, arrows,
Tab, Enter and one-shot ⌃ Control / ⌥ Option / ⇧ Shift modifiers above the keyboard. Tap a modifier
then a key, for example Shift then Left; it clears after that key. Use the strip’s
Shift button for strip arrows, since the phone keyboard’s Shift state does not
carry over to these controls. Shift+Tab sends back-tab and Shift+Enter sends a
modified Enter. The image button
opens your photo/file picker and inserts the uploaded image into the current
terminal without submitting, just like desktop image paste. PNG, JPEG, GIF and WebP
originals up to 4 MiB retain their exact bytes. Larger PNG/JPEG/WebP originals, up
to 20 MiB, are resized/recompressed with a notice; GIFs above 4 MiB are rejected
to retain animation. Upload progress reflects bytes acknowledged by your host;
tap the cross to cancel. Cancellation stops path insertion and discards partial
uploads, though a final save already dispatched may leave a completed image file.
The ordinary remote request limit stays 256 KiB: images travel in acknowledged
64 KiB chunks inside the same end-to-end encrypted channel as terminal data,
preview assets and file names/metadata. The relay sees routing, sizes and timing,
not those contents. Files are saved normally on the host, without added encryption
at rest. Update the host connector and web app for 4 MiB uploads; older connectors
retain small uploads (about 191 KiB) and show an upgrade message for larger files.
The optional prompt
composer retains drafts in this tab across reconnect/reload; Send respects
bracketed-paste mode. If delivery is uncertain, check the terminal before sending
again. No operation is replayed automatically.

Files browses the selected worktree (or the project's repository without a session).
Tap the path or filename to open a file or directory; the dialogue starts at the
current location, including the filename when viewing a file. Absolute, `~/` and
paths relative to the current browse root are accepted. Double-tap a file to view it, then
use Back to files to return to the same directory. Changes remains available from
the Files toolbar. In file view, the eye icon toggles Markdown, HTML, images,
audio, video and PDFs between source and preview. Markdown supports maths and
Mermaid; HTML runs JavaScript in an isolated sandbox without access to the app’s
storage or credentials. Local images, styles and scripts resolve against the
current browse root, including custom host directories. Individual preview assets
are limited to 8 MiB. Refresh reloads the preview and its assets. There is no
editing, locking or scroll synchronisation. Change review stays text-only.

Update the daemon (protocol 21.1), host connector and remote app deployment to use
previews. Custom static hosting must apply the separate sandbox CSP for
`/preview.html` from `deploy/remote/Caddyfile.app`, while keeping the main app’s
script policy intact. General file transfers, source editing, Git mutations and
forwarded applications remain unavailable. A paired terminal still has the host owner's execution authority.

```sh
puddle remote status --profile <profile-id>
puddle remote revoke <device-id> --profile <profile-id>
puddle remote disable --profile <profile-id>
```

These commands accept an optional `user@host` and work through local/SSH host
control without the relay. Disable is persisted before viewer shutdown. Revocation
and disconnection detach viewers; agents continue. Revoked browsers disappear
from mobile and desktop lists while the host keeps its audit records. Service sign-out/unregistration
also closes routed connections. A sleeping host remains unavailable.

Browser grants have a 30-day inactivity limit and a 90-day absolute limit. Renew
by creating another invitation and approving the browser again. Private browsing
or cleared IndexedDB loses the browser key and requires pairing again. Forget
pairing removes a key from that browser; revoke its host record separately.

If every browser is lost, use local/SSH access. To rotate a compromised or missing
host identity and revoke all browser grants:

```sh
puddle remote reset --profile <profile-id>
puddle remote enable --profile <profile-id>
puddle remote pair --profile <profile-id>
```

Forget the old host pairing in each browser before accepting the replacement.
Reset is deliberately absent from the remote application protocol. Back up
`~/.puddle/remote` securely as one unit; restoring an old database can restore
previously revoked grants, so reset when recovery provenance is uncertain.
Back up service SQLite and `BETTER_AUTH_SECRET` privately too. No service backup
can restore missing browser keys or grant replacement host access.

## Notifications

In the remote app’s Settings, enable **Background notifications on this device**
and use **Send test**. Each paired host must run a daemon and connector supporting
protocol 22.4; the remote service and static app need this release too. On iPhone
or iPad, add Puddle to the Home Screen and open that app before enabling push.
The browser permission is separate from the host profile’s notification toggle.
Profile notification preferences and project mutes still apply.
Web Push needs no Apple Developer Program membership or Developer ID certificate;
Apple documents this separately from native-app signing in its
[Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

Push alerts appear while the app is open or closed. They contain only a generic
message; clicking reopens the host. The service retains private push vendor
subscriptions and VAPID keys under its existing data directory, never session
content. Keep `push-keys.json` with service backups; changing it requires browsers
to disable and re-enable notifications. Outbound HTTPS to Apple Web Push, Google
FCM, Mozilla push or Windows notification endpoints must be available. There is
no new deployment secret to configure: the service generates its VAPID keys once.

A successful test means the push vendor accepted the message. Actual banners
still depend on device permission, Focus settings, network and OS delivery.
Test progress and results appear beside **Send test**. The test checks this
device’s subscription and confirms its registration with the host before sending.
Browser registration and subscription reads time out after ten seconds with a
visible error; an OS permission grant alone does not establish a live subscription.
If the vendor accepts a test but no banner appears on iOS, check Notification Centre and Settings →
Notifications → Puddle for **Allow Notifications** and banner delivery, then
check Focus and Scheduled Summary. Record the test result separately from whether
an alert appears; a missing banner alone does not identify where delivery failed.
Disable the device toggle or sign out to unsubscribe; revoking its host pairing
stops new sends too. Messages already accepted by a vendor can arrive for up to
two minutes. Push subscriptions do not extend host grants or keep a browser lease
alive. Disabling a host connection in the catalogue leaves its separately enabled
notifications active; use the notification toggle or revoke pairing to stop them.

## Operations and validation

The relay holds account/routing metadata and transient bounded ciphertext. It
stores no terminal/source history. Optional push stores only vendor subscription
metadata and generic event identifiers; push timing remains visible to the service. Access logging is disabled in the example;
do not add logs of cookies, authorization headers, bodies, codes or pairing URLs.
Expired unused registrations and MFA confirmations are pruned every minute.
Accounts and redeemed host registrations persist until removed; device records
remain on the host for inspection. Relay traffic still reveals addresses,
timings, sizes and availability. Operators own TLS, OAuth, capacity,
backups, updates and incident response. Rate limits use the actual peer address,
not caller-supplied forwarding headers; behind the example ingress that is a
shared admission budget. Add edge admission controls before increasing exposure.

After dependency or security changes, run `pnpm build`, `pnpm test:remote`,
`pnpm test:e2e`, `pnpm test:ssh` and `pnpm test:mobile`. Install the test browser
with `pnpm --filter @puddle/web exec playwright install chromium` if needed.
The browser suite creates temporary HTTPS endpoints, isolated homes, fake agents
and provider responses; it does not launch an installed personal daemon. Use the
[physical-device and security acceptance checklist](acceptance/mobile-access.md)
before a production deployment. Automated coverage does not replace those checks.

Conversation previews require daemon/connector protocol 22.5 and an updated remote
service and app. An already opted-in device registers its preview key automatically
on its next connection. Notifications show the conversation title and a short last-output
snippet, encrypted end to end between host and device; the relay cannot read them.
Tapping opens that conversation even from a closed Home Screen app or another host.
Login/pairing still applies. Older deployments and missing keys show a generic alert.
