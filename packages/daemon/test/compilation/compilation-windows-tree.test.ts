import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import {
  disposeCompilationCommands,
  runCompilationCommand,
} from '../../src/compilation/process.js';
import { onTeardown } from '../helpers/process-guard.js';
import {
  marked,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
} from '../helpers/process-trees.js';
import { sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

const host = fileURLToPath(new URL('../helpers/compile-host.mjs', import.meta.url));
const built = existsSync(
  fileURLToPath(new URL('../../dist/compilation/service.js', import.meta.url)),
);

/**
 * A compile command's stop on Windows (docs/windows.md, decision 8): the
 * tree the process table shows, by creation-time-consistent links, ends,
 * but never a GUI programme the command started, nor what that started.
 * Unlike a POSIX process group, a console process it started detached is
 * part of the tree and ends with it; a process whose parent has exited (an
 * orphan through `cmd /c start /b`, or PowerShell's Start-Process) is not
 * reached.
 */
describe.runIf(process.platform === 'win32')('a compile command’s stop on Windows', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  it('ends the command’s console tree, never a GUI programme or what one started', async () => {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    const run = runCompilationCommand({
      file: process.execPath,
      args: tree.args,
      cwd: tree.marker,
      timeoutMs: 120_000,
    }).catch((error: unknown) => error);
    const members = await sparedTreeMembers(tree.marker);
    const ending = members.filter((e) => ['agent', 'attached', 'detached'].includes(role(e)));
    const spared = members.filter((e) => ['gui', 'gui-child', 'start-process'].includes(role(e)));
    expect(spared.map(role).sort()).toEqual(['gui', 'gui-child', 'gui-child', 'start-process']);
    // As when the daemon shuts down; what is to end has ended once it resolves.
    await disposeCompilationCommands();
    expect(await survivors(ending, 0)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
    // A GUI programme may hold the command's output open: it settles once the survivors end.
    await stopMarked(tree.marker);
    expect(String(await run)).toMatch(/exited with/);
  });
});

/**
 * A daemon may exit as soon as its compilation service has been disposed
 * of. libuv's kill-on-close job then ends the command, but not what the
 * command started (cmd.exe holds its children in no job of its own), so
 * dispose resolves only once the command's tree has been stopped, which on
 * Windows first reads the process table. The built service, in a host
 * process (`pnpm build` first).
 */
describe.runIf(process.platform === 'win32' && built)('a compile command as its host exits', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  it('has ended the command’s grandchild once the service’s dispose resolves', async () => {
    const marker = mkdtempSync(join(tmpdir(), 'puddle-compile-host-'));
    markers.push(marker);
    // A build script whose cmd.exe waits for a console grandchild.
    const script = join(marker, 'build.cmd');
    const keep = 'setInterval(()=>{},1e9)';
    writeFileSync(script, `@"${process.execPath}" -e "${keep}" "${marker}:grandchild"\r\n`);
    const child = spawn(process.execPath, [host, script, marker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).once('line', () => resolve());
      void exited.then(() => reject(new Error(`the host exited: ${stderr}`)));
    });
    let grandchild: WindowsProcess | undefined;
    await waitUntil(
      async () =>
        (grandchild = (await marked(marker)).find(
          (entry) => entry.name.toLowerCase() === 'node.exe' && role(entry) === 'grandchild',
        )) !== undefined,
      30_000,
      'the grandchild',
    );
    child.stdin.write('dispose\n');
    expect(await exited).toBe(0);
    expect(await survivors([grandchild!])).toEqual([]);
  });
});
