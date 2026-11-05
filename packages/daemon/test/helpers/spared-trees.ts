import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { attachedGuiProgram, guiProgram, marked, role, waitUntil } from './process-trees.js';

/**
 * Process trees for the Windows stops outside a PTY (docs/windows.md,
 * decision 8): the Codex app-server, compile commands and notebook kernels.
 * Each test stops the survivors it makes (stopMarked).
 *
 * `node agent.mjs <marker> <gui.exe> <gui-attach.exe>` starts, and keeps
 * running, processes attached to its console: a grandchild through a
 * `cmd /c` that waits for it (`attached`), and an orphan through `cmd /c
 * start /b`, which exits at once (`orphan-attached`); a detached child
 * (`detached`); a GUI programme through a `cmd /c` that waits for it
 * (`gui`); a GUI programme that attaches to the console and starts a console
 * child there, through a `cmd /c` that waits for it (`gui-child`, both); and
 * one in a console of its own through PowerShell's Start-Process
 * (`start-process`). It writes nothing. Only it and those processes name the
 * marker on their command lines.
 */
const AGENT = String.raw`
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const [marker, gui, attachGui] = process.argv.slice(2);
const node = process.execPath;
const keep = 'setInterval(()=>{},1e9)';
const env = { ...process.env, M: marker, PUDDLE_TREE_MARKER: marker };
const cmd = (line) =>
  spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d /c ' + line], {
    stdio: 'ignore', windowsVerbatimArguments: true, env,
  });
// (cmd strips the outer quotes of a line that starts with one.)
cmd('""' + node + '" -e "' + keep + '" "%M%:attached""');
cmd('start "" /b "' + node + '" -e "' + keep + '" "%M%:orphan-attached"');
spawn(node, ['-e', keep, marker + ':detached'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
cmd('""' + gui + '" 120 "%M%:gui""');
cmd('""' + attachGui + '" 120 "' + node + '" -e "' + keep + '" "%M%:gui-child""');
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Windows PowerShell's -ArgumentList joins its arguments unquoted: no spaces.
const start = "Start-Process -WindowStyle Hidden '" + node + "' -ArgumentList '-e','" + keep + "',($env:PUDDLE_TREE_MARKER + ':start-process')";
spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', start], { stdio: 'ignore', windowsHide: true, env });
setInterval(() => {}, 1e9);
`;

/** What the agent starts: every role but its own (`agent`), `gui-child` twice. */
const STARTED = [
  'attached',
  'orphan-attached',
  'detached',
  'gui',
  'gui-child',
  'gui-child',
  'start-process',
];

export interface SparedTree {
  /** The directory every process of the tree names. */
  marker: string;
  /** `agent.mjs` and its arguments, for node. */
  args: string[];
}

export async function writeSparedTree(): Promise<SparedTree> {
  const marker = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
  const script = join(marker, 'agent.mjs');
  writeFileSync(script, AGENT);
  return { marker, args: [script, marker, await guiProgram(), await attachedGuiProgram()] };
}

/**
 * The tree's processes once all of them run and the intermediates that exit
 * have: `agents` processes running agent.mjs (a launcher counts), then
 * everything they start.
 */
export async function sparedTreeMembers(marker: string, agents = 1): Promise<WindowsProcess[]> {
  let members: WindowsProcess[] = [];
  await waitUntil(
    async () => {
      members = (await marked(marker)).filter((entry) =>
        ['node.exe', 'gui.exe', 'gui-attach.exe'].includes(entry.name.toLowerCase()),
      );
      const roles = members.map(role).sort();
      return (
        JSON.stringify(roles) ===
        JSON.stringify([...STARTED, ...Array<string>(agents).fill('agent')].sort())
      );
    },
    30_000,
    'the whole tree',
  );
  return members;
}

const programs = new Map<string, Promise<string>>();

/**
 * Compiles `source` as a console programme `<name>.exe` with the .NET
 * Framework 4 C# compiler every supported Windows ships, once per process.
 */
export function consoleProgram(name: string, source: string): Promise<string> {
  let exe = programs.get(name);
  if (!exe) {
    exe = (async () => {
      const windir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const compiler = ['Framework64', 'FrameworkArm64', 'Framework']
        .map((framework) => join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
        .find((candidate) => existsSync(candidate));
      if (compiler === undefined) throw new Error('no .NET Framework C# compiler');
      const dir = mkdtempSync(join(tmpdir(), 'puddle-console-'));
      const file = join(dir, `${name}.cs`);
      const out = join(dir, `${name}.exe`);
      writeFileSync(file, source);
      await promisify(execFile)(
        compiler,
        ['/nologo', '/target:exe', '/platform:anycpu', `/out:${out}`, file],
        { windowsHide: true },
      );
      return out;
    })();
    programs.set(name, exe);
  }
  return exe;
}
