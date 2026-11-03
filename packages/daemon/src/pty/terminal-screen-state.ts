import { isStorageFull } from '../storage/errors.js';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from '@puddle/shared/node/platform';
import headless, {
  type ITerminalAddon as HeadlessTerminalAddon,
  type Terminal as HeadlessTerminal,
} from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { serialiseXtermMouseEncoding } from './xterm-mouse-encoding.js';
import { preserveXtermScrollUp } from './xterm-scrollback.js';

const { Terminal } = headless;

// These packages are exact-pinned as a pair: 0.14.0 and 6.0.0 were built
// from the same xterm commit. SerializeAddon uses the headless buffer API (and
// some xterm internals), so allowing independent semver drift would make this
// restoration boundary less stable than the public-looking package names imply.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const SCROLLBACK_LINES = 20_000;
const PERSIST_AFTER_IDLE_MS = 1_000;
const STATE_SUFFIX = '.terminal.json';

interface PersistedTerminalState {
  version: 1;
  cols: number;
  rows: number;
  data: string;
}

interface ScreenState {
  terminal: HeadlessTerminal;
  serialiser: SerializeAddon;
  cols: number;
  rows: number;
  hasContent: boolean;
  dirty: boolean;
  queue: Promise<void>;
  persistTimer: NodeJS.Timeout | null;
  generation: number;
}

/**
 * Canonical terminal emulators for daemon-owned PTYs.
 *
 * A raw suffix of PTY output is not a terminal snapshot: it may begin halfway
 * through a cursor-addressed redraw and can therefore restore as a blank page
 * or a few displaced fragments. This store parses the complete live stream in
 * a headless xterm and serialises a self-contained ANSI snapshot for attach.
 * Snapshots are also written beside the logs so daemon restarts do not discard
 * the last visible screen or its scrollback.
 */
export class TerminalScreenStateStore {
  private readonly states = new Map<string, ScreenState>();
  private tempSequence = 0;
  private closing = false;

  private retryAt = 0;
  private retryMs = 1000;
  constructor(
    private readonly stateDir?: string,
    private readonly onHealth?: (degraded: boolean) => void,
  ) {}

  write(stream: string, term: string, data: string): void {
    if (data === '') return;
    const state = this.ensure(stream, term);
    this.enqueue(state, async () => {
      await this.writeTerminal(state.terminal, data);
      state.hasContent = true;
      state.dirty = true;
      this.schedulePersist(stream, term, state);
    });
  }

  resize(stream: string, term: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const state = this.ensure(stream, term);
    this.enqueue(state, () => {
      if (state.cols === cols && state.rows === rows) return Promise.resolve();
      state.terminal.resize(cols, rows);
      state.cols = cols;
      state.rows = rows;
      state.dirty = true;
      this.schedulePersist(stream, term, state);
      return Promise.resolve();
    });
  }

  /** Returns null only when this terminal has never produced restorable data. */
  async snapshot(stream: string, term: string): Promise<string | null> {
    const state = this.ensure(stream, term);
    await state.queue;
    if (!state.hasContent) return null;
    return this.serialise(state);
  }

