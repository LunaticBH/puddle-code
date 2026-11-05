import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  remoteAdminRequestSchema,
  profileId,
  remoteAdminResponseSchema,
  remoteOriginSchema,
  remoteSecretSchema,
} from '@puddle/shared';
import { elevatedWarning, remoteWindowsHost } from '../lib/host/windows-remote-host.js';
import { windowsOps } from '../lib/host/windows-ops.js';
import {
  connectorEnvironment,
  windowsConnectorPaths,
  type WindowsConnectorRunner,
} from '../lib/installation/windows-connector.js';
import { remoteWindows } from '../lib/transport/host-platform.js';
import { isLocalWindows, LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import { clientHome, hostPaths } from '../lib/paths.js';
import { CliError } from '../lib/types.js';

export interface RemoteCommand {
  cmd: 'remote';
  action:
    'enable' | 'status' | 'pair' | 'approve' | 'devices' | 'revoke' | 'disable' | 'reset' | 'run';
  host?: string;
  profile?: string;
  id?: string;
  service?: string;
  app?: string;
  foreground: boolean;
}
export function parseRemoteArgs(args: string[]): RemoteCommand {
  const [action, ...rest] = args;
  if (
    !action ||
    ![
      'enable',
      'status',
      'pair',
      'approve',
      'devices',
      'revoke',
      'disable',
      'reset',
      'run',
    ].includes(action)
  )
    throw new CliError(
      'bad_arguments',
      'remote takes enable, status, pair, approve, devices, revoke, disable, reset or run',
    );
  const command: RemoteCommand = {
    cmd: 'remote',
    action: action as RemoteCommand['action'],
    foreground: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--foreground') command.foreground = true;
    else if (arg === '--profile') {
      const parsed = profileId.safeParse(rest[++i]);
      if (!parsed.success)
        throw new CliError('bad_arguments', '--profile requires an exact profile id');
      command.profile = parsed.data;
    } else if (arg === '--service' || arg === '--app-origin') {
      const value = remoteOriginSchema.safeParse(rest[++i]);
      if (!value.success) throw new CliError('bad_arguments', `${arg} needs an exact HTTPS origin`);
      if (arg === '--service') command.service = value.data;
      else command.app = value.data;
    } else if (arg.startsWith('-'))
      throw new CliError('bad_arguments', `Unknown remote option ${arg}`);
    else positional.push(arg);
  }
  if (action === 'approve' || action === 'revoke') {
    command.id = positional.shift();
    if (!remoteAdminRequestSchema.safeParse({ t: action, id: command.id }).success)
      throw new CliError(
        'bad_arguments',
        `${action} requires an exact device/request id from remote devices`,
      );
  }
  command.host = positional.shift();
  if (command.host === 'local') command.host = undefined;
  if (positional.length || (command.host && !command.host.includes('@')))
    throw new CliError('bad_arguments', 'Use local or user@host');
  if (action !== 'enable' && (command.service || command.app || command.foreground))
    throw new CliError('bad_arguments', 'Configuration options apply only to remote enable');
  if (!!command.service !== !!command.app)
    throw new CliError('bad_arguments', 'Specify both --service and --app-origin');
  if (action !== 'run' && !command.profile)
    throw new CliError('bad_arguments', 'Select a profile with --profile <profile-id>');
  if (action === 'run' && command.profile)
    throw new CliError('bad_arguments', 'remote run supervises all registered profiles');
  return command;
}
async function registrationCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 256) throw new Error('Registration code is too long');
    }
    return remoteSecretSchema.parse(input.trim());
  }
  process.stderr.write('Registration code (input hidden): ');
  const silent = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    return remoteSecretSchema.parse(
      await new Promise<string>((resolve) => readline.question('', resolve)),
    );
  } finally {
    readline.close();
    process.stderr.write('\n');
  }
}
/**
 * `puddle remote run` on this Windows machine: the manager in the
 * foreground, sharing this console. Ctrl+C reaches both processes; the CLI
 * waits for the connector to stop cleanly rather than dying first.
 */
