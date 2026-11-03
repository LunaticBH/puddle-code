import { execFile } from 'node:child_process';
import type { SessionPort } from '@puddle/shared';
import { listWindowsProcesses, system32Path } from '@puddle/shared/node/platform';
import type { PtyManager } from '../pty/pty-manager.js';
import { descendantsOf } from './process-tree.js';

/** A single detected TCP listener, before it's filtered to a session's process tree. */
export interface Listener {
  pid: number;
  port: number;
  address: string;
  command: string;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` — machine-readable field output. Records
 * begin `p<pid>`, then `c<command>`, then one or more `n<addr>:<port>` lines
 * per socket (verified live on macOS: `f<fd>` lines are interspersed between
 * `c` and `n` and are ignored here along with any other unrecognised tag).
 * Port is the substring after the LAST `:` (IPv6 addresses contain colons of
 * their own); the address has `[]` stripped.
 */
export function parseLsofOutput(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') {
      pid = Number(rest);
      command = null;
    } else if (tag === 'c') {
      command = rest;
    } else if (tag === 'n') {
      if (pid === null || command === null) continue; // malformed/partial record
      const idx = rest.lastIndexOf(':');
      if (idx === -1) continue;
      const port = Number(rest.slice(idx + 1));
      if (!Number.isFinite(port)) continue;
      let address = rest.slice(0, idx);
      if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
      listeners.push({ pid, command, port, address });
    }
    // any other tag (f<fd>, T<tcp state>, ...) is ignored
  }
  return listeners;
}

/**
 * `ss -tlnpH` — whitespace columns, no header (`-H`). Local-address column
 * (4th) forms `0.0.0.0:3000`, `[::]:3000`, `*:3000`; the process column is
 * `users:(("node",pid=123,fd=20),("node",pid=124,fd=20))` — the FIRST
 * (comm, pid) pair wins. Lines with no `users:` blob (insufficient
 * permission to see the owning process) are skipped, not guessed at.
 */
export function parseSsOutput(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    const localAddr = columns[3];
    if (columns.length < 4 || localAddr === undefined) continue;
    const usersMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const command = usersMatch?.[1];
    const pidStr = usersMatch?.[2];
    if (command === undefined || pidStr === undefined) continue;
    const idx = localAddr.lastIndexOf(':');
    if (idx === -1) continue;
    const port = Number(localAddr.slice(idx + 1));
    if (!Number.isFinite(port)) continue;
    let address = localAddr.slice(0, idx);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    listeners.push({ pid: Number(pidStr), command, port, address });
  }
  return listeners;
}

/**
 * Runs `cmd`, resolving to stdout. lsof (and potentially ss) exit non-zero
 * when nothing matches the filter — that's an empty result, not a failure,
 * so an exec error paired with empty stdout resolves to `''` rather than
 * rejecting. An error WITH stdout content is unexpected and still rejects.
 */
function execTolerant(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        if (!stdout) {
          resolve('');
          return;
        }
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function listListenersDarwin(): Promise<Listener[]> {
  return parseLsofOutput(await execTolerant('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
}

async function listListenersLinux(): Promise<Listener[]> {
  return parseSsOutput(await execTolerant('ss', ['-tlnpH']));
}

/**
 * `netstat -ano` from System32 (ASCII; about 60 ms), named from the shared
 * process table, since netstat reports only pids. Unlike lsof and ss, a
 * failure rejects: netstat exits 0 whenever it ran, and a silently empty list
 * would make the proxy refuse every port.
 */
async function listListenersWin32(): Promise<Listener[]> {
  const [stdout, processes] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      execFile(
        system32Path('netstat.exe'),
        ['-ano'],
        { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true, timeout: 10_000 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    }),
    listWindowsProcesses(),
  ]);
  const names = new Map(processes.map((entry) => [entry.pid, entry.name.replace(/\.exe$/i, '')]));
  return parseNetstatOutput(stdout, (pid) => names.get(pid) ?? '');
}

/**
 * `netstat -ano` rows: `TCP <local> <foreign> <state> <pid>` (IPv6 rows use
 * `[...]` addresses and are labelled TCP too). The State column is localised
 * (German `ABHÖREN`), so a listener is recognised by its foreign address,
 * `0.0.0.0:0` or `[::]:0`, which only listening sockets have. UDP rows have
 * no state and are skipped. The port follows the LAST `:`; brackets and a
 * `%scope` suffix are stripped from the address.
 */
export function parseNetstatOutput(stdout: string, nameOf: (pid: number) => string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const [, local, foreign, pidText] = match;
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue;
    const idx = local!.lastIndexOf(':');
    if (idx === -1) continue;
    const port = Number(local!.slice(idx + 1));
    if (!Number.isInteger(port)) continue;
    let address = local!.slice(0, idx);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    address = address.replace(/%.*$/, '');
    const pid = Number(pidText);
    listeners.push({ pid, command: nameOf(pid), port, address });
  }
  return listeners;
}

function platformLister(platform: NodeJS.Platform): () => Promise<Listener[]> {
  if (platform === 'darwin') return listListenersDarwin;
  return platform === 'win32' ? listListenersWin32 : listListenersLinux;
}

interface CacheEntry {
  /** Epoch ms the settled result expires; irrelevant while `pending` is set. */
  expires: number;
  pending?: Promise<SessionPort[]>;
  settled?: SessionPort[];
}

export interface PortScannerOptions {
  ptys: Pick<PtyManager, 'pidsFor'> & Partial<Pick<PtyManager, 'hiddenPortsFor'>>;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Cache TTL in ms; injectable for tests, default 2000 (SPEC §9). */
  ttlMs?: number;
  /** Injectable platform listener lister — tests use this for fixtures/spies. */
  lister?: () => Promise<Listener[]>;
  /** Injectable process-tree walk (descendantsOf by default) — tests use this for fixtures. */
  tree?: (roots: number[]) => Promise<Set<number>>;
}

/**
 * Detects listening TCP ports within a session's process tree (SPEC §9): the
 * agent plus every live shell terminal on its stream, and their descendants.
 * Results are cached per session for `ttlMs` with in-flight dedupe, so
 * concurrent viewers of the same session share one scan.
 */
export class PortScanner {
  private readonly ptys: Pick<PtyManager, 'pidsFor'> & Partial<Pick<PtyManager, 'hiddenPortsFor'>>;
  private readonly ttlMs: number;
  private readonly lister: () => Promise<Listener[]>;
  private readonly tree: (roots: number[]) => Promise<Set<number>>;
  private readonly platform: NodeJS.Platform;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: PortScannerOptions) {
    this.ptys = opts.ptys;
    this.ttlMs = opts.ttlMs ?? 2000;
    this.platform = opts.platform ?? process.platform;
    this.lister = opts.lister ?? platformLister(this.platform);
    this.tree = opts.tree ?? ((roots) => descendantsOf(roots, { platform: this.platform }));
  }

  async scan(sessionId: string, opts: { fresh?: boolean } = {}): Promise<SessionPort[]> {
    const now = Date.now();
    const cached = this.cache.get(sessionId);
    if (!opts.fresh && cached) {
      if (cached.pending) return cached.pending;
      if (cached.settled && cached.expires > now) return cached.settled;
    }
    const pending = this.runScan(sessionId);
    this.cache.set(sessionId, { expires: 0, pending });
    try {
      const ports = await pending;
      this.cache.set(sessionId, { expires: Date.now() + this.ttlMs, settled: ports });
      return ports;
    } catch (err) {
      this.cache.delete(sessionId);
      throw err;
    }
  }

  /**
   * `port` is open for this session — a cached scan, and on a miss ONE fresh
   * re-scan before concluding it isn't there (SPEC §9 "re-scan once before
   * rejecting": a port that just started listening shouldn't 404 a proxy
   * request against a stale cache entry). Task 15's proxy consumes this; the
   * name and semantics are a contract with it.
   */
  async hasPort(sessionId: string, port: number): Promise<boolean> {
    const cached = await this.scan(sessionId);
    if (cached.some((p) => p.port === port)) return true;
    const fresh = await this.scan(sessionId, { fresh: true });
    return fresh.some((p) => p.port === port);
  }

  /**
   * The loopback address the proxy dials for a detected `port`: 127.0.0.1,
   * except on Windows when every listener on it is `::1` only. Node resolves
   * `localhost` to ::1 first there, so a dev server told to listen on
   * localhost (Vite's default) accepts no IPv4 connection. Call after hasPort,
   * whose scan this reuses.
   */
  async upstreamHost(sessionId: string, port: number): Promise<string> {
    if (this.platform !== 'win32') return '127.0.0.1';
    const listeners = (await this.scan(sessionId)).filter((p) => p.port === port);
    return listeners.length > 0 && listeners.every((p) => p.address === '::1')
      ? '::1'
      : '127.0.0.1';
  }

  private async runScan(sessionId: string): Promise<SessionPort[]> {
    const pids = this.ptys.pidsFor(sessionId);
    if (pids.length === 0) return []; // exited/interrupted session: zero execs
    const [tree, listeners] = await Promise.all([this.tree(pids), this.lister()]);
    const hidden = this.ptys.hiddenPortsFor?.(sessionId) ?? new Set<number>();
    const seen = new Map<string, SessionPort>();
    const ports: SessionPort[] = [];
    for (const listener of listeners) {
      if (!tree.has(listener.pid)) continue;
      if (hidden.has(listener.port)) continue;
      const key = `${listener.port}:${listener.pid}`;
      const kept = seen.get(key);
      if (kept) {
        // Windows: an IPv4-reachable socket of the same listener decides how
        // the proxy dials it (upstreamHost), so it is the one reported.
        if (this.platform === 'win32' && kept.address === '::1') kept.address = listener.address;
        continue;
      }
      const port: SessionPort = {
        port: listener.port,
        pid: listener.pid,
        command: listener.command,
        address: listener.address,
      };
      seen.set(key, port);
      ports.push(port);
    }
    ports.sort((a, b) => a.port - b.port);
    return ports;
  }
}
