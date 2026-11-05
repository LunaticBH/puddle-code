import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeCompilationCommands,
  runCompilationCommand,
} from '../../src/compilation/process.js';
import { role, stillRunning, stopMarked, survivors } from '../helpers/process-trees.js';
import { sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

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
    // As when the daemon shuts down: SIGTERM, then SIGKILL a second later.
    disposeCompilationCommands();
    expect(await survivors(ending, 10_000)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
    // A GUI programme may hold the command's output open: it settles once the survivors end.
    await stopMarked(tree.marker);
    expect(String(await run)).toMatch(/exited with/);
  });
});
