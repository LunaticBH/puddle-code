# Native Windows support

Puddle runs natively on Windows 10 1809+ and Windows 11, x64 and arm64: the daemon (`puddled`)
hosts agents on a Windows machine, reached through `puddle launch` locally or `puddle launch
user@host` over the machine's OpenSSH server; the CLI works on Windows locally and as an SSH client;
and the desktop app ships as a per-user installer. This document records the design decisions of the
port; SPEC.md §10 "Windows hosts" describes the resulting behaviour. Linux and macOS behaviour is
unchanged: every Windows path is selected by `platform === 'win32'`.

**PowerShell is the only Windows automation and shell layer.** Puddle never uses Git Bash, MSYS or
WSL on a Windows host. It drives Windows through PowerShell (Windows PowerShell 5.1 is part of every
supported release) and through native system tools (`tar.exe`, `curl.exe`, `taskkill.exe`,
`icacls.exe`, `reg.exe`); `cmd.exe` appears only where Windows itself needs it for batch files.

## Support matrix

| Area                                    | Windows status                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local host (`puddle launch` on Windows) | Supported                                                                                     |
| SSH to a Windows host                   | Supported through the host's OpenSSH server, whatever its default shell (key auth recommended) |
| CLI as an SSH client                    | Supported (Windows OpenSSH has no ControlMaster: use key auth)                                |
| Session shells                          | PowerShell 7, else Windows PowerShell 5.1                                                     |
| Daemon autostart and crash restart      | Supported: a per-user logon task starts a resident supervisor                                 |
| Remote access connector                 | Supported locally and over SSH; the supervisor runs it                                        |
| Desktop app                             | Supported (NSIS per-user installers, x64 and arm64)                                           |
| Standalone CLI installer                | `install.ps1`                                                                                 |
| Architectures                           | Native x64 and arm64 assets, chosen by the operating system's architecture                    |
| Code signing                            | Authenticode when the release repository configures it; otherwise unsigned                    |

## Requirements on a Windows host

- Git for Windows 2.26 or newer (`git.exe` on `PATH`); its Bash is never used. Enable long paths
  for deep worktrees: `git config --global core.longpaths true` and the `LongPathsEnabled` policy.
- PowerShell 5.1 (built in) or PowerShell 7: session terminals, process inspection, Task Scheduler,
  `Get-Acl` and SSH host operations all run through it. Sessions in ConstrainedLanguage mode
  (AppLocker/WDAC) are refused with a clear message.
