import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consoleProcessList, guardConsoleListKill } from '../../src/pty/conpty-console-list.js';

/**
 * node-pty's ConPTY kill() ends the processes its helper lists; when the
 * helper fails, node-pty would end the root's pid 5 s later whatever holds
 * it by then. Stand-in helpers, so this runs on any OS.
 */
describe('consoleProcessList', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-console-list-'));
  const helper = (name: string, body: string) => {
    const file = join(dir, `${name}.cjs`);
    writeFileSync(file, body);
    return file;
  };

  it('answers with the helper’s list', async () => {
    const file = helper(
      'lists',
      'process.send({ consoleProcessList: [Number(process.argv[2]), 77, -1, "x"] }); process.exit(0);',
    );
    expect(await consoleProcessList(42, file)).toEqual([42, 77]);
  });

  it('answers with nothing, at once, when the helper cannot attach', async () => {
    const file = helper('fails', "throw new Error('AttachConsole failed');");
    const started = Date.now();
    expect(await consoleProcessList(42, file)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('answers with nothing for no helper or no pid', async () => {
    expect(await consoleProcessList(42, null)).toEqual([]);
    expect(await consoleProcessList(0, helper('unused', ''))).toEqual([]);
  });
});

describe('guardConsoleListKill', () => {
  it('replaces node-pty’s listing on a ConPTY, and leaves anything else alone', async () => {
    const agent = {
      _innerPid: 0,
      _getConsoleProcessList: () => Promise.resolve([12345]),
    };
    guardConsoleListKill({ _agent: agent });
    // No pid to list: nothing is ended, rather than the root's pid.
    expect(await agent._getConsoleProcessList()).toEqual([]);
    expect(() => guardConsoleListKill({})).not.toThrow();
    expect(() => guardConsoleListKill(null)).not.toThrow();
    const other = { _agent: { _getConsoleProcessList: 'not a function' } };
    guardConsoleListKill(other);
    expect(other._agent._getConsoleProcessList).toBe('not a function');
  });
});
