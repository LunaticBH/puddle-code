# Native Windows support

Puddle runs natively on Windows 10 1809+ and Windows 11 (x64): the daemon
(`puddled`) hosts agents on a Windows machine through `puddle launch`, the CLI
works locally and as an SSH client to Linux/macOS hosts, and the desktop app
ships as a per-user installer. This document records the design decisions of
the port; SPEC.md §10 "Windows hosts" describes the resulting behaviour. Linux
and macOS behaviour is unchanged: every Windows path is selected by
`platform === 'win32'`.

## Support matrix

| Area                                      | Windows status                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Local host (`puddle launch` on Windows)   | Supported                                                              |
| CLI as SSH client to Linux/macOS hosts    | Supported (Windows OpenSSH has no ControlMaster: use key auth)         |
| SSH _to_ a Windows host                   | Not supported in v1; detected and refused with a clear message         |
| Desktop app                               | Supported (NSIS per-user installer, x64)                               |
| Standalone CLI installer                  | `install.ps1`                                                          |
| Remote access connector on a Windows host | Not supported in v1; Settings and `puddle remote` report it            |
| Daemon autostart at logon                 | Not in v1: the next launch restarts it and auto-resume restores state  |
| Windows arm64 release assets              | Not in v1 (Windows on Arm installs the x64 assets, run under emulation) |
| Code signing                              | Unsigned in v1 (SmartScreen warns on first run of a download)          |

## Requirements on a Windows host

- Git for Windows 2.26 or newer (`git.exe` on `PATH`). Enable long paths for
  deep worktrees: `git config --global core.longpaths true` and the
  `LongPathsEnabled` policy.
- PowerShell 5.1 (built in) or PowerShell 7. Process inspection uses a hidden
  PowerShell worker; where PowerShell is blocked, graceful stops still work but
  forced stops refuse with a clear error.
