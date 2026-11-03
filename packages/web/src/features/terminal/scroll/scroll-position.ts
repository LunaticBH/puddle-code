import { browserScope } from '../../../lib/transport/browser-transport';
export interface TerminalScrollPosition {
  /** Absolute buffer line shown at the top of the viewport. */
  viewportY: number;
  /** Follow newly appended output instead of pinning an old buffer line. */
  atBottom: boolean;
}

export interface TerminalScrollAnchor extends TerminalScrollPosition {
  /** First buffer row of the logical (possibly wrapped) viewport line. */
  logicalLineY: number;
  /** Cell offset of the old viewport row within that logical line. */
  cellOffset: number;
  /** Fallback location when an application replaces the entire scrollback. */
  scrollProgress: number;
}

interface TerminalScrollMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

interface TerminalScrollBuffer {
  readonly type: 'normal' | 'alternate';
  readonly viewportY: number;
  readonly baseY: number;
  readonly cursorY: number;
  getLine(line: number): { readonly isWrapped: boolean } | undefined;
}

interface TerminalScrollTarget {
  readonly cols: number;
  readonly buffer: { readonly active: TerminalScrollBuffer };
  registerMarker(cursorYOffset: number): TerminalScrollMarker;
  scrollToLine(line: number): void;
}

export type TerminalScrollRestore = 'tracked' | 'replaced';

/** Await a delayed application redraw after sending SIGWINCH. */
const RESIZE_REDRAW_WAIT_MS = 1_000;
/** Release a replaced-buffer guard once replayed output has gone quiet. */
const RESIZE_REDRAW_QUIET_MS = 250;

function keyFor(stream: string, term: string): string {
  return browserScope(JSON.stringify([stream, term]));
}

