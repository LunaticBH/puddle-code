<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]


### Added

- Run Puddle natively on Windows 10 1809+ and Windows 11 (x64 and arm64), with PowerShell as the only Windows shell and automation layer: `puddle launch` installs and supervises the daemon on this machine without a shell, as a windowless detached process stopped gracefully over its private control pipe (see `docs/windows.md`).
- Report the daemon's platform, and on Windows its build number, from `GET /api/host`; accept a private-control `shutdown` request and a cockpit launcher `shutdown`; on Windows, private-control `open` and `shutdown` may carry a `challenge` that the reply answers with a `proof` (protocol 25.7, optional fields).
- Windows: `puddle install/upgrade/remove daemon`, `puddle logs`, `puddle --version`, and background cockpits with `puddle list`, `kill` and `refresh`.
- Windows hosts over SSH: `puddle launch|install|upgrade|remove|logs|remote user@host` drive a Windows host through its OpenSSH server, whatever its default shell, using a PowerShell loader and the CLI's own host helper.
- Windows: the daemon starts at logon from a per-user scheduled task and restarts after a crash, through a resident supervisor that also outlives the SSH session that started it.
- Windows: remote access (Settings → Remote & Sync and `puddle remote`) works on Windows hosts; the supervisor runs the connector, and its pipes prove they belong to the home.
- Native Windows arm64 builds: `win32-arm64` daemon and CLI zips and an arm64 desktop installer, chosen by the operating system's architecture even from an emulated x64 process.
- Optional Authenticode signing of the Windows archives and installers (a certificate or Azure Trusted Signing) when release secrets are configured; a signed desktop app refuses updates from another signer.
- Windows: PowerShell 7 installed from the Microsoft Store is used for terminals and `.ps1` runs.
- Windows: terminals and agent sessions start natively, with PATHEXT lookup, npm/pnpm `.cmd` shims run without `cmd.exe`, and PowerShell 7, else Windows PowerShell, as the session shell.
- Windows: PowerShell session shells report their directory, capture environment changes and keep session-private history.
- Windows: terminal agent detection, the ports panel and the reverse proxy work through the process table and `netstat`.
- Windows: compile commands and notebook kernels each run on a console of their own and stop like a POSIX process group, sparing detached and own-console processes; only one stop runs at a time per command, and shutdown waits for every stop within one bound inside the supervisor's grace.
- Windows clients no longer show a Windows host's answer to the SSH platform probe ("'true' is not recognized"), and no longer print "channel N: open failed" for the Codex OAuth callback forward.
- Windows: ending a session ends what is attached to its console, as SIGHUP does on POSIX, while GUI programs, detached processes and processes in a console of their own outlive it; the supervisor does the same for a crashed daemon's sessions.
- Windows: Claude Code hooks use exec form, the Claude status line runs alike under whichever shell Claude Code picks, and Gemini CLI hooks are quoted for PowerShell; headless agent mode runs over a token-gated named pipe.
- Windows: conversation sharing between accounts uses directory junctions; an entry that cannot be linked is not shared, and its data is never copied.
- Windows: programme terminals run through a built-in Node wrapper, and Ctrl+C returns to the shell with status 130; PowerShell scripts (`.ps1`) run with pwsh or Windows PowerShell.
- Windows: code runners, TeX (MiKTeX, TeX Live, TinyTeX) and Python/Jupyter environments are found in their default install locations; Conda environments run notebooks without activation.
- Windows: the file explorer, Changes panel and worktree manager work on a Windows daemon, with canonical native paths, `/` root-relative paths, clear errors for names Windows cannot store and files in use, long paths, and non-interactive background fetches.
- Windows hosts: the web UI shows native paths (`C:\…`, `~\…`), stops browsing at a drive root, copies native absolute paths, and opens editor links on Windows paths.
- Windows hosts: terminal file links recognise `C:\x\y.ts:12:5`, `src\a.ts`, UNC paths and `file(12,5)`; terminals run xterm in ConPTY mode.
- Windows clients: default shortcuts use Ctrl where macOS uses ⌘, while plain Ctrl+letter chords still reach a focused terminal.
- Windows: release archives `puddled-v<V>-win32-<arch>.zip` and `puddle-cli-v<V>-win32-<arch>.zip` for x64 and arm64, listed in `SHA256SUMS`; every CLI archive ships the Windows host helper, which `install.ps1` requires (`install.sh` still installs every earlier release).
- Windows: install the standalone CLI with `install.ps1`, which adds `%LOCALAPPDATA%\puddle\bin` to the user `PATH` unless `-NoPathUpdate` is given; `puddle upgrade cli` and `puddle remove cli` manage it.
- Windows: the desktop app ships as a per-user installer that updates itself in-app, shows SSH authentication prompts in its own dialogue, and is managed by `puddle install/upgrade/remove desktop`.
- CI builds, tests and packages on Windows, and releases publish the Windows archives and desktop installer.

### Changed

- Keep LF line endings in every checkout (`.gitattributes`), so Windows clones never embed CRLF shell installers.
- Windows: the agent search path defaults to `~\.local\bin;%APPDATA%\npm;%LOCALAPPDATA%\pnpm;~\.bun\bin;~\scoop\shims` and uses `;` as its separator.

### Security

- Windows: name control pipes by an HMAC under a private per-home key and believe a pipe server only once it proves it can read the home; protect a newly created Puddle home with an owner-only DACL; outside the profile, refuse a home another account owns, restrict one others can open, and refuse one holding entries another account could have placed there; refuse junctions as the home.
- Windows: never run a `git.exe`, compiler or other programme from a repository or worktree (bare names resolve on `PATH` only), and never probe tools in folders another account could create (the drive root, `%ProgramData%`).
- Windows: never open UNC or device paths that terminal output names when resolving links outside the session's tree.