- Agent CLIs on `PATH` (Claude Code's native installer, or npm global installs).
- Run Puddle as your normal user, not elevated: an Administrator daemon owns
  its pipes and files differently from a non-elevated CLI.

## Decisions

1. **POSIX invariance.** Install scripts, shell hook templates, environment
   denylists and every SSH command stay byte-for-byte identical. Windows code
   lives behind `win32` checks, using an injectable `platform` parameter so both
   branches are tested on any OS.
2. **Home.** `%USERPROFILE%\.puddle` (`PUDDLE_HOME` still overrides). The
   profile's inherited ACL is owner-only; a newly created home additionally
   receives a protected DACL for the owner, SYSTEM and Administrators via
   `icacls` (best effort, warned on failure). Reparse points (symlinks and
   junctions) are refused as the home, mirroring the POSIX symlink rule.
3. **IPC.** Unix sockets become named pipes through `ipcPath`. On Windows the
   pipe name carries a random per-home nonce stored in `<home>\ipc-nonce`, so
   other local users, who cannot read the home, cannot connect to or squat a
   predictable pipe. Endpoint checks never open a pipe as a client. Headless
   agent turns use a per-launch pipe whose driver must present a per-launch
   token; the desktop's SSH askpass bridge uses a token in a private file.
4. **No shell for local host operations.** `LocalTransport.exec` refuses to run
   on Windows. Every local host operation (install, version lookup, removal and
   worktree sweep, logs, liveness, connector probes) has a Node implementation
   selected for a local Windows transport. Git Bash is never assumed. SSH to a
   Windows host is detected from the first failed remote command (cmd.exe's
   "not recognized" or status 9009, PowerShell's CommandNotFoundException, or
   an MSYS/MinGW/Cygwin `uname`), so POSIX connections run nothing extra. A
   background cockpit for an SSH host requires prompt-free authentication
   (`ssh -o BatchMode=yes`); otherwise use `--foreground`.
5. **Daemon installation.** The CLI installs a Windows daemon itself
   (`installation/windows-install.ts`): it downloads
   `puddled-v<V>-win32-x64.zip` and `SHA256SUMS` (honouring `HTTPS_PROXY`),
   verifies the checksum, extracts with `%SystemRoot%\System32\tar.exe`
   (stripping the top-level `puddled-v<V>\` folder), smoke-tests `--version`
   with the versioned `node.exe`, and points `bin\current` at
   `bin\versions\<V>` with a directory junction (no privilege required), flipped
   under the install lock. `bin\puddled.cmd` exists for humans only. `--tarball`
   takes a local zip verified against `<zip>.sha256`. Release names come from
   one helper, `installation/releases.ts`.
6. **Supervision.** A `detached` supervisor kind: the CLI or desktop spawns
   `bin\versions\<V>\bin\node.exe daemon\puddled.mjs` directly (detached,
   windowless, output to `logs\puddled.*.log`, `CLAUDECODE`/`CLAUDE_CODE_*`
   removed) and records the pid. It never uses Electron's own executable or
   PowerShell as the parent. The daemon's control pipe is the single-instance
   arbiter and stays open until the database is closed. A pipe that exists but
   does not answer is waited for, never replaced. Stops send the `shutdown`
   control request (protocol 25.7), retrying while the daemon is starting, wait
   for the pid to exit, and terminate only a process whose command line is that
   home's versioned `puddled.mjs`. Background cockpits stop over their launcher
   pipe (`shutdown`) and are forced only after an identity check by creation
   time.
7. **Shells.** Default terminal shell: `pwsh.exe`, then `powershell.exe`, then
   `%ComSpec%`. `SHELL` is honoured only when it names an existing Windows
   executable. PowerShell receives shell integration (cwd, title, environment
   capture, PSReadLine history isolation) through
   `-NoExit -Command ". ([ScriptBlock]::Create([IO.File]::ReadAllText('<hook>')))"`,
   which execution policy does not block and which runs after the profile.
   `cmd.exe` and WSL's `System32\bash.exe` run without hooks. Git Bash sources
   the bash hook through a Windows-only rcfile that reports `pwd -W` (the daemon
   also accepts `/c/x`); it does not capture the environment, because MSYS path
   lists would break native programs. The Windows capture denylist is separate
   from the POSIX one and case-insensitive.
8. **Processes.** A shared process table (a persistent hidden PowerShell worker
   over `Win32_Process`, about 80 ms per warm query) replaces `ps` for
   foreground-agent recognition and port attribution. With no job control,
   every descendant of the PTY root whose creation time is not before its
   parent's counts as foreground. Listeners come from `netstat -ano`, matched
   by foreign address rather than the localised State column, and are named by
   image without `.exe`; the proxy dials `::1` for ports that listen only on
   IPv6 loopback. Process trees stop with `taskkill /T /F`. ConPTY is never
   resized to the size it already has, since that repaints the screen.
9. **Executables.** Lookup honours `PATHEXT`. npm, pnpm, yarn and bun `.cmd`
   shims are resolved to `node.exe <script>` so arguments never pass through
   `cmd.exe`; other batch files run through `cmd.exe /d /s /c` with strict
   quoting, and arguments containing `%`, `!`, `"` or control characters are
   refused there. PTY command lines are built by Puddle (node-pty's own quoting
   splits arguments that start and end with `"`), bounded to Windows' 32,767
   characters.
10. **Environment.** Windows environment keys are case-insensitive: helpers set
    and read `Path`/`PATH` without creating duplicates. The agent search path is
    `;`-separated, expands `~` and `%VAR%`, and defaults to
    `~\.local\bin;%APPDATA%\npm;%LOCALAPPDATA%\pnpm;~\.bun\bin;~\scoop\shims`.
11. **Paths on the wire.** Absolute host paths are native and canonical
    (`C:\Users\a\repo`: `realpath.native`, upper-case drive letter).
    Root-relative paths always use `/`, and the daemon accepts either separator
    on input (including `~\`). `GET /api/host` reports `platform` and `osBuild`
    (protocol 25.7); the UI's path helpers in `@puddle/shared` infer the style
    from the path itself, so POSIX results never change. Browsing stops at a
    drive root. Writes refuse names Windows cannot store (reserved device names,
    `<>:"|?*`, control characters, trailing dots or spaces) with
    `invalid_name`; renaming or deleting an entry another program holds open
    answers `path_busy`; pruning a worktree with open handles answers
    `worktree_busy` after a rename probe and leaves it intact; a repository
    refused by git `safe.directory` answers `unsafe_repository`. The UI checks
    names with `windowsNameProblem` before creating, renaming or saving.
12. **Git.** `git.exe` runs hidden with long paths enabled. Background and
    create-time fetches set `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and
    `SSH_ASKPASS_REQUIRE=never`; user-initiated fetch, pull and push may show
    Git Credential Manager. Git baselines are raw blobs (the editor's diff
    ignores line endings).
13. **Agents.** Claude Code hooks use exec form (no shell). Its status line has
    only a shell form, so it is quoted for Git Bash when Claude would find one
    and for PowerShell otherwise; Gemini CLI hooks are quoted for PowerShell.
    Agent stores stay where each CLI keeps them (`%USERPROFILE%\.claude`,
    `.codex`, `.gemini`; OpenCode's XDG roots, never `%APPDATA%`), and recorded
    working directories compare case- and separator-insensitively.
    Conversation sharing uses directory junctions; an entry that cannot be
    linked is not shared, and its data is never copied.
14. **Code execution.** Programme terminals run an inline `node -e` wrapper on
    the daemon's bundled `node.exe` with a base64 JSON plan, so the release
    archive needs no extra file. It prints the same banner and
    `[Process exited with status N]` line as POSIX (Ctrl+C reports 130), then
    stays the parent of the session shell. Tools are found through `PATHEXT`
    plus the default install directories of the common installers; TeX comes
    from MiKTeX, TeX Live or TinyTeX, and `latexmk` is offered only with a Perl.
    Python discovery covers `py -0p`, venv `Scripts\python.exe` and Conda
    environments (run without activation), and skips Microsoft Store redirector
    stubs. Managed binaries end in `.exe`. Command templates treat `\` as
    literal; quotes group words.
15. **Packaging.** Release assets use the `win32-<arch>` token and `.zip`
    archives with the POSIX tarball's layout (`bin\node.exe`, `puddled.cmd` and
    `puddle-connector.cmd` in place of the sh launchers). The standalone CLI
    installs to `%LOCALAPPDATA%\puddle\cli` with `puddle.cmd`/`pudl.cmd`
    launchers in `%LOCALAPPDATA%\puddle\bin`, which `install.ps1` adds to the
    user `PATH` unless `-NoPathUpdate` is given (`installation.json` records
    `pathEntry` so `puddle remove cli` can take it out again); `current` is a
    directory junction. A self-hosted app serves `/install.ps1` beside
    `/install.sh`. The desktop app is an NSIS per-user one-click installer
    (`Puddle-<V>-x64-setup.exe`) that updates in-app; `puddle install/upgrade
desktop` runs it silently and `puddle remove desktop` runs its registered
    uninstaller. Building the daemon zip on Windows with a Node major other than
    the pinned runtime stages better-sqlite3's prebuild for the pinned runtime;
    CI builds with Node 22.
16. **Desktop SSH prompts.** Windows OpenSSH honours `SSH_ASKPASS` with
    `SSH_ASKPASS_REQUIRE=force`, but Electron writes a CRLF to stdout at startup,
    which OpenSSH would read as an empty answer, and a `.cmd` helper would let
    `cmd.exe` parse server-controlled prompt text. The askpass helper is
    therefore `ssh-askpass.exe`, a small C# programme built with the .NET
    Framework compiler that ships with Windows.
17. **Keyboard.** Only a Windows client changes keyboard handling. It spells
    shortcuts out (Ctrl+Alt+W, Win+K), reads defaults written for ⌘ with Ctrl
    because Windows reserves Win-key chords, and never fires a shortcut for
    AltGr. A focused terminal keeps every plain Ctrl+letter chord (shells and
    agents read Ctrl+R, Ctrl+T, Ctrl+B and similar); app shortcuts with
    Ctrl+Shift or Ctrl+Alt still win, and the desktop's Windows menu registers
    no plain Ctrl+letter accelerator. Terminals pass xterm
    `windowsPty: { backend: 'conpty', buildNumber }`.
18. **Line endings.** `.gitattributes` keeps LF in every checkout so embedded
    shell installers never gain CRLF.

## Known limitations

- Inbox ConPTY swallows OSC 10/11 colour queries (agents cannot detect a light
  or dark theme) and consumes escape sequences typed into its input; node-pty
  prints `AttachConsole failed` to the daemon's stderr when a PTY is killed.
- Listeners owned by `http.sys` (pid 4) or WSL cannot be attributed to a
  session.
- `taskkill /T` cannot reach a descendant whose parent has already exited; a
  job object would be needed for that.
- A detached daemon stays in its launcher's job object, so launching from a
  kill-on-close job (an OpenSSH server session, some CI or IDE hosts) stops it
  with the launcher.
- Interrupting a notebook cell blocked in `time.sleep` takes effect when the
  call returns (an ipykernel limitation on Windows).
- File watchers held by live compilation targets can make pruning their
  worktree answer `worktree_busy` until the target stops.
- Very deep worktrees can exceed `MAX_PATH` for tools that ignore long paths.
- Plain Ctrl+V in a terminal sends `^V` to the programme, as on Linux, rather
  than pasting as Windows Terminal does; the terminal menu offers Paste.

## Testing

- Run Windows tests from PowerShell as well as Git Bash: Git Bash puts a
  `bash` on `PATH` that hides a missing Node fake, and from PowerShell `bash`
  may be WSL's `System32\bash.exe`. The CI and release Windows jobs run under
  `pwsh` for the same reason.
- Daemon tests use a Node fake agent on Windows (`test/helpers`), and the bash
  fake elsewhere.
