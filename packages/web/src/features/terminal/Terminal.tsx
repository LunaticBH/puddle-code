import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { HOME_STREAM, type SessionStatus } from '@puddle/shared';
import { useClientSettings } from '../../lib/settings/client-settings';
import {
  actionForBinding,
  eventBinding,
  getHotkeyAction,
  getHotkeyHandler,
} from '../../lib/navigation/hotkeys';
import { daemonAnswersColourQueries } from '../../lib/transport/protocol-support';
import { useDaemonVersion, useHostPathStyle, useProfileSettings } from '../../lib/queries/queries';
import { useCurrentProfileId } from '../profile/profile-store';
import { FindWidget } from '../find/FindWidget';
import { isValidFindPattern } from '../find/find-matches';
import { isFindShortcut } from '../find/find-shortcut';
import { EMPTY_FIND_RESULT, type FindOptions } from '../find/find-types';
import { useFindControls } from '../find/use-find-controls';
import { useDocumentVisible } from '../../lib/hooks/use-document-visible';
import { sshMode } from '../../lib/transport/ssh-mode';
import {
  cssTokenReader,
  onThemeChange,
  xtermThemeFromCss,
  xtermVisualOptionsFromCss,
} from '../../lib/appearance/theme';
import { cn } from '../../lib/utils';
import { wsManager } from '../../lib/transport/ws';
import { registerDynamicColourQueries } from './osc-colour';
import { terminalClipboard, writeTerminalClipboard } from './clipboard/clipboard';
import { terminalSelectionText } from './clipboard/copy-text';
import { registerUrlLinks } from './links/url-links';
import { interceptImagePaste } from './clipboard/paste-image';
import { macLineEditSequence } from './input/line-edit-shortcut';
import { rewriteTerminalUri } from './links/proxy-links';
import { openBrowserLink } from '../ports/forward-link';
import { toastError } from '../../lib/transport/errors';
import {
  TerminalResizeScrollGuard,
  terminalScrollLine,
  terminalScrollStore,
  type TerminalScrollPosition,
} from './scroll/scroll-position';
import { registerFileLinks, type FileLinkTarget } from './links/file-links';
import { windowsPtyOptions } from './windows-pty';
import {
  consumeTerminalModifiers,
  pasteTerminalClipboard,
  registerTerminalInput,
} from './input/input';
import { preserveXtermScrollUp } from './scroll/xterm-scrollback';
import { attachTerminalTouchScroll } from './scroll/touch-scroll';
import { attachIosTerminalInput } from './input/ios-input';
import { SelectionActions } from '../../components/selection-actions';
import { TerminalRichOutput } from './rich-output/TerminalRichOutput';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The terminal typeface, and a gate on its webfont being LOADED: xterm
 * measures its cell metrics once, when the terminal opens, so a terminal
 * created while 'Ubuntu Sans Mono' was still downloading measured — and kept —
 * the fallback mono: wrong face, wrong cell geometry, until some later
 * renderer swap happened to rebuild the glyph atlas (the "reload sometimes
 * paints terminals in another font" bug, fixed 2026-08-06). The face loads
 * once per page, so the gate costs at most a frame or two on the first
 * terminal after a cold reload and nothing after; the attach replay repaints
 * the buffer, so nothing is lost by waiting.
 */
const TERMINAL_FONT = "'Ubuntu Sans Mono', ui-monospace, monospace";
const FONT_PROBE = "12px 'Ubuntu Sans Mono'"; // loads the FACE — size is irrelevant
let terminalFontReady =
  typeof document === 'undefined' || !('fonts' in document) || document.fonts.check(FONT_PROBE);
const terminalFontLoad: Promise<void> | null = terminalFontReady
  ? null
  : document.fonts
      .load(FONT_PROBE)
      .catch(() => undefined) // a face that cannot load must not block terminals
      .then(() => {
        terminalFontReady = true;
      });

function useTerminalFontReady(): boolean {
  const [ready, setReady] = useState(terminalFontReady);
  useEffect(() => {
    if (ready || terminalFontLoad === null) return;
    let live = true;
    void terminalFontLoad.then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/** Statuses in which a process is attached to the PTY (see the restart refit). */
const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

/** Search decorations derive from the live theme, like xterm itself. */
function terminalFindOptions(options: FindOptions): ISearchOptions {
  const read = cssTokenReader();
  return {
    ...options,
    decorations: {
      matchBackground: read('--bg-surface'),
      matchBorder: read('--text-muted'),
      matchOverviewRuler: read('--text-muted'),
      activeMatchBackground: read('--bg-elevated'),
      activeMatchBorder: read('--accent'),
      activeMatchColorOverviewRuler: read('--accent'),
    },
  };
}

export interface TerminalProps {
  /** PTY stream: a session uuid, `login-<accountId>`, or `home` (HOME_STREAM). */
  stream: string;
  term?: string;
  className?: string;
  onExit?: (code: number) => void;
  /** Cmd/Ctrl+click on a validated path opens it — a file in the editor, a directory in the file tree (SPEC §7). */
  onOpenFile?: (target: FileLinkTarget) => void;
  /**
   * True while this terminal's DOM is parked out of sight (a background tab in
   * the tiling layout). A paused terminal detaches its PTY viewer — no output
   * arrives, nothing is parsed — and re-attaches on unpause, where the daemon's
   * replay repaints it. The PTY and its agent run on regardless; viewers are
   * ephemeral by design (SPEC §6).
   */
  paused?: boolean;
}

/**
 * Deferred false: flips to true immediately, but holds a true value for
 * `delayMs` after the input goes false. Rapid tab switches therefore keep the
 * PTY attachment (no replay churn); only a settled pause detaches.
 */
function useLingeringTrue(value: boolean, delayMs: number): boolean {
  const [lingering, setLingering] = useState(value);
  useEffect(() => {
    if (value) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return lingering;
}

const DETACH_LINGER_MS = 1_500;

/**
 * One xterm bound to one daemon PTY via the WS manager. The attach replay
 * repaints prior scrollback; the theme regenerates from the CSS variables on
 * every theme switch so terminal and chrome never drift apart (SPEC §12).
 */
export function Terminal({
  stream,
  term = 'agent',
  className,
  onExit,
  onOpenFile,
  paused = false,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const [richTerminal, setRichTerminal] = useState<XTerm | null>(null);
  const clipboardRef = useRef<ReturnType<typeof terminalClipboard> | null>(null);
  // An empty held cell still offers Paste; null means the touch menu is closed.
  const [touchSelection, setTouchSelection] = useState<string | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const resizeScrollGuardRef = useRef(new TerminalResizeScrollGuard());
  // True while the buffer is replaying history: OSC side effects (clipboard
  // writes, colour-query replies) must not re-fire for bytes the agent emitted
  // in the past — a stale clipboard overwrite, or a stale reply written into a
  // working agent's stdin.
  const replayingRef = useRef(false);
  // Initial fitting sees an empty buffer. Only a completed snapshot can
  // replace this PTY's saved viewport from an earlier workspace mount.
  const hasReplayRef = useRef(false);
  const settings = useClientSettings();
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  // Also pause when the whole document is hidden: a backgrounded browser tab
  // otherwise keeps receiving and parsing every byte of PTY output.
  const visible = useDocumentVisible();
  const activeRef = useRef(!paused && visible);
  activeRef.current = !paused && visible;
  const attached = useLingeringTrue(!paused && visible, DETACH_LINGER_MS);
  // Both the mount and attach effects key on this: xterm must not exist —
  // let alone measure glyphs — before the webfont it measures is loaded.
  const fontReady = useTerminalFontReady();
  // ≥14.1 the DAEMON answers OSC 10/11 colour queries (it sees the query at
  // agent spawn, before any viewer attaches — see protocol-support); this
  // viewer must then stay silent or the agent gets two replies. Optimistic
  // while the version query is in flight, like every gate.
  const daemonAnswersColours = daemonAnswersColourQueries(useDaemonVersion().data?.protocol);
  // Whether app shortcuts win over the terminal — a PROFILE setting living
  // with the hotkeys it governs (Settings → Hotkeys), default on. A ref so the
  // live xterm's key handler reads the current choice; absent/loading reads
  // as the default.
  const profileId = useCurrentProfileId();
  const appShortcuts =
    useProfileSettings(profileId ?? undefined).data?.terminalAppShortcuts !== false;
  const appShortcutsRef = useRef(appShortcuts);
  appShortcutsRef.current = appShortcuts;
  // The HOST's path style (POSIX until `/api/host` answers): it picks the
  // file-link patterns and xterm's ConPTY mode. A ref, so the live terminal
  // follows a host-info answer that lands after it mounted.
  const hostStyle = useHostPathStyle();
  const hostStyleRef = useRef(hostStyle);
  hostStyleRef.current = hostStyle;
  const find = useFindControls({
    // A terminal owns its key event before it bubbles to the window; the
    // custom xterm handler below opens this same control.
    shortcutEnabled: false,
    onFind: (query, options, direction) => {
      const search = searchRef.current;
      const xterm = xtermRef.current;
      if (!search || !xterm) return EMPTY_FIND_RESULT;
      if (query.length === 0) {
        search.clearDecorations();
        xterm.clearSelection();
        return EMPTY_FIND_RESULT;
      }
      if (!isValidFindPattern(query, options)) {
        search.clearDecorations();
        xterm.clearSelection();
        return { index: -1, count: 0, invalid: true };
      }
      const searchOptions = terminalFindOptions(options);
      if (direction === 'previous') search.findPrevious(query, searchOptions);
      else search.findNext(query, { ...searchOptions, incremental: direction === 'reset' });
    },
    onClear: () => {
      searchRef.current?.clearDecorations();
      xtermRef.current?.clearSelection();
    },
    onCloseFocus: () => xtermRef.current?.focus(),
  });

  const restoreResizeScroll = useCallback(
    (xterm: XTerm) => {
      if (!hasReplayRef.current || replayingRef.current) return;
      resizeScrollGuardRef.current.restore(xterm);
      const buffer = xterm.buffer.active;
      if (buffer.type === 'normal') {
        terminalScrollStore.set(stream, term, buffer.viewportY, buffer.baseY);
      }
    },
    [stream, term],
  );

  /**
   * Re-measure the grid against the container and repaint it without moving a
   * deliberately scrolled viewport. This is the shared local half of every fit
   * path, including reattachment before a PTY viewer exists. A container with
   * no size yet is left alone (a parked pane keeps its last size rather than
   * collapsing to 1×1).
   */
  const fitPreservingScroll = useCallback(() => {
    const xterm = xtermRef.current;
    const container = containerRef.current;
    if (!xterm || !container || container.clientWidth === 0 || container.clientHeight === 0)
      return null;
    const guard = resizeScrollGuardRef.current;
    guard.capture(xterm);
    guard.beginManagedScroll();
    try {
      fitRef.current?.fit();
      // Repaint every row after a geometry change: the renderer surface clears
      // on resize but only rows it considers dirty repaint, which could blank
      // the static part of a TUI until a selection forced a full pass (fixed
      // 2026-07-31). A same-size fit is already a no-op inside xterm; the old
      // extra same-size resize call was another no-op and is intentionally gone.
      xterm.refresh(0, xterm.rows - 1);
      restoreResizeScroll(xterm);
    } finally {
      guard.endManagedScroll();
    }
    return xterm;
  }, [restoreResizeScroll]);

  /** Complete a local fit by telling the shared PTY which grid now owns it. */
  const refit = useCallback(() => {
    if (!activeRef.current) return;
    const xterm = fitPreservingScroll();
    if (!xterm) return;
    wsManager.resize(stream, term, xterm.cols, xterm.rows);
  }, [fitPreservingScroll, stream, term]);

  // Repaint after the browser brings this document back to the foreground.
  // The pause linger normally detaches a hidden viewer and the later replay
  // rebuilds it, but background tabs throttle (and sleeping machines freeze)
  // the linger timer. In that case `attached` can stay true throughout, while
  // the browser discards part of the renderer's backing store. xterm's buffer
  // is still intact — selecting the blank area
  // makes its text reappear — so force the same full recovery on every visible
  // edge. Waiting one animation frame lets the compositor restore the canvas
  // before xterm marks every row dirty. This is deliberately refresh-only:
  // resizing can clear the canvas and is already owned by ResizeObserver, so
  // the recovery adds no blank intermediate frame.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const xterm = xtermRef.current;
      if (xterm) xterm.refresh(0, xterm.rows - 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !fontReady) return;

    // URL links are safe everywhere (login terminals included): plain click or
    // cmd/ctrl+click both open the URL in a new tab (SPEC §7). In SSH mode a
    // host-localhost URL is rewritten to the tier-2 proxy path so it works
    // from the client; login and home terminals have no session to proxy through.
    const sessionless = stream.startsWith('login-') || stream === HOME_STREAM;
    const openUri = (uri: string) => {
      const target = sessionless ? uri : rewriteTerminalUri(uri, stream, sshMode() !== null);
      void openBrowserLink(target).catch(toastError);
    };

    const xterm = new XTerm({
      // SearchAddon renders all-match decorations through xterm's proposed
      // decoration API (xterm 6.0.0 / addon-search 0.16.0). Without this
      // constructor opt-in, the first non-empty search throws and takes down
      // the routed workspace through the render error boundary.
      allowProposedApi: true,
      // Includes the token-derived theme and xterm's WCAG-AA foreground
      // correction. Some TUIs choose their own background from a one-shot
      // terminal-colour probe; after a Puddle theme change that cached choice
      // can be the opposite luminance, so the renderer must keep its text
      // readable without rewriting the agent's terminal stream.
      ...xtermVisualOptionsFromCss(),
      fontFamily: TERMINAL_FONT,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      cursorBlink: true,
      // A TUI that enables mouse reporting (Claude Code does, for wheel
      // scrolling) receives mouse drags itself — xterm then makes no local
      // selection, so ⌘C has nothing to copy even though a plain shell copies
      // fine. Shift+drag forces a local selection elsewhere; on Mac this
      // enables ⌥+drag, matching Terminal.app/iTerm convention.
      macOptionClickForcesSelection: IS_MAC,
      // OSC 8 hyperlinks (how Claude Code prints its URLs, e.g. the login
      // OAuth link). Without a handler xterm falls back to a native confirm()
      // ("This link could potentially be dangerous") and then opens a BLANK
      // window before assigning its location — which the desktop shell's
      // window-open handler denies (about:blank is not https?:), so accepting
      // the dialogue opened nothing (fixed 2026-08-05). Route them through the
      // same open path as the URL provider below: no dialogue, real URL.
      linkHandler: { activate: (_event, uri) => openUri(uri) },
      ...windowsPtyOptions(hostStyleRef.current),
    });
    preserveXtermScrollUp(xterm);
    hasReplayRef.current = false;
    replayingRef.current = false;
    xtermRef.current = xterm;
    const fit = new FitAddon();
    const search = new SearchAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(search);
    const urlLinks = registerUrlLinks(xterm, openUri);
    xterm.open(container);
    setRichTerminal(xterm);
    fit.fit();
    fitRef.current = fit;
    searchRef.current = search;
    const searchResults = search.onDidChangeResults((result) => {
      find.setResult({ index: result.resultIndex, count: result.resultCount });
    });
    const viewportScroll = xterm.onScroll((viewportY) => {
      if (!hasReplayRef.current || replayingRef.current) return;
      // A scroll outside a fit/write is a user gesture. It supersedes any
      // pre-resize position before the delayed application redraw arrives.
      if (!resizeScrollGuardRef.current.managingScroll) resizeScrollGuardRef.current.release();
      const buffer = xterm.buffer.active;
      // Alternate-screen applications own their viewport. Do not let opening
      // an overlay replace the normal transcript's saved scroll position.
      if (buffer.type === 'normal') {
        terminalScrollStore.set(stream, term, viewportY, buffer.baseY);
      }
    });

    // Validated file-path links: only for real sessions (login/home PTYs have
    // no worktree to resolve against) and only when a handler is wired.
    const fileLinks =
      onOpenFileRef.current && !sessionless
        ? registerFileLinks(
            xterm,
            stream,
            (target) => onOpenFileRef.current?.(target),
            () => hostStyleRef.current,
          )
        : null;

    const clipboard = terminalClipboard({
      isMac: IS_MAC,
      selection: () => terminalSelectionText(xterm),
      mouseTracking: () => xterm.modes.mouseTrackingMode !== 'none',
      available: () => activeRef.current && wsManager.isConnected() && !replayingRef.current,
      writeInput: (data) => wsManager.write(stream, term, data),
      writeClipboard: (text) =>
        writeTerminalClipboard(text, () => {
          toast.error('Could not copy the selection. Allow clipboard access and try again.');
        }),
    });
    clipboardRef.current = clipboard;
    const onCopy = (event: ClipboardEvent) => clipboard.copy(event);
    const onBlur = () => clipboard.reset();
    container.addEventListener('copy', onCopy, true);
    container.addEventListener('focusout', onBlur);
    container.addEventListener('mousedown', onBlur, true);
    window.addEventListener('blur', onBlur);

    let capturedPaste: string[] | null = null;
    const detachIosInput = attachIosTerminalInput(
      xterm,
      () => activeRef.current && wsManager.isConnected() && !replayingRef.current,
    );
    const unregisterInput = registerTerminalInput(
      stream,
      term,
      (text) => {
        capturedPaste = [];
        try {
          xterm.paste(text);
          return capturedPaste.join('');
        } finally {
          capturedPaste = null;
        }
      },
      () => xterm.focus(),
      () => xterm.modes.applicationCursorKeysMode,
    );
    const stdin = xterm.onData((data) => {
      if (capturedPaste) {
        capturedPaste.push(data);
        return;
      }
      // Not just typing: xterm CORE answers device queries (ESC[6n cursor
      // position, ESC[c device attributes, …) through this same event. During
      // a replay those are answers to HISTORICAL queries whose asker is long
      // gone, so forwarding them typed `^[[37;143R` junk into the shell's
      // input line on every re-attach (the OSC handlers below already guard
      // replay; this is the CSI-level equivalent). Auto-replies fire
      // synchronously inside the replay write, so the gate drops exactly
      // them — at worst also a keystroke typed mid-repaint.
      if (replayingRef.current) return;
      clipboard.input(data);
      wsManager.write(stream, term, consumeTerminalModifiers(stream, term, data));
    });

    // The daemon sees startup queries before viewers attach. Consume them
    // here to suppress xterm 6's built-in replies; only older daemons need
    // viewer-side answers. Historical queries must never reach PTY stdin.
    const oscColours = registerDynamicColourQueries(xterm, {
      daemonAnswers: daemonAnswersColours,
      isReplaying: () => replayingRef.current,
      readColour: (code) => cssTokenReader()(code === 10 ? '--text-primary' : '--bg-base'),
      reply: (report) => wsManager.write(stream, term, report),
    });

    const oscClipboard = xterm.parser.registerOscHandler(52, clipboard.osc);

    xterm.attachCustomKeyEventHandler((e) => {
      // Monaco-style in-view find. On macOS Ctrl+F remains the shell's
      // forward-character command; Command+F is the search gesture requested.
      if (e.type === 'keydown' && isFindShortcut(e, IS_MAC)) {
        e.preventDefault();
        find.openFind();
        return false;
      }
      if (clipboard.key(e)) {
        e.preventDefault();
        return false;
      }
      // App shortcuts win over the terminal (client setting, default ON): a
      // chord bound to a registered app action — ⌃⇥ tab cycling, ⌘K — must
      // not be eaten by xterm and sent to the PTY as bytes. Returning false
      // WITHOUT preventDefault makes xterm skip the key entirely, so the
      // event bubbles to the window dispatcher (HotkeysHost) that runs the
      // action. Actions the registry marks terminal-owned (`deferInTerminal`,
      // e.g. ⌃A/⌃`) or editor-bound stay with the terminal, exactly as the
      // dispatcher itself would yield them.
      if (e.type === 'keydown' && appShortcutsRef.current) {
        const binding = eventBinding(e);
        const id = binding !== null ? actionForBinding(binding) : undefined;
        const action = id !== undefined ? getHotkeyAction(id) : undefined;
        if (
          id !== undefined &&
          action !== undefined &&
          !action.editor &&
          !action.deferInTerminal &&
          getHotkeyHandler(id) !== undefined
        ) {
          return false;
        }
      }
      if (!IS_MAC) return true;
      const seq = macLineEditSequence(e);
      if (!seq) return true;
      e.preventDefault(); // stop browser navigation and macOS Option-key text input
      wsManager.write(stream, term, seq);
      return false; // consume: xterm must not also emit its default bytes
    });

    // Capture phase so this runs before xterm's own paste handler (which only
    // reads text/plain and would drop a clipboard image on the floor).
    const onPaste = (e: ClipboardEvent) => {
      if (interceptImagePaste(e, stream, term)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    container.addEventListener('paste', onPaste, true);
    // Usually the resulting onScroll cancels the guard. Cancel at the gesture
    // boundary too so a wheel event that lands while output is being parsed is
    // never mistaken for part of the application redraw.
    const onWheel = () => resizeScrollGuardRef.current.release();
    container.addEventListener('wheel', onWheel, { capture: true, passive: true });
    const detachTouchScroll = attachTerminalTouchScroll(
      xterm,
      () => activeRef.current,
      onWheel,
      (text) => setTouchSelection(text === null ? null : terminalSelectionText(xterm)),
    );

    // Focus wins the PTY size (tmux's `window-size latest`, SPEC §6). The PTY
    // has one size and every viewer's attach/resize claims it, so with the
    // same session open in two windows the OTHER window's re-attach shrinks
    // the PTY under this one — the TUI redraws for the small grid and this
    // viewer shows it faithfully: content top-left, bottom and right blank,
    // healed only by a reload re-sending these dims. Clicking into a terminal
    // is the moment the user declares which window is in use, so re-assert
    // this viewer's size then. When the sizes already agree this is a no-op
    // end to end (fit() finds nothing to change and a same-size PTY resize
    // raises no SIGWINCH).
    const onFocusIn = () => refit();
    container.addEventListener('focusin', onFocusIn);

    const observer = new ResizeObserver(() => refit());
    observer.observe(container);

    const unsubscribeTheme = onThemeChange(() => {
      xterm.options.theme = xtermThemeFromCss();
      find.refresh();
    });

    return () => {
      clipboard.reset();
      clipboardRef.current = null;
      container.removeEventListener('copy', onCopy, true);
      container.removeEventListener('focusout', onBlur);
      container.removeEventListener('mousedown', onBlur, true);
      window.removeEventListener('blur', onBlur);
      container.removeEventListener('paste', onPaste, true);
      container.removeEventListener('wheel', onWheel, true);
      container.removeEventListener('focusin', onFocusIn);
      detachTouchScroll();
      detachIosInput();
      observer.disconnect();
      unsubscribeTheme();
      resizeScrollGuardRef.current.release();
      searchResults.dispose();
      viewportScroll.dispose();
      oscColours.dispose();
      oscClipboard.dispose();
      urlLinks.dispose();
      fileLinks?.dispose();
      unregisterInput();
      stdin.dispose();
      xterm.dispose();
      setRichTerminal(null);
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // Deliberately keyed on the PTY identity only — plus the one-way font
    // gate: recreating the terminal on settings change would drop scrollback;
    // the effect below patches the live instance instead. (`refit` is keyed
    // on the same two, so listing it adds no churn.) `daemonAnswersColours`
    // settles before terminals normally mount and at worst recreates once,
    // early, against a pre-14.1 daemon.
  }, [stream, term, refit, fontReady, daemonAnswersColours]);

  // The PTY attachment, gated on `attached`: paused/hidden terminals detach
  // (the daemon stops sending, nothing is parsed) and re-attach on return,
  // where the daemon's replay repaints the buffer from scratch. Note a session
  // that exits while detached delivers no `exit` event here; the status feed
  // carries that news to the UI.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm || !attached) return;
    // Adoption may have just given the container real dimensions — size the
    // buffer first so the attach carries the dims the PTY should have.
    const container = containerRef.current;
    if (container && container.clientWidth > 0 && container.clientHeight > 0) {
      fitPreservingScroll();
    }
    // Keep xterm's built-in renderer. WebGL context loss (and backing-store
    // eviction without a context-loss event) repeatedly left working Codex
    // terminals blank; recreating the same renderer on reload reproduced the
    // failure. The built-in path is stable and avoids one GPU context per
    // visible pane.
    xterm.refresh(0, xterm.rows - 1);

    // Even a current daemon batches chatty PTY output, but this client-side
    // frame batch protects new clients connected to older daemons too. It also
    // turns any burst split across several WS messages into one xterm write,
    // preventing the write queue from growing faster than the browser paints.
    let outputFrame = 0;
    let outputChars = 0;
    let outputChunks: string[] = [];
    const flushOutput = () => {
      if (outputFrame !== 0) cancelAnimationFrame(outputFrame);
      outputFrame = 0;
      if (outputChars === 0) return;
      const data = outputChunks.join('');
      outputChunks = [];
      outputChars = 0;
      const guard = resizeScrollGuardRef.current;
      guard.beginManagedScroll();
      xterm.write(data, () => {
        try {
          // Most applications merely repaint the visible screen and leave the
          // marker intact. A TUI that purges and replays its transcript after
          // SIGWINCH disposes it; restore proportional progress after every
          // parsed replay chunk until output settles.
          restoreResizeScroll(xterm);
        } finally {
          guard.endManagedScroll();
        }
      });
    };
    const queueOutput = (data: string) => {
      outputChunks.push(data);
      outputChars += data.length;
      if (outputChars >= 64 * 1024) {
        flushOutput();
      } else if (outputFrame === 0) {
        outputFrame = requestAnimationFrame(flushOutput);
      }
    };
    const detach = wsManager.attach(stream, term, xterm.cols, xterm.rows, {
      onData: (data, kind) => {
        if (kind === 'replay') {
          // A replay is the complete daemon snapshot at the attach boundary;
          // discard an old attachment's unpainted frame rather than duplicate it.
          if (outputFrame !== 0) cancelAnimationFrame(outputFrame);
          outputFrame = 0;
          outputChars = 0;
          outputChunks = [];
          // `reset()` and replay both land xterm at the bottom. Preserve the
          // last viewport this browser window saw; an absent entry means the
          // terminal has always followed the bottom and needs no override.
          const savedScroll: TerminalScrollPosition | undefined = terminalScrollStore.get(
            stream,
            term,
          );
          // Start from a clean screen: the self-contained snapshot restores
          // the buffer rather than appending to what it already shows.
          clipboardRef.current?.reset();
          replayingRef.current = true;
          const guard = resizeScrollGuardRef.current;
          guard.beginManagedScroll();
          xterm.reset();
          xterm.write(data, () => {
            try {
              if (xtermRef.current !== xterm) return;
              replayingRef.current = false;
              hasReplayRef.current = true;
              // A large replay after this terminal has been parked can update
              // the buffer while the renderer keeps some rows marked clean. Selection
              // dirties those cells and reveals the text, but the replay itself
              // is the right boundary to repaint the whole restored viewport.
              xterm.refresh(0, xterm.rows - 1);
              if (savedScroll) {
                xterm.scrollToLine(terminalScrollLine(savedScroll, xterm.buffer.active.baseY));
                // The daemon resizes the PTY after this snapshot boundary. A
                // scrolled restored viewer therefore needs a guard before the
                // application's resulting redraw arrives.
                guard.capture(xterm);
              }
              restoreResizeScroll(xterm);
            } finally {
              guard.endManagedScroll();
            }
          });
          return;
        }
        queueOutput(data);
      },
      onExit: (code) => onExitRef.current?.(code),
    });
    return () => {
      if (outputFrame !== 0) cancelAnimationFrame(outputFrame);
      clipboardRef.current?.reset();
      detach();
    };
    // `fontReady` because the attach reads xtermRef, a REF: when the font gate
    // flips and the mount effect above finally creates the terminal, nothing
    // else would re-run this to attach it.
  }, [
    stream,
    term,
    attached,
    fontReady,
    daemonAnswersColours,
    fitPreservingScroll,
    restoreResizeScroll,
  ]);

  // Font size and scrollback patch the LIVE instance (recreating it would drop
  // scrollback). A font change resizes the CELL, not the container, so the
  // ResizeObserver never fires for it: without refitting here the grid kept the
  // old cols/rows and the terminal stopped filling its pane — smaller type left
  // a margin of dead ground, larger type wrapped and overflowed (fixed
  // 2026-08-04). `refit` also tells the PTY, so the agent's TUI redraws itself
  // at the size actually on screen.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.terminalFontSize;
    xterm.options.scrollback = settings.terminalScrollback;
    refit();
  }, [settings.terminalFontSize, settings.terminalScrollback, refit]);

  // A terminal mounted before `/api/host` answered was built for a POSIX
  // host; a Windows host's ConPTY mode joins the live instance once known.
  // A host never changes under a running daemon, so nothing is ever unset.
  useEffect(() => {
    const xterm = xtermRef.current;
    const { windowsPty } = windowsPtyOptions(hostStyle);
    if (xterm && windowsPty) xterm.options.windowsPty = windowsPty;
  }, [hostStyle]);

  // A FRESH PTY under an attached viewer (a resume, or an account migration —
  // "stop the process, repoint the account, resume", SPEC §5) needs the same
  // treatment: nothing else re-sizes or repaints then, since the viewer is
  // already attached (no new `attach`) and its container never changed (no
  // resize). The status feed is the signal — a session becoming live again after
  // being anything else means a new process is drawing into this buffer — and
  // the daemon starts that PTY at the size this viewer last asked for, so the
  // refit's job is to repaint and to re-assert the size if it drifted meanwhile.
  useEffect(() => {
    // Only a spawn can take a session from a dead status back to a live one, so
    // that edge IS the new process. `waiting_input` is a live status here on
    // purpose: it alternates with `running` every turn of a conversation, and
    // treating it as dead would refit on each of them.
    let wasLive = false; // nothing seen yet ⇒ the first live report is a start
    return wsManager.onStatus((e) => {
      if (e.session !== stream) return;
      const live = LIVE_STATUSES.includes(e.status);
      if (live && !wasLive) refit();
      wasLive = live;
    });
  }, [stream, refit]);

  return (
    <div
      className={cn('puddle-terminal group/terminal relative size-full', className)}
      data-notification-session={!paused && term === 'agent' ? stream : undefined}
    >
      <div ref={containerRef} className="size-full" />
      {richTerminal && !paused && visible && <TerminalRichOutput terminal={richTerminal} />}
      {touchSelection !== null && !paused && (
        <SelectionActions
          label="Selected terminal text"
          text={touchSelection}
          paste={() => pasteTerminalClipboard(stream, term, () => activeRef.current)}
          clear={() => {
            xtermRef.current?.clearSelection();
            setTouchSelection(null);
          }}
        />
      )}
      {find.open && (
        <FindWidget
          query={find.query}
          focusKey={find.focusKey}
          options={find.options}
          result={find.result}
          onQueryChange={find.setQuery}
          onOptionsChange={find.setOptions}
          onNext={find.next}
          onPrevious={find.previous}
          onClose={find.close}
        />
      )}
    </div>
  );
}