function runWindowsConnectorForeground(home: string): Promise<number> {
  const { node, script } = windowsConnectorPaths(home);
  const ignore = () => {};
  process.on('SIGINT', ignore);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(node, [script], {
      cwd: homedir(),
      stdio: 'inherit',
      env: connectorEnvironment(home),
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => process.off('SIGINT', ignore));
}

export async function runRemote(
  command: RemoteCommand,
  /** Test seams for this Windows machine's connector. */
  windows: { run?: WindowsConnectorRunner; home?: string } = {},
): Promise<number> {
  const transport = command.host ? new SshTransport(command.host) : new LocalTransport();
  try {
    if (transport instanceof SshTransport) await transport.open();
    const localWindows = isLocalWindows(transport);
    const home = windows.home ?? clientHome();
    const base = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/connector.mjs`;
    // A Windows host (this machine or an SSH one) has no shell for the fixed
    // commands: its installed node.exe runs the connector.
    const seams = { home: () => home, ...(windows.run ? { run: windows.run } : {}) };
    let hostOps = windowsOps(transport, seams);
    const connector = (flag: string, opts: { stdin?: string; timeoutMs?: number }) =>
      hostOps ? hostOps.connector([flag], opts) : transport.exec(`${base} ${flag}`, opts);
    const capabilitiesOf = async () => {
      const installed = hostOps
        ? (await hostOps.connectorInstalled()).installed
        : (await transport.exec(`test -f ${hostPaths.current}/daemon/connector.mjs`)).code === 0;
      if (!installed)
        throw new CliError(
          'not_installed',
          'The installed daemon does not include mobile access',
          `puddle upgrade daemon${command.host ? ` ${command.host}` : ''}`,
        );
      return connector('--version', { timeoutMs: 10_000 });
    };
    let capabilities = await capabilitiesOf();
    // A Windows host whose OpenSSH default shell is Git Bash passes `true` and
    // answers both POSIX commands; its connector gives it away. Every later
    // step goes through the host helper over PowerShell instead, with its
    // session-bound guard, and Git Bash runs nothing more.
    if (
      hostOps === null &&
      transport instanceof SshTransport &&
      /; platform win32\b/.test(capabilities.stdout)
    ) {
      if (!(await transport.confirmWindows()))
        throw new CliError(
          'unsupported_platform',
          `${transport.label} runs a Windows connector but does not answer as a Windows host`,
          'report it with the command you ran',
        );
      hostOps = windowsOps(transport, seams);
      capabilities = await capabilitiesOf();
    }
    if (capabilities.code !== 0 || !capabilities.stdout.includes('cockpit controls 2'))
      throw new CliError(
        'protocol_mismatch',
        'Upgrade the host daemon before managing profile registrations.',
      );
    if (command.action === 'run') {
      if (localWindows) return await runWindowsConnectorForeground(home);
      const write = (text: string) => process.stdout.write(text);
      const ssh = remoteWindows(transport);
      if (ssh) return await remoteWindowsHost(ssh).connectorForeground(write);
      const result = await transport.exec(base, { onStdout: write });
      return result.code;
    }
    if (command.action === 'reset') {
      const result = await connector('--reset', {
        timeoutMs: 30_000,
        stdin: JSON.stringify({ profile: command.profile }) + '\n',
      });
      if (result.code !== 0)
        throw new CliError('bad_arguments', result.stderr.trim() || 'Reset failed');
      process.stdout.write(
        'Remote access disabled; host identity rotated and all browsers revoked. Enable and pair again.\n',
      );
      return 0;
    }
    const payload =
      command.action === 'enable'
        ? {
            service: command.service,
            app: command.app,
            ...(command.service ? { code: await registrationCode() } : {}),
            managed: !command.foreground,
          }
        : { t: command.action, ...(command.id ? { id: command.id } : {}) };
    const result = await connector(command.action === 'enable' ? '--configure' : '--admin', {
      stdin:
        JSON.stringify(
          command.action === 'enable'
            ? { profile: command.profile, setup: payload }
            : { profile: command.profile, request: payload },
        ) + '\n',
      // A Windows enable may start the home's supervisor first.
      timeoutMs: hostOps && command.action === 'enable' ? 120_000 : 30_000,
    });
    if (result.code !== 0)
      throw new CliError('bad_arguments', result.stderr.trim() || 'Remote operation failed');
    const response = remoteAdminResponseSchema.parse(JSON.parse(result.stdout));
    if (response.error) throw new CliError('bad_arguments', response.error);
    if (response.url) process.stdout.write(`${response.url}\n`);
    else if (response.devices)
      for (const device of response.devices)
        process.stdout.write(`${device.id}  ${device.status}  ${device.label}\n  ${device.peer}\n`);
    else
      process.stdout.write(
        `Remote access ${response.enabled ? 'enabled' : 'disabled'}${response.connected ? ', connected' : ', disconnected'}\n`,
      );
    if (command.action === 'enable' && command.foreground)
      process.stdout.write('Run puddle remote run under your external supervisor.\n');
    // The connector runs as the supervisor's child, with its token.
    const ssh = remoteWindows(transport);
    if (command.action === 'enable' && ssh && (await ssh.windowsProbe(true)).elevatedSupervisor)
      process.stderr.write(`Puddle: ${elevatedWarning(ssh.label, 'wmi')}\n`);
    return 0;
  } finally {
    transport.dispose();
  }
}
