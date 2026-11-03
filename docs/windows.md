# Native Windows support

Puddle runs natively on Windows 10 1809+ and Windows 11 (x64): the daemon
(`puddled`) hosts agents on a Windows machine through `puddle launch`, the CLI
works locally and as an SSH client to Linux/macOS hosts, and the desktop app
ships as a per-user installer. This document records the design decisions of
the port; SPEC.md describes the resulting behaviour. Linux and macOS behaviour
is unchanged: every Windows path is selected by `platform === 'win32'`.

## Support matrix

| Area                                      | Windows status                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Local host (`puddle launch` on Windows)   | Supported                                                             |
| CLI as SSH client to Linux/macOS hosts    | Supported (Windows OpenSSH has no ControlMaster: use key auth)        |
| SSH _to_ a Windows host                   | Not supported in v1; detected and refused with a clear message        |
| Desktop app                               | Supported (NSIS per-user installer, x64)                              |
| Standalone CLI installer                  | `install.ps1`                                                         |
| Remote access connector on a Windows host | Not supported in v1; Settings and `puddle remote` report it           |
| Daemon autostart at logon                 | Not in v1: the next launch restarts it and auto-resume restores state |
| Windows arm64 release assets              | Not in v1 (x64 assets run under emulation)                            |
| Code signing                              | Unsigned in v1 (SmartScreen warns on first run of a download)         |

## Decisions

1. **POSIX invariance.** Install scripts, shell hook templates, environment
   denylists and every SSH command stay byte-for-byte identical. Windows code
   lives behind `win32` checks, using the injectable `platform` options a
   module already exposes where it has one.
2. **Home.** `%USERPROFILE%\.puddle` (`PUDDLE_HOME` still overrides). The
   profile's inherited ACL is owner-only; a newly created home additionally
   receives a protected DACL for the owner, SYSTEM and Administrators via
   `icacls` (best effort, warned on failure). Reparse points (symlinks and
   junctions) are refused as the home, mirroring the POSIX symlink rule.
3. **IPC.** Unix sockets become named pipes through `ipcPath`. On Windows the
   pipe name carries a random per-home nonce stored in `<home>\ipc-nonce`, so
   other local users, who cannot read the home, cannot connect to or squat a
   predictable pipe.
4. **No shell for local host operations.** `LocalTransport.exec` refuses to run
   on Windows. Every local host operation (install, version lookup, removal,
   logs, liveness) has a Node implementation selected for a local Windows
   transport. Git Bash is never assumed.
5. **Daemon installation.** The CLI installs a Windows daemon itself
   (`installation/windows-install.ts`): it downloads
   `puddled-v<V>-win32-<arch>.zip` and `SHA256SUMS`, verifies the checksum,
   extracts with `%SystemRoot%\System32\tar.exe`, smoke-tests
   `--version`, and points `bin\current` at `bin\versions\<V>` with a directory
   junction (no privilege required). `bin\puddled.cmd` exists for humans only.
6. **Supervision.** A new `detached` supervisor kind: the CLI or desktop spawns
   `bin\versions\<V>\bin\node.exe` on the daemon entry point directly
   (detached, hidden window, output to `logs\puddled.*.log`) and records the pid.
   The daemon's control pipe is the single-instance arbiter and stays open
   until the database is closed. Stops use the authenticated `shutdown` control
   request (protocol 25.7), falling back to terminating the identity-checked
   pid after a timeout.
7. **Shells.** Default terminal shell: `pwsh.exe`, then `powershell.exe`, then
   `%ComSpec%`. `SHELL` is honoured only when it names an existing Windows
   executable. PowerShell receives shell integration (cwd, title, environment
   capture, history isolation) through
   `-NoExit -Command ". ([ScriptBlock]::Create([IO.File]::ReadAllText('<hook>')))"`,
   which execution policy does not block. `cmd.exe` runs without hooks. Git
   Bash reuses the bash hooks, with MSYS paths (`/c/x`) translated to `C:\x`.
8. **Processes.** A shared process table (persistent hidden PowerShell worker
   over `Win32_Process`) replaces `ps` for foreground-agent recognition and port
   attribution; `netstat -ano` replaces `lsof`/`ss`. Process trees are stopped
   with `taskkill /T /F`. Process names are compared without `.exe`, case
   insensitively.
9. **Executables.** Lookup honours `PATHEXT`. npm-style `.cmd` shims are
   resolved to `node.exe <script>` so arguments never pass through `cmd.exe`;
   other batch files run through `cmd.exe /d /s /c` with strict quoting, and
   arguments that cannot be quoted safely are refused.
10. **Environment.** Windows environment keys are case-insensitive: helpers set
    and read `Path`/`PATH` without creating duplicates. Path lists use `;`.
11. **Paths on the wire.** Absolute host paths are native and canonical
    (`C:\Users\a\repo`: `realpath.native`, upper-case drive letter).
    Root-relative paths always use `/`, and the daemon accepts either separator
    on input. `GET /api/host` reports `platform` (protocol 25.7); the UI's path
    helpers in `@puddle/shared` infer the style from the path itself, so POSIX
    results never change. Browsing stops at a drive root. Names Windows cannot
    store (reserved device names, `<>:"|?*`, trailing dots or spaces) are
    rejected on writes.
12. **Agents.** Hook and status-line commands invoke Puddle's Node executable
    on a script path, quoted for the shell each agent uses for hooks.
    Conversation sharing uses directory junctions; a link that cannot be made
    disables sharing for that entry instead of copying data.
13. **Code execution.** The terminal run wrapper is a Node script (Electron
    runs it with `ELECTRON_RUN_AS_NODE`), followed by the configured shell.
    Python discovery covers `py -0p`, venv `Scripts\python.exe`, and skips
    Microsoft Store redirector stubs. Managed binaries end in `.exe`.
14. **Packaging.** Release assets use the `win32-<arch>` token and `.zip`
    archives. The standalone CLI installs to `%LOCALAPPDATA%\puddle\cli` with
    `puddle.cmd`/`pudl.cmd` launchers in `%LOCALAPPDATA%\puddle\bin`, which
    `install.ps1` adds to the user `PATH` unless `-NoPathUpdate` is given. The
    desktop app is an NSIS per-user one-click installer with in-app updates.
15. **Line endings.** `.gitattributes` keeps LF in every checkout so embedded
    shell installers never gain CRLF.

## Requirements on a Windows host

- Git for Windows (`git.exe` on `PATH`). Enable long paths for deep worktrees:
  `git config --global core.longpaths true` and the `LongPathsEnabled` policy.
- PowerShell 5.1 (built in) or PowerShell 7.
- Agent CLIs on `PATH` (Claude Code's native installer, or npm global installs).
