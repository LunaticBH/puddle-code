import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { TerminalScreenStateStore } from '../../src/pty/terminal-screen-state.js';

const { Terminal } = headless;

/** Exercise xterm's actual encoder without a DOM; browser gestures have separate coverage. */
interface MouseTerminal {
  _core: {
    coreMouseService: {
      triggerMouseEvent(event: {
        col: number;
        row: number;
        x: number;
        y: number;
        button: number;
        action: number;
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
      }): boolean;
    };
  };
}

async function mouseReports(snapshot: string | null, after = '') {
  expect(snapshot).not.toBeNull();
  const terminal = new Terminal({ allowProposedApi: true, cols: 100, rows: 30 });
  try {
    await new Promise<void>((resolve) => terminal.write(`${snapshot}${after}`, resolve));
    const reports: string[] = [];
    terminal.onData((data) => reports.push(data));
    const mouse = (terminal as unknown as MouseTerminal)._core.coreMouseService;
    // Wheel up/down, left press, drag and release (xterm 6.0.0 mouse constants).
    for (const [button, action] of [
      [4, 0],
      [4, 1],
      [0, 1],
      [0, 32],
      [0, 0],
    ]) {
      mouse.triggerMouseEvent({
        col: 10,
        row: 5,
        x: 100,
        y: 96,
        button: button!,
        action: action!,
        ctrl: false,
        alt: false,
        shift: false,
      });
    }
    return {
      reports,
      tracking: terminal.modes.mouseTrackingMode,
      buffer: terminal.buffer.active.type,
    };
  } finally {
    terminal.dispose();
  }
}

function expectedReports(coordinates: string): string[] {
  return [64, 65, 0, 32]
    .map((code) => `\x1b[<${code};${coordinates}M`)
    .concat(`\x1b[<0;${coordinates}m`);
}

describe('terminal mouse snapshots', () => {
  for (const [mode, coordinates] of [
    [1006, '11;6'],
    [1016, '100;96'],
  ] as const) {
    it.each(['normal', 'alternate'] as const)(
      `preserves mode ${mode} in the %s buffer`,
      async (buffer) => {
        const store = new TerminalScreenStateStore();
        try {
          store.resize('session', 'agent', 100, 30);
          store.write('session', 'agent', buffer === 'alternate' ? '\x1b[?1049h' : '');
          // Deliberately split a combined mode sequence at a PTY chunk boundary.
          store.write('session', 'agent', '\x1b[?1003;');
          store.write('session', 'agent', `${mode}htranscript`);
          for (let attach = 0; attach < 2; attach++) {
            expect(await mouseReports(await store.snapshot('session', 'agent'))).toEqual({
              reports: expectedReports(coordinates),
              tracking: 'any',
              buffer,
            });
          }
        } finally {
          await store.closeAll();
        }
      },
    );

    it(`preserves mode ${mode} through persistence, release and resize`, async () => {
      const stateDir = await mkdtemp(join(tmpdir(), 'puddle-mouse-state-'));
      let store = new TerminalScreenStateStore(stateDir);
      try {
        store.write('session', 'agent', `\x1b[?1049h\x1b[?1002h\x1b[?${mode}htranscript`);
        await store.release('session', 'agent');
        expect((await mouseReports(await store.snapshot('session', 'agent'))).reports).toEqual(
          expectedReports(coordinates),
        );
        await store.closeAll();
        store = new TerminalScreenStateStore(stateDir);
        store.resize('session', 'agent', 100, 30);
        expect(await mouseReports(await store.snapshot('session', 'agent'))).toEqual({
          reports: expectedReports(coordinates),
          tracking: 'drag',
          buffer: 'alternate',
        });
      } finally {
        await store.closeAll();
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }

  it('keeps dormant encoding while tracking is off and respects later encoding resets', async () => {
    const store = new TerminalScreenStateStore();
    try {
      store.write('session', 'agent', '\x1b[?1002h\x1b[?1006h\x1b[?1002ltext');
      const snapshot = await store.snapshot('session', 'agent');
      expect((await mouseReports(snapshot)).tracking).toBe('none');
      expect((await mouseReports(snapshot, '\x1b[?1002h')).reports).toEqual(
        expectedReports('11;6'),
      );

      store.write('session', 'agent', '\x1b[?1002h\x1b[?1006l');
      expect((await mouseReports(await store.snapshot('session', 'agent'))).reports).toEqual([]);
      store.write('session', 'agent', '\x1b[?1016h\x1b[?1006h');
      expect((await mouseReports(await store.snapshot('session', 'agent'))).reports).toEqual(
        expectedReports('11;6'),
      );
      store.write('session', 'agent', '\x1bc');
      expect(await mouseReports(await store.snapshot('session', 'agent'), '\x1b[?1002h')).toEqual({
        reports: [],
        tracking: 'drag',
        buffer: 'normal',
      });
    } finally {
      await store.closeAll();
    }
  });
});