function bufferLine(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function terminalColumns(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function scrollProgress(viewportY: number, baseY: number): number {
  if (baseY === 0) return 1;
  return Math.max(0, Math.min(1, viewportY / baseY));
}

/** Capture a terminal viewport without trusting out-of-range buffer values. */
export function terminalScrollPosition(viewportY: number, baseY: number): TerminalScrollPosition {
  const safeBase = bufferLine(baseY);
  const safeViewport = Math.min(safeBase, bufferLine(viewportY));
  return { viewportY: safeViewport, atBottom: safeViewport >= safeBase };
}

/** Resolve a saved viewport against the scrollback that is available now. */
export function terminalScrollLine(position: TerminalScrollPosition, baseY: number): number {
  const safeBase = bufferLine(baseY);
  return position.atBottom ? safeBase : Math.min(position.viewportY, safeBase);
}

/**
 * Capture the logical line at the top of a viewport before xterm reflows it.
 * Raw buffer indexes are not stable across a column change: every wrapped line
 * above the viewport can gain or lose rows.
 */
export function terminalScrollAnchor(
  viewportY: number,
  baseY: number,
  cols: number,
  isWrapped: (line: number) => boolean,
): TerminalScrollAnchor {
  const position = terminalScrollPosition(viewportY, baseY);
  let logicalLineY = position.viewportY;
  // Bottom-following terminals need no marker and may end inside an extremely
  // long wrapped output line, so avoid a pointless backwards scan for them.
  if (!position.atBottom) {
    while (logicalLineY > 0 && isWrapped(logicalLineY)) logicalLineY--;
  }
  return {
    ...position,
    logicalLineY,
    cellOffset: (position.viewportY - logicalLineY) * terminalColumns(cols),
    scrollProgress: scrollProgress(position.viewportY, bufferLine(baseY)),
  };
}

/** Resolve a tracked logical-line marker after xterm has reflowed the buffer. */
export function terminalReflowScrollLine(
  anchor: TerminalScrollAnchor,
  trackedLogicalLine: number | undefined,
  cols: number,
  baseY: number,
): number {
  const safeBase = bufferLine(baseY);
  if (anchor.atBottom) return safeBase;
  if (trackedLogicalLine === undefined || trackedLogicalLine < 0) {
    // A full-screen application may deliberately purge scrollback and replay
    // its transcript after SIGWINCH. The marker is then gone and old absolute
    // row indexes have no meaning; proportional progress keeps the same part
    // of the rebuilt transcript in view regardless of its new wrapping.
    return Math.round(anchor.scrollProgress * safeBase);
  }
  const reflowedLine =
    bufferLine(trackedLogicalLine) + Math.floor(anchor.cellOffset / terminalColumns(cols));
  return Math.min(reflowedLine, safeBase);
}

/**
 * One resize transaction for a deliberately scrolled normal buffer.
 *
 * The marker follows ordinary xterm reflow exactly. It deliberately outlives
 * the local fit because terminal applications can redraw asynchronously after
 * SIGWINCH. If an application purges and rebuilds scrollback, xterm disposes
 * the marker and the guard falls back to the captured transcript progress.
 */
export class TerminalResizeScrollGuard {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private managedScrolls = 0;
  private state:
    | {
        anchor: TerminalScrollAnchor;
        marker: TerminalScrollMarker;
        buffer: TerminalScrollBuffer['type'];
      }
    | undefined;

  capture(terminal: TerminalScrollTarget): boolean {
    if (this.state) {
      this.arm(RESIZE_REDRAW_WAIT_MS);
      return true;
    }
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal') return false;
    const anchor = terminalScrollAnchor(
      buffer.viewportY,
      buffer.baseY,
      terminal.cols,
      (line) => buffer.getLine(line)?.isWrapped === true,
    );
    if (anchor.atBottom) return false;
    const cursorLine = buffer.baseY + buffer.cursorY;
    this.state = {
      anchor,
      marker: terminal.registerMarker(anchor.logicalLineY - cursorLine),
      buffer: buffer.type,
    };
    this.arm(RESIZE_REDRAW_WAIT_MS);
    return true;
  }

  restore(terminal: TerminalScrollTarget): TerminalScrollRestore | null {
    const state = this.state;
    const buffer = terminal.buffer.active;
    if (!state || buffer.type !== state.buffer) return null;
    const trackedLine = state.marker.isDisposed ? undefined : state.marker.line;
    terminal.scrollToLine(
      terminalReflowScrollLine(state.anchor, trackedLine, terminal.cols, buffer.baseY),
    );
    if (trackedLine === undefined) {
      this.arm(RESIZE_REDRAW_QUIET_MS);
      return 'replaced';
    }
    return 'tracked';
  }

  beginManagedScroll(): void {
    this.managedScrolls++;
  }

  endManagedScroll(): void {
    this.managedScrolls = Math.max(0, this.managedScrolls - 1);
  }

  get managingScroll(): boolean {
    return this.managedScrolls > 0;
  }

  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.managedScrolls = 0;
    this.state?.marker.dispose();
    this.state = undefined;
  }

  private arm(delayMs: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), delayMs);
  }
}

/**
 * Browser-window terminal viewport state. Terminals normally remain mounted in
 * the keep-alive host, but this also survives a workspace route remount. It is
 * deliberately client-local and bounded: scroll position is view state, not a
 * daemon/protocol concern, and closed sessions must not leak entries forever.
 */
export class TerminalScrollStore {
  private readonly positions = new Map<string, TerminalScrollPosition>();

  constructor(private readonly maxEntries = 500) {}

  set(stream: string, term: string, viewportY: number, baseY: number): TerminalScrollPosition {
    const key = keyFor(stream, term);
    const position = terminalScrollPosition(viewportY, baseY);
    // Refresh insertion order so active terminals are the last to be evicted.
    this.positions.delete(key);
    this.positions.set(key, position);
    while (this.positions.size > this.maxEntries) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
    return position;
  }

  get(stream: string, term: string): TerminalScrollPosition | undefined {
    return this.positions.get(keyFor(stream, term));
  }
}

export const terminalScrollStore = new TerminalScrollStore();