  /** Bounded plain text for notification previews, without changing terminal geometry. */
  async textTail(stream: string, term: string): Promise<string> {
    const state = this.states.get(this.key(stream, term));
    if (!state) return '';
    await state.queue;
    const buffer = state.terminal.buffer.active;
    const lines: string[] = [];
    // Reading the parsed screen avoids ANSI redraw fragments and OSC payloads.
    const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
    for (let row = Math.max(0, end - 32); row < end; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? '';
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n');
  }

  /** Persist and release an exited PTY's in-memory buffer. */
  async release(stream: string, term: string): Promise<void> {
    const key = this.key(stream, term);
    const state = this.states.get(key);
    if (!state) return;
    const generation = state.generation;
    await this.persist(stream, term, state);
    if (this.closing || this.states.get(key) !== state || state.generation !== generation) return;
    if (state.persistTimer) clearTimeout(state.persistTimer);
    state.terminal.dispose();
    this.states.delete(key);
  }

  /** Persist every live state before daemon shutdown. */
  async closeAll(): Promise<void> {
    this.closing = true;
    const entries = [...this.states.entries()];
    await Promise.all(
      entries.map(async ([key, state]) => {
        const [stream, term] = this.split(key);
        await this.persist(stream, term, state);
        if (state.persistTimer) clearTimeout(state.persistTimer);
        state.terminal.dispose();
      }),
    );
    this.states.clear();
  }

  /** Delete buffers for a stream that has been permanently removed. */
  async forget(stream: string): Promise<void> {
    const prefix = `${stream} `;
    for (const [key, state] of [...this.states]) {
      if (!key.startsWith(prefix)) continue;
      if (state.persistTimer) clearTimeout(state.persistTimer);
      await state.queue;
      state.terminal.dispose();
      this.states.delete(key);
    }
    if (!this.stateDir) return;
    const dir = join(this.stateDir, stream);
    try {
      const files = await readdir(dir);
      await Promise.all(
        files.filter((file) => file.endsWith(STATE_SUFFIX)).map((file) => unlink(join(dir, file))),
      );
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private ensure(stream: string, term: string): ScreenState {
    const key = this.key(stream, term);
    const existing = this.states.get(key);
    if (existing) {
      existing.generation++;
      return existing;
    }

    const terminal = new Terminal({
      // Narrow opt-in for the official serialiser's buffer access. Puddle does
      // not expose or consume proposed xterm APIs anywhere else.
      allowProposedApi: true,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK_LINES,
    });
    preserveXtermScrollUp(terminal);
    const serialiser = new SerializeAddon();
    // The serialiser is runtime-compatible with @xterm/headless, as documented
    // by xterm, but its published type names the browser Terminal class.
    terminal.loadAddon(serialiser as unknown as HeadlessTerminalAddon);
    const state: ScreenState = {
      terminal,
      serialiser,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      hasContent: false,
      dirty: false,
      queue: Promise.resolve(),
      persistTimer: null,
      generation: 0,
    };
    state.queue = this.load(stream, term, state);
    this.states.set(key, state);
    return state;
  }

  private async load(stream: string, term: string, state: ScreenState): Promise<void> {
    const file = this.file(stream, term);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!this.isPersistedState(parsed)) return;
      state.terminal.resize(parsed.cols, parsed.rows);
      state.cols = parsed.cols;
      state.rows = parsed.rows;
      if (parsed.data !== '') {
        await this.writeTerminal(state.terminal, parsed.data);
        state.hasContent = true;
      }
    } catch (error) {
      if (!this.isMissing(error)) console.warn(`Could not restore terminal state ${file}:`, error);
    }
  }

  private schedulePersist(stream: string, term: string, state: ScreenState): void {
    if (!this.stateDir || state.persistTimer) return;
    state.persistTimer = setTimeout(
      () => {
        state.persistTimer = null;
        void this.persist(stream, term, state).catch((error: unknown) => {
          console.warn(`Could not persist terminal state ${stream}/${term}:`, error);
        });
      },
      Math.max(PERSIST_AFTER_IDLE_MS, this.retryAt - Date.now()),
    );
    state.persistTimer.unref?.();
  }

  private async persist(stream: string, term: string, state: ScreenState): Promise<void> {
    if (state.persistTimer) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }
    const stateDir = this.stateDir;
    if (!stateDir) {
      await state.queue;
      return;
    }
    this.enqueue(state, async () => {
      if (!state.dirty) return;
      if (Date.now() < this.retryAt) {
        if (!this.closing) this.schedulePersist(stream, term, state);
        return;
      }
      const file = this.file(stream, term);
      if (!file) return;
      const persisted: PersistedTerminalState = {
        version: 1,
        cols: state.cols,
        rows: state.rows,
        data: this.serialise(state),
      };
      const temp = `${file}.tmp-${process.pid}-${this.tempSequence++}`;
      try {
        await mkdir(join(stateDir, stream), { recursive: true });
        await writeFile(temp, JSON.stringify(persisted), { encoding: 'utf8', mode: 0o600 });
        // Windows: a scanner or indexer briefly holding the old snapshot is not a failure.
        await renameWithRetry(temp, file);
        state.dirty = false;
        this.retryAt = 0;
        this.retryMs = 1000;
        this.onHealth?.(false);
      } catch (error) {
        this.onHealth?.(true);
        this.retryAt = Date.now() + this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        if (!this.closing) this.schedulePersist(stream, term, state);
        if (!isStorageFull(error)) console.warn('Could not save terminal snapshot:', error);
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
    await state.queue;
  }

  private enqueue(state: ScreenState, operation: () => Promise<void>): void {
    state.queue = state.queue.then(operation).catch((error: unknown) => {
      console.warn('Could not update canonical terminal state:', error);
    });
  }

  /** Attach and disk snapshots must restore the same terminal modes. */
  private serialise(state: ScreenState): string {
    return (
      state.serialiser.serialize({ scrollback: SCROLLBACK_LINES }) +
      serialiseXtermMouseEncoding(state.terminal)
    );
  }

  private writeTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
    return new Promise((resolve) => terminal.write(data, resolve));
  }

  private isPersistedState(value: unknown): value is PersistedTerminalState {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<PersistedTerminalState>;
    return (
      candidate.version === 1 &&
      typeof candidate.cols === 'number' &&
      candidate.cols > 0 &&
      typeof candidate.rows === 'number' &&
      candidate.rows > 0 &&
      typeof candidate.data === 'string'
    );
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  }

  private file(stream: string, term: string): string | null {
    return this.stateDir ? join(this.stateDir, stream, `${term}${STATE_SUFFIX}`) : null;
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }

  private split(key: string): [string, string] {
    const separator = key.indexOf(' ');
    return [key.slice(0, separator), key.slice(separator + 1)];
  }
}
