<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]


### Added

- Run Puddle natively on Windows 10 1809+ and Windows 11 (x64): `puddle launch` installs and supervises the daemon on this machine without a shell, as a windowless detached process stopped gracefully over its private control pipe (see `docs/windows.md`).
- Report the daemon's platform, and on Windows its build number, from `GET /api/host`; accept a private-control `shutdown` request and a cockpit launcher `shutdown` (protocol 25.7).
- Windows: `puddle install/upgrade/remove daemon`, `puddle logs`, `puddle --version`, and background cockpits with `puddle list`, `kill` and `refresh`.
- Windows: terminals and agent sessions start natively, with PATHEXT lookup, npm/pnpm `.cmd` shims run without `cmd.exe`, and PowerShell 7, Windows PowerShell or `cmd.exe` as the default shell.
- Windows: PowerShell and Git Bash report their directory and keep session-private history; PowerShell also captures environment changes.
- Windows: terminal agent detection, the ports panel and the reverse proxy work through the process table and `netstat`.
- Windows: Claude Code hooks use exec form, and the Claude status line and Gemini CLI hooks are quoted for the shell each CLI uses; headless agent mode runs over a token-gated named pipe.
- Windows: conversation sharing between accounts uses directory junctions; an entry that cannot be linked is not shared, and its data is never copied.
- Windows: programme terminals run through a built-in Node wrapper, and Ctrl+C returns to the shell with status 130.
- Windows: code runners, TeX (MiKTeX, TeX Live, TinyTeX) and Python/Jupyter environments are found in their default install locations; Conda environments run notebooks without activation.
- Windows: the file explorer, Changes panel and worktree manager work on a Windows daemon, with canonical native paths, `/` root-relative paths, clear errors for names Windows cannot store and files in use, long paths, and non-interactive background fetches.
- Windows hosts: the web UI shows native paths (`C:\…`, `~\…`), stops browsing at a drive root, copies native absolute paths, and opens editor links on Windows paths.
- Windows hosts: terminal file links recognise `C:\x\y.ts:12:5`, `src\a.ts`, UNC paths and `file(12,5)`; terminals run xterm in ConPTY mode.
- Windows clients: default shortcuts use Ctrl where macOS uses ⌘, while plain Ctrl+letter chords still reach a focused terminal.
- Windows: release archives `puddled-v<V>-win32-x64.zip` and `puddle-cli-v<V>-win32-x64.zip`, listed in `SHA256SUMS`.
- Windows: install the standalone CLI with `install.ps1`, which adds `%LOCALAPPDATA%\puddle\bin` to the user `PATH` unless `-NoPathUpdate` is given; `puddle upgrade cli` and `puddle remove cli` manage it.
- Windows: the desktop app ships as a per-user installer that updates itself in-app, shows SSH authentication prompts in its own dialogue, and is managed by `puddle install/upgrade/remove desktop`.
- CI builds, tests and packages on Windows, and releases publish the Windows archives and desktop installer.

### Changed

- Keep LF line endings in every checkout (`.gitattributes`), so Windows clones never embed CRLF shell installers.
- Windows: the agent search path defaults to `~\.local\bin;%APPDATA%\npm;%LOCALAPPDATA%\pnpm;~\.bun\bin;~\scoop\shims` and uses `;` as its separator.
- Windows: SSH to a Windows host is refused with a clear message, and remote access reports that Windows hosts are not supported yet.

### Security

- Give Windows control pipes a private per-home nonce, protect a newly created Windows Puddle home with an owner-only DACL, and refuse junctions as the home.
