import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unit = (value: string) =>
  '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
export function supervisorKind(home: string): 'systemd' | 'launchd' {
  const kind = readFileSync(join(home, 'supervisor'), 'utf8').trim();
  // The Windows `detached` supervisor has no connector counterpart in v1.
  if (kind === 'detached') throw new Error('Remote access is not supported on Windows hosts yet.');
  if (kind !== 'systemd' && kind !== 'launchd')
    throw new Error(
      'Persistent daemon supervision is required. Configure an external supervisor and use remote enable --foreground, then remote run.',
    );
  return kind;
}
export function installConnectorSupervisor(home: string): void {
  // eslint-disable-next-line no-control-regex -- Reject control characters at the trust boundary.
  if (/[\r\n\u0000]/.test(home)) throw new Error('Invalid Puddle home');
  const kind = supervisorKind(home);
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
