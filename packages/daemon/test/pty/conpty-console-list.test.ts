import { describe, expect, it } from 'vitest';
import { guardConsoleListKill, onRootExit } from '../../src/pty/conpty-console-list.js';

/** node-pty 1.1's Windows internals that PtyManager leans on, against stand-ins. */

describe('guardConsoleListKill', () => {
  it('makes node-pty’s kill list nothing to end by pid, and leaves anything else alone', async () => {
    const agent = {
      _innerPid: 4321,
      _getConsoleProcessList: () => Promise.resolve([4321, 12345]),
    };
    guardConsoleListKill({ _agent: agent });
    // The close alone ends what is attached; PtyManager ends what outstays it.
    expect(await agent._getConsoleProcessList()).toEqual([]);
    expect(() => guardConsoleListKill({})).not.toThrow();
    expect(() => guardConsoleListKill(null)).not.toThrow();
    const other = { _agent: { _getConsoleProcessList: 'not a function' } };
    guardConsoleListKill(other);
    expect(other._agent._getConsoleProcessList).toBe('not a function');
  });
});

describe('onRootExit', () => {
  it('reports the root’s exit from node-pty’s own callback, which still runs', () => {
    const calls: string[] = [];
    const agent = {
      _$onProcessExit(code: number) {
        calls.push(`node-pty ${code}`);
      },
    };
    expect(onRootExit({ _agent: agent }, (code) => calls.push(`ours ${code}`))).toBe(true);
    agent._$onProcessExit(3);
    expect(calls).toEqual(['ours 3', 'node-pty 3']);
  });

  it('keeps node-pty’s callback running when ours throws', () => {
    const calls: number[] = [];
    const agent = { _$onProcessExit: (code: number) => void calls.push(code) };
    onRootExit({ _agent: agent }, () => {
      throw new Error('ours');
    });
    expect(() => agent._$onProcessExit(1)).toThrow('ours');
    expect(calls).toEqual([1]);
  });

  it('says so on a node-pty without that callback', () => {
    expect(onRootExit({}, () => {})).toBe(false);
    expect(onRootExit(null, () => {})).toBe(false);
    expect(onRootExit({ _agent: { _$onProcessExit: 1 } }, () => {})).toBe(false);
  });
});
