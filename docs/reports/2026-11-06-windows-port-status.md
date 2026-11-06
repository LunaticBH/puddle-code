# Native Windows port: what is not done — 6 November 2026

Every feature in the [Windows support matrix](../windows.md#support-matrix) is implemented, and
the full test suite passes on Windows (from PowerShell) and Linux. What remains is verification
that needs hardware, accounts or tools this port was not built with, a few release steps, and the
platform limits listed under [Known limitations](../windows.md#known-limitations).

## Built but never run for real

- **CI and releases.** The Windows CI jobs (x64 and `windows-11-arm`) and the Windows release
  matrix have never run on GitHub Actions.
- **arm64.** Native `win32-arm64` builds and operating-system architecture detection are covered by
  unit tests only; nothing has run on Windows on Arm hardware.
- **Code signing.** The certificate and Azure Trusted Signing paths are untested: no signing
  credentials were available. Unsigned builds work.
- **Desktop app.** The NSIS installer builds, but installing it, updating from inside the app,
  `puddle install/upgrade/remove desktop` against a real installation, and toast notifications
  have not been exercised.
- **Logon autostart.** The per-home scheduled task was registered, run, crash-restarted and
  removed for real, but never started by an actual sign-in.

## Not verified against real software

- **Agents.** Only Claude Code was checked on Windows. Codex, Gemini CLI and OpenCode Windows paths
  (stores, hooks, quoting, process matching) come from their source code. Typing a prompt into a
  running agent session through ConPTY has not been accepted per agent.
- **Toolchains.** MiKTeX, TeX Live and real C, C++ and Rust compilers were not installed; those
  paths were tested with stand-ins.

## SSH to Windows hosts

The real-server test passed against Windows OpenSSH 9.5 with a Windows client, cmd.exe as the
server's default shell, an administrator account and the user logged on at the desktop. Not yet
run against a real server:

- a Linux or macOS client;
- PowerShell or Git Bash as the server's default shell (the fake server covers both);
- the path used when nobody is logged on (supervisor started through WMI) and its elevation
  warning;
- a non-English Windows (the hidden "'true' is not recognized" answer is matched in English only).

## Release steps

- `CHANGELOG.md` is still `[Unreleased]`; no version has been cut.
- Protocol 25.7 is unreleased, and `RELEASE_PROTOCOLS` has no entry for it.
- No pull request has been opened against the upstream repository.
