import { removeWindowsDaemon, sweepWindowsWorktrees } from './windows-remove.js';
import { clientHome } from '../paths.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type Logger, silentLogger } from '../types.js';

/**
 * `puddle remove daemon` (SPEC §10): stop and unregister the supervisor,
 * delete the bootstrap-managed pieces of ~/.puddle, and — only when the user
 * separately confirms — the whole ~/.puddle. Everything runs as one POSIX
 * script piped over the transport, exactly like install.sh, so local and SSH
 * removal share an implementation. Never sudo: the installer never was.
 *
 * Data stance: without purge, ~/.puddle keeps its DATA — puddle.db (profiles,
 * sessions), agent config dirs, worktrees, PTY logs, the token — so a later
 * `puddle launch` resumes where the removal left off. What goes is what the
 * bootstrap can regenerate: bin/, cache/, runtime.json, the supervisor marker,
 * and the supervisor registration (systemd user unit / launchd agent / nohup
 * pidfile).
 */

/** Worktrees carrying work a purge would destroy: dirty, or unpushed commits. */
export async function sweepDirtyWorktrees(transport: Transport): Promise<string[]> {
  if (isLocalWindows(transport)) return sweepWindowsWorktrees(clientHome());
  // Two levels (~/.puddle/worktrees/<repo>/<dir>); a linked worktree's .git is
  // a FILE, so test both. Failures read as "not dirty" — this is a warning
  // sweep, not an inventory.
  const script = `
W="\${PUDDLE_HOME:-$HOME/.puddle}/worktrees"
[ -d "$W" ] || exit 0
for d in "$W"/*/*; do
  [ -e "$d/.git" ] || continue
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | head -1)
  unpushed=$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null | head -1)
  if [ -n "$dirty" ] || [ -n "$unpushed" ]; then printf '%s\\n' "$d"; fi
done
exit 0`;
  const result = await transport.exec('sh -s', { stdin: script, timeoutMs: 60_000 });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Stop, unregister, and delete. Tries every supervisor flavour (whichever the
 * install landed on exists; the others no-op), then removes either the
 * bootstrap pieces or the whole home. Idempotent, like the installer.
 */
export async function removeDaemon(
  transport: Transport,
  opts: { purge: boolean; logger?: Logger } = { purge: false },
): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  if (isLocalWindows(transport)) {
    return removeWindowsDaemon(clientHome(), { purge: opts.purge, logger });
  }
  const script = `
set -u
HOME_DIR="\${PUDDLE_HOME:-$HOME/.puddle}"
say() { printf 'puddled remove: %s\\n' "$1"; }

# Persist remote disable before unregistering either supervisor.
if [ -f "$HOME_DIR/bin/current/daemon/connector.mjs" ] && [ -d "$HOME_DIR/remote" ]; then
  if [ -f "$HOME_DIR/bin/current/CONNECTOR_PROTOCOL" ]; then
    "$HOME_DIR/bin/current/bin/node" "$HOME_DIR/bin/current/daemon/connector.mjs" --disable-all >/dev/null 2>&1 || exit 1
  elif [ -f "$HOME_DIR/remote/config.json" ]; then
    printf '%s\\n' '{"t":"disable"}' | "$HOME_DIR/bin/current/bin/node" "$HOME_DIR/bin/current/daemon/connector.mjs" --admin >/dev/null 2>&1 || exit 1
  fi
fi

# systemd user unit
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now puddle-connector >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/puddle-connector.service"
  systemctl --user disable --now puddled >/dev/null 2>&1 || true
  if [ -f "$HOME/.config/systemd/user/puddled.service" ]; then
    rm -f "$HOME/.config/systemd/user/puddled.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    say "removed the systemd user unit"
  fi
fi

# launchd connector
CONNECTOR_PLIST="$HOME/Library/LaunchAgents/dev.puddle.connector.plist"
if [ -f "$CONNECTOR_PLIST" ]; then
  launchctl bootout "gui/$(id -u)/dev.puddle.connector" 2>/dev/null || true
  rm -f "$CONNECTOR_PLIST"
fi

# launchd agent
PLIST="$HOME/Library/LaunchAgents/dev.puddle.puddled.plist"
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)/dev.puddle.puddled" 2>/dev/null \\
    || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "removed the launchd agent"
fi

# nohup fallback
if [ -f "$HOME_DIR/puddled.pid" ]; then
  kill "$(cat "$HOME_DIR/puddled.pid")" 2>/dev/null || true
  rm -f "$HOME_DIR/puddled.pid"
fi

if [ "\${PUDDLE_PURGE:-0}" = 1 ]; then
  rm -rf "$HOME_DIR"
  say "deleted $HOME_DIR"
else
  rm -rf "$HOME_DIR/bin" "$HOME_DIR/cache" "$HOME_DIR/runtime.json" "$HOME_DIR/supervisor"
  say "removed the install; data kept under $HOME_DIR"
fi`;
  const result = await transport.exec(`PUDDLE_PURGE=${opts.purge ? 1 : 0} sh -s`, {
    stdin: script,
    timeoutMs: 2 * 60_000,
    onStdout: (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim() !== '') logger.info(line.trimEnd());
    },
  });
  if (result.code !== 0) {
    throw new CliError(
      'not_installed',
      `the removal failed on ${transport.label} (exit ${result.code})`,
      result.stderr.trim().split('\n').slice(-3).join('\n'),
    );
  }
}
