import { CliError, type CliErrorCode } from '../types.js';

/**
 * The host helper's answers (src/windows-host.ts): JSON lines on its
 * standard output, so a CliError raised on the Windows host reaches the
 * client with its code and keeps driving ensureDaemon there. The helper is
 * the client's own bundle, staged per process, so both ends always share
 * this module; it never crosses releases and is not part of the daemon
 * protocol.
 */
export type HelperMessage =
  | { t: 'log'; level: 'info' | 'warn'; message: string }
  /** `puddle logs` text, passed on as it is read. */
  | { t: 'out'; text: string }
  /** The attached daemon's pid, once it runs. */
  | { t: 'started'; pid: number }
  | { t: 'result'; value?: unknown }
  | { t: 'error'; code: string; message: string; hint?: string };

const CODES: readonly CliErrorCode[] = [
  'ssh_unreachable',
  'daemon_unreachable',
  'daemon_start_timeout',
  'upgrade_failed',
  'cli_outdated',
  'protocol_mismatch',
  'port_in_use',
  'ambiguous_session',
  'unknown_session',
  'attach_needs_tty',
  'unsupported_platform',
  'not_installed',
  'no_cockpit',
  'already_running',
  'cockpit_launch_failed',
  'token_rejected',
  'bad_arguments',
  'session_bound',
];

/** One line of helper output, or null for anything else (a stray line is ignored). */
export function parseHelperMessage(line: string): HelperMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.t) {
    case 'log':
      return typeof v.message === 'string'
        ? { t: 'log', level: v.level === 'warn' ? 'warn' : 'info', message: v.message }
        : null;
    case 'out':
      return typeof v.text === 'string' ? { t: 'out', text: v.text } : null;
    case 'started':
      return typeof v.pid === 'number' ? { t: 'started', pid: v.pid } : null;
    case 'result':
      return { t: 'result', value: v.value };
    case 'error':
      return typeof v.code === 'string' && typeof v.message === 'string'
        ? {
            t: 'error',
            code: v.code,
            message: v.message,
            ...(typeof v.hint === 'string' ? { hint: v.hint } : {}),
          }
        : null;
    default:
      return null;
  }
}

/** The CliError a helper reported, with its code when it is one the client knows. */
export function helperError(message: Extract<HelperMessage, { t: 'error' }>): CliError {
  const code = (CODES as readonly string[]).includes(message.code)
    ? (message.code as CliErrorCode)
    : 'not_installed';
  return new CliError(code, message.message, message.hint);
}

/** The helper's own report of a failure, kept to what a CliError carries. */
export function errorMessage(err: unknown): Extract<HelperMessage, { t: 'error' }> {
  if (err instanceof CliError) {
    return {
      t: 'error',
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    };
  }
  return {
    t: 'error',
    code: 'not_installed',
    message: err instanceof Error ? err.message : String(err),
  };
}
