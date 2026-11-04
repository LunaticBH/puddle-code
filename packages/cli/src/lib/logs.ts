import { windowsOps } from './host/windows-ops.js';
import { hostPaths } from './paths.js';
import type { Transport } from './transport/transport.js';
import { CliError } from './types.js';

export interface LogsOptions {
  /** Session id (or unique prefix already resolved by the caller). */
  session?: string;
  /** Terminal within the session; default the agent PTY. */
  term?: string;
  follow?: boolean;
  /** Where output lines go (the bin passes process.stdout.write). */
  write: (chunk: string) => void;
  /** Ends a Windows `follow` (embedders and tests; the bin follows until Ctrl-C). */
  signal?: AbortSignal;
}

/**
 * Log access reads files over the Transport — deliberately NOT a gateway
 * attach, which would resize the live PTY out from under the agent
 * (ws/gateway.ts delivers every attach's dimensions). A Windows host has no
 * `tail` or journald: windows-logs.ts reads its files, in process or
 * through the SSH host helper.
 */
export async function showLogs(transport: Transport, opts: LogsOptions): Promise<void> {
  const windows = windowsOps(transport);
  if (windows) return windows.logs(opts);
  if (opts.session !== undefined) {
    const file = `${hostPaths.logs}/${opts.session}/${opts.term ?? 'agent'}.log`;
    const command = opts.follow ? `tail -f -c 262144 ${file}` : `tail -c 262144 ${file}`;
    const result = await transport.exec(command, {
      onStdout: opts.write,
      ...(opts.follow ? {} : { timeoutMs: 30_000 }),
    });
    if (result.code !== 0 && !opts.follow) {
      throw new CliError(
        'unknown_session',
        `no log at ${file}`,
        'list sessions with: puddle status — the id is the log directory name',
      );
    }
    return;
  }

  // Daemon logs: journald on Linux, the launchd log files on macOS.
  const command =
    `if command -v journalctl >/dev/null 2>&1 && journalctl --user -u puddled -n 1 >/dev/null 2>&1; then ` +
    `journalctl --user -u puddled -n 200 --no-pager${opts.follow ? ' -f' : ''}; ` +
    `elif [ -f ${hostPaths.logs}/puddled.out.log ]; then ` +
    `tail ${opts.follow ? '-f ' : ''}-n 200 ${hostPaths.logs}/puddled.out.log ${hostPaths.logs}/puddled.err.log 2>/dev/null; ` +
    `else echo 'no daemon logs found — the daemon logs to its supervisor (journalctl --user -u puddled / ~/.puddle/logs)'; fi`;
  await transport.exec(command, { onStdout: opts.write });
}