- For SSH: the OpenSSH server (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`).
- Tools installed outside the user profile and `%ProgramFiles%` (MSYS2 compilers, Strawberry Perl,
  Chocolatey, `C:\texlive`, all-user Conda) must be on `PATH`.
- Agent CLIs on `PATH` (Claude Code's native installer, or npm global installs).
- Run Puddle as your normal user. An administrator's SSH session is elevated; Puddle warns when a
  daemon it starts would run elevated.

## Decisions

1. **POSIX invariance.** Install scripts, shell hook templates, environment denylists and every
   command sent to a POSIX host stay byte-for-byte identical; `test/transport/posix-invariance`
   pins the SSH commands. Windows code lives behind `win32` checks, with an injectable `platform`
   parameter so both branches are tested on any OS. The one change a POSIX host can observe: when
   `ssh host true` fails with a status other than 255, the client sends one PowerShell probe before
   failing as before (decision 19).
2. **Home.** `%USERPROFILE%\.puddle` (`PUDDLE_HOME` still overrides). The profile's inherited ACL is
   owner-only, so a home inside it is used as found. A home Puddle creates receives a protected DACL
   for the owner, SYSTEM and Administrators via `icacls`; inside the profile this is best effort and
   warned on failure. Anywhere else (a `PUDDLE_HOME` such as `D:\puddle`), Puddle reads the home's
   owner and DACL as SDDL through `Get-Acl` once per process, and the check fails closed: a home
   another account owns is refused, one that grants any other principal access receives the
   protected DACL, and one holding entries another account could have placed there is refused.
   Clients initialise the home before their first write to it. Reparse points (symlinks and
   junctions) are refused as the home.
3. **IPC.** Unix sockets become named pipes through `ipcPath`. Any local user can list
   `\\.\pipe\`, so a pipe's name protects nothing by itself: each name is `puddle-` followed by an
   HMAC-SHA256, under the home's private `<home>\ipc-key`, of the canonical home path
   (`realpath.native`, upper-case drive letter), the scope and `<home>\ipc-nonce`. Windows clients
   send a random `challenge` and believe a reply only when its `proof` is an HMAC under `ipc-key`:
   the daemon's control channel (`open`, `shutdown`), the supervisor's pipe, and the connector's
   pipes (an optional first `{t:'challenge'}` answered `{t:'proven'}`) all prove themselves, and
   the daemon's notifications and the CLI's administrative requests wait for that proof. A server
   without it counts as absent; the installer then rotates the nonce under its lock, renaming every
   pipe of the home. Endpoint checks never open a pipe as a client. Headless agent turns use a
   per-launch pipe whose driver must present a per-launch token; the desktop's SSH askpass bridge
   uses a token in a private file.
4. **No shell for local host operations.** `LocalTransport.exec` refuses on Windows. Host
   operations go through `windowsOps(transport)` (`lib/host/windows-ops.ts`): in process for this
   machine, through the host helper for an SSH host (decision 19). A background cockpit for an SSH
   host requires prompt-free authentication (`ssh -o BatchMode=yes`); otherwise use `--foreground`.
5. **Daemon installation.** `installation/windows-install.ts` downloads `puddled-v<V>-win32-<arch>.zip`
   for the operating system's architecture and `SHA256SUMS` (honouring `HTTPS_PROXY`), verifies the
   checksum, extracts with `%SystemRoot%\System32\tar.exe` (stripping the top-level `puddled-v<V>\`
   folder; tar.exe runs in the home with ASCII paths relative to it, because it reads its arguments
   in the ANSI code page), smoke-tests `--version` asynchronously with the versioned `node.exe`,
   requires that `node.exe`'s PE machine to match the architecture, and points `bin\current` at
   `bin\versions\<V>` with a directory junction, flipped under the install lock. A tree of another
   architecture never counts as installed (remove, upgrade and sweep still act on it).
   `bin\puddled.cmd` exists for humans only. `--tarball` takes a local zip verified against
   `<zip>.sha256`. Release names come from `installation/releases.ts`.
6. **Supervision.** One root-folder scheduled task per home, `Puddle <first 16 hex of sha256 of the
   lower-cased canonical home>`, registered idempotently by install, upgrade and launch through the
   ScheduledTasks cmdlets (values travel in environment variables, never interpolated). It starts at
   the user's logon with an interactive token and least privilege, ignores new instances while
   running, has no time limit, runs on battery at priority 4, and is not hidden. Its action runs
   `bin\puddle-hidden.exe`, a windowless GUI-subsystem launcher compiled from
   `packages/daemon/src/supervision/puddle-hidden.cs`, on `bin\current\bin\node.exe
   daemon\supervisor.mjs --home <home>`; it relays the supervisor's status, unlike `conhost
   --headless`, which ignores its program's status and expands `%VAR%`. Task Scheduler expands
   `%VAR%` too, so a home containing `%`, `"` or a control character gets no task and runs
   `detached`. The resident supervisor is single-instance on its proven `supervisor` pipe. It runs
   the versioned `node.exe` on `puddled.mjs` as its child, writes `puddled.pid`, and restarts a
   crashed daemon with backoff from 1 s to 60 s, giving up after 10 failures in 10 minutes. It exits
   0 when its daemon exits 0 (a requested shutdown) or 75 (the home's control pipe is already
   served), stopping the connector first, and never lingers beside a daemon it does not run. Starts
   go task → WMI `Win32_Process.Create` (which escapes the caller's job object) → a detached child
   (local only). The marker is `task`; `detached` records a home whose task could not be
   registered. Stops send the `shutdown` control request, wait for the supervisor and daemon pids,
   and force only processes whose command line is that home's `supervisor.mjs` or versioned
   `puddled.mjs`. Removal disables the connector, unregisters the task, stops and deletes. After a
   reboot the logon task, or the next launch, starts the installed `bin\current`; the launcher's
   own release is installed only when that tree cannot run. Background cockpits stop over their
   launcher pipe (`shutdown`).
7. **Shells.** PowerShell is the only session shell: `SHELL` counts only when it names an existing
   absolute `pwsh.exe` or `powershell.exe`, then `pwsh.exe` on `PATH`, then Windows PowerShell 5.1.
   cmd.exe, Git Bash and WSL are never session shells; started inside one they run unhooked.
   PowerShell receives shell integration (cwd, title, environment capture, PSReadLine history
   isolation) through `-NoExit -Command ". ([ScriptBlock]::Create([IO.File]::ReadAllText('<hook>')))"`,
   which execution policy does not block and which runs after the profile. A Windows daemon writes
   only the PowerShell hook; the Windows capture denylist is separate and case-insensitive.
8. **Processes.** A shared process table (a persistent hidden PowerShell worker over
   `Win32_Process`, about 80 ms per warm query) replaces `ps` for foreground-agent recognition and
   port attribution. Every descendant of the PTY root whose creation time is not before its
   parent's counts as foreground; a root missing from the table contributes none. Listeners come
   from `netstat -ano`, matched by foreign address rather than the localised State column; the proxy
   dials `::1` for ports that listen only on IPv6 loopback. Process trees stop with
   `taskkill /T /F`. ConPTY is never resized to the size it already has.
9. **Executables.** Lookup honours `PATHEXT` and uses absolute `PATH` entries only: a bare name is
   never looked up in the working directory, and one missing from `PATH` is refused rather than
   spawned. A relative path with a directory part names a file in the command's working directory.
   `puddled`, `puddle` and `pudl` set `NoDefaultCurrentDirectoryInExePath` at start-up unless the
   user set it, and remove it again for terminals, agents, code runs and kernels. npm, pnpm, yarn
   and bun `.cmd` shims run as `node.exe <script>`; other batch files run through `cmd.exe /d /s
   /c` with strict quoting, refusing `%`, `!`, `"` and control characters. PTY command lines are
   built by Puddle and checked against the 32,767-character limit; an interactive agent's composed
   first prompt may be at most 24,000 quoted characters (`400 prompt_too_long`).
10. **Environment.** Windows environment keys are case-insensitive: helpers set and read
    `Path`/`PATH` without duplicates. The agent search path is `;`-separated, expands `~` and
    `%VAR%`, and defaults to `~\.local\bin;%APPDATA%\npm;%LOCALAPPDATA%\pnpm;~\.bun\bin;~\scoop\shims`.
11. **Paths on the wire.** Absolute host paths are native and canonical (`C:\Users\a\repo`).
    Root-relative paths always use `/`, and the daemon accepts either separator on input (including
    `~\`). `GET /api/host` reports `platform` and `osBuild` (protocol 25.7). Browsing stops at a
    drive root. Writes refuse names Windows cannot store (`invalid_name`); a rename or delete
    refused because the entry is open or access is denied answers `path_busy` with
    `details.cause`; a cross-drive move that cannot remove its source answers `source_not_removed`;
    pruning a worktree with open handles answers `worktree_busy` and leaves it intact; a repository
    refused by git `safe.directory` answers `unsafe_repository`. `GET /resolve` never opens a UNC
    or device path outside the session's tree, and the UI never offers one as a terminal link.
12. **Git.** `git.exe` is resolved on `PATH`, never run from a repository, and runs hidden with long
    paths enabled. Background and create-time fetches never prompt (`GIT_TERMINAL_PROMPT=0`,
    `GCM_INTERACTIVE=never`); user-initiated fetches, pulls and pushes may show Git Credential
    Manager.
13. **Agents.** Claude Code hooks use exec form. Its status line is one command that Git Bash,
    PowerShell and cmd.exe, whichever Claude Code picks, run alike: bare `/`-separated paths when
    they hold only `[A-Za-z0-9._-]`, else System32 `powershell.exe -EncodedCommand`. Gemini CLI
    hooks are quoted for PowerShell. Agent stores stay where each CLI keeps them. Conversation
    sharing uses directory junctions and never copies data.
14. **Code execution.** Programme terminals run an inline `node -e` wrapper on the daemon's
    `node.exe`, printing the same banner and `[Process exited with status N]` line as POSIX, then
    hand over to the session shell. `.ps1` files run with `pwsh`, else Windows PowerShell (`-NoLogo
    -NoProfile -ExecutionPolicy Bypass -File`); the Shell and Zsh recipes are POSIX-only. Tools
    are found through `PATHEXT` plus default install directories in the user profile and
    `%ProgramFiles%`; folders any account may create (the drive root, `%ProgramData%`) are never
    searched. Python discovery covers `py -0p`, venvs and Conda environments.
15. **Packaging.** Release assets use the `win32-<arch>` token (x64 and arm64, each built and
    smoke-tested natively) and `.zip` archives with the POSIX tarball's layout plus `bin\node.exe`,
    `bin\puddle-hidden.exe`, `daemon\supervisor.mjs` and the `.cmd` launchers; every PE file must
    match the architecture. The architecture is the operating system's (`windowsHostArch()`: the
    machine-wide `PROCESSOR_ARCHITECTURE` read with `reg.exe`), never the process's. The standalone
    CLI installs to `%LOCALAPPDATA%\puddle\cli` with launchers in `%LOCALAPPDATA%\puddle\bin`,
    which `install.ps1` adds to the user `PATH` unless `-NoPathUpdate`; it refuses an archive
    built for another architecture. Every CLI archive ships `cli\windows-host.mjs` (decision 19).
    The desktop installers are `Puddle-<V>-<arch>-setup.exe` and update in-app; `puddle
    install/upgrade desktop` runs them silently and `puddle remove desktop` runs the registered
    uninstaller.
16. **Desktop SSH prompts.** The askpass helper is `ssh-askpass.exe`, a small AnyCPU C# programme
    built with the .NET Framework compiler that ships with Windows: Electron writes a CRLF at
    startup that OpenSSH would read as an empty answer, and a `.cmd` helper would let `cmd.exe`
    parse server-controlled prompt text.
17. **Keyboard.** Only a Windows client changes keyboard handling: shortcuts are spelled out, ⌘
    defaults read Ctrl, AltGr never fires a shortcut, and a focused terminal keeps every plain
    Ctrl+letter chord. Terminals and the daemon's headless mirror use xterm `windowsPty: { backend:
    'conpty', buildNumber }`.
18. **Line endings.** `.gitattributes` keeps LF in every checkout.
19. **SSH to Windows hosts.** The client keeps `ssh host true`: status 0 means POSIX and 255
    unreachable. Any other status triggers one PowerShell probe over the authenticated connection;
    a valid answer makes the transport `win32` for good (handed to a background cockpit as
    `PUDDLE_REMOTE_PLATFORM`), and a later POSIX command failing with a Windows signature (cmd.exe's
    9009, `CommandNotFoundException`, an MSYS/MinGW/Cygwin `uname` from a Git Bash default shell)
    is confirmed the same way. Once `win32`, POSIX commands refuse. Every operation is
    `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand
    <loader>`, which parses identically under a cmd.exe, PowerShell or Git Bash default shell. The
    loader reads a length-framed UTF-8 script (`PUDDLE1 <bytes>`) from raw stdin and runs it with
    the rest of the stream, reports errors as plain UTF-8 and ends stderr with `puddle-exit:<n>`,
    since PowerShell shells collapse exit statuses. A first install downloads the zip and
    `SHA256SUMS` with System32 `curl.exe`, checks them with `Get-FileHash`, and unpacks only
    `bin\node.exe`; `--tarball` streams the zip over the operation's own stdin. Everything else runs
    in the CLI's own host helper, `windows-host.mjs`, staged per process in `%TEMP%\puddle-host`
    (stale copies are cleared after a day) and run by the host's `node.exe`; it reuses the local
    Windows implementations and answers in JSON lines, and checks the control channel's proof on the
    host. Windows OpenSSH runs each session in a kill-on-close job, so the helper never starts a
    detached child: it starts the logon task, else the supervisor through WMI; if both are refused
    the daemon becomes a session-bound attached lease (`daemonLifetime: 'cockpit'`) that stops only
    its own pid. Supervised remote access over SSH needs a supervisor that outlives the session.

## Known limitations

- Inbox ConPTY swallows OSC 10/11 colour queries and consumes escape sequences typed into its
  input; node-pty prints `AttachConsole failed` to the daemon's stderr when a PTY is killed.
- Listeners owned by `http.sys` (pid 4) cannot be attributed to a session.
- `taskkill /T` cannot reach a descendant whose parent has already exited.
- The logon task starts the daemon at logon, not at boot, and Task Scheduler ends it at logoff. A
  daemon started over SSH through WMI with key authentication has a network-logon token: no DPAPI,
  Credential Manager or network credentials; one started by the logon task has them.
- `powershell -EncodedCommand` may trip endpoint-protection rules on managed hosts.
- An SSH session whose OpenSSH default shell is WSL's bash lands in Linux, and Puddle treats that
  host as Linux.
- Windows clients re-authenticate SSH for every operation (no ControlMaster).
- Interrupting a notebook cell blocked in `time.sleep` takes effect when the call returns.
- File watchers held by live compilation targets can make pruning their worktree answer
  `worktree_busy` until the target stops.
- Another local account that creates the daemon's pipe while it is stopped and never answers
  blocks the daemon until that process exits.
- Plain Ctrl+V in a terminal sends `^V` to the programme, as on Linux; the terminal menu offers
  Paste.

## Release signing

Signing is optional. The release workflow sets `PUDDLE_WINDOWS_SIGNING` to `certificate` (secrets
`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`), `azure` (Azure Trusted Signing over OIDC: variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`,
`AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER`, the profile's exact
subject CN) or `none`, which builds unsigned. `scripts/lib/windows-sign.mjs` signs every
`.exe`/`.dll`/`.node` in the daemon and CLI zips that Windows does not already report as validly
signed, plus `cli\install-cli.ps1`, before the smoke tests and checksums; electron-builder signs the
desktop app, its DLLs, `ssh-askpass.exe` and the installer. CI checks `Get-AuthenticodeSignature`.
A signed `Puddle.exe` accepts only an update installer from the same signer.

## Testing

- Run Windows tests from PowerShell, as CI does; no test or script may rely on Git Bash or a `bash`
  on `PATH`. Tests never register real scheduled tasks: every Task Scheduler and WMI call goes
  through an injectable `PowerShellRunner`.
- `test/helpers/fake-windows-ssh.mjs` is a fake Windows OpenSSH server for end-to-end tests
  (`e2e/windows-ssh.test.ts`, `FAKE_WINDOWS_SSH_SHELL=cmd|powershell|bash`). The real-host test,
  `ssh-test/windows-host.test.ts`, runs when `PUDDLE_TEST_WINDOWS_SSH` (user@host),
  `PUDDLE_TEST_WINDOWS_SSH_KEY` and `PUDDLE_TEST_WINDOWS_SSH_TARBALL` are set; it uses an isolated
  remote home and cleans up its task and home.
- The helper honours `PUDDLE_TEST_WINDOWS_SUPERVISION=wmi|session` only for a home inside the
  host's temporary directory.
- Daemon tests use a Node fake agent on Windows (`test/helpers`).
