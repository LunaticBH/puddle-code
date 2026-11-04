import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateDirectory } from '@puddle/shared/node';
import {
  connectorSupervisedMarker,
  superviseWindowsConnector,
  unschedulableHome,
  type StartSupervisorOptions,
} from '@puddle/shared/node/platform';

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unit = (value: string) =>
  '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
export function supervisorKind(
  home: string,
  platform: NodeJS.Platform = process.platform,
): 'systemd' | 'launchd' | 'task_scheduler' {
  const kind = readFileSync(join(home, 'supervisor'), 'utf8').trim();
  // Windows: the home's logon task starts the supervisor, which runs the
  // connector too; `detached` means Task Scheduler refused that task.
  if (platform === 'win32' && kind === 'task') return 'task_scheduler';
  if (platform === 'win32' && kind === 'detached')
    throw new Error(
      'Persistent daemon supervision is required. Reinstall the daemon (puddle upgrade daemon) so Task Scheduler starts it at logon, or use remote enable --foreground, then remote run.',
    );
  if (kind !== 'systemd' && kind !== 'launchd')
    throw new Error(
      'Persistent daemon supervision is required. Configure an external supervisor and use remote enable --foreground, then remote run.',
    );
  return kind;
}

/** Test seams for the Windows supervisor start: no test registers a real task. */
export type WindowsSupervisorSeams = Pick<
  StartSupervisorOptions,
  'powershell' | 'spawnDetached' | 'waitMs'
>;

export async function installConnectorSupervisor(
  home: string,
  platform: NodeJS.Platform = process.platform,
  seams: WindowsSupervisorSeams = {},
): Promise<void> {
  // eslint-disable-next-line no-control-regex -- Reject control characters at the trust boundary.
  if (/[\r\n\u0000]/.test(home)) throw new Error('Invalid Puddle home');
  const kind = supervisorKind(home, platform);
  if (kind === 'task_scheduler') {
    // The counterpart of an installed unit: the supervisor runs the
    // connector while this marker exists (until the daemon is removed).
    const problem = unschedulableHome(home);
    if (problem !== undefined) throw new Error(problem);
    const marker = connectorSupervisedMarker(home);
    privateDirectory(dirname(marker));
    writeFileSync(marker, '', { mode: 0o600 });
    await superviseWindowsConnector(home, { ...seams, task: true });
    return;
  }
  const node = join(home, 'bin/current/bin/node');
  const script = join(home, 'bin/current/daemon/connector.mjs');
  if (kind === 'systemd') {
    const directory = join(homedir(), '.config/systemd/user');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'puddle-connector.service'),
      `[Unit]\nDescription=Puddle remote connector\nAfter=network-online.target puddled.service\n[Service]\nExecStart=${unit(node)} ${unit(script)}\nEnvironment=${unit('PUDDLE_HOME=' + home)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'puddle-connector'], { stdio: 'pipe' });
  } else {
    const directory = join(homedir(), 'Library/LaunchAgents');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'dev.puddle.connector.plist');
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>dev.puddle.connector</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array><key>EnvironmentVariables</key><dict><key>PUDDLE_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>Umask</key><integer>63</integer></dict></plist>`,
      { mode: 0o600 },
    );
    const domain = `gui/${process.getuid!()}`;
    try {
      execFileSync('launchctl', ['print', `${domain}/dev.puddle.connector`], { stdio: 'pipe' });
      execFileSync('launchctl', ['kickstart', `${domain}/dev.puddle.connector`], { stdio: 'pipe' });
      return;
    } catch {
      /* First installation. */
    }
    execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'pipe' });
  }
}
