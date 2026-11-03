import { statSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const WATCH_DEBOUNCE_MS = 350;
const POLL_INTERVAL_MS = 500;

/** Portable, debounced observation of one compiled target's input files. */
export class DependencyWatcher {
  private watchers: FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private signatures = new Map<string, string>();
  private polling = false;
  private generation = 0;

  /**
   * Windows file names compare case-insensitively, so a dependency spelt
   * differently from its directory entry (as a TeX recorder file may report
   * it) still matches the name fs.watch reports.
   */
  constructor(
    private readonly onChange: () => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  replace(dependencies: readonly string[]): void {
    this.close();
    const generation = this.generation;
    const unique = [...new Set(dependencies)];
    const byDirectory = new Map<string, Set<string>>();
    for (const dependency of unique) {
      const directory = dirname(dependency);
      const names = byDirectory.get(directory) ?? new Set<string>();
      names.add(this.comparable(basename(dependency)));
      byDirectory.set(directory, names);
    }
    for (const [directory, names] of byDirectory) {
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (filename !== null && !names.has(this.comparable(filename.toString()))) return;
          this.schedule(generation);
        });
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        // Dependency disappeared between build and registration. Polling still
        // detects its recreation; a later build refreshes directory watches.
      }
    }

    // fs.watch can exhaust descriptors or miss events on network/VM mounts.
    // Async stat polling is the portable safety net for Linux, macOS and WSL.
    this.signatures = new Map(unique.map((path) => [path, syncSignature(path)]));
    this.pollTimer = setInterval(() => void this.poll(generation), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private comparable(name: string): string {
    return this.platform === 'win32' ? name.toLowerCase() : name;
  }

  close(): void {
    this.generation += 1;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.signatures.clear();
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (generation === this.generation) this.onChange();
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private async poll(generation: number): Promise<void> {
    if (this.polling || generation !== this.generation) return;
    this.polling = true;
    try {
      const current = await Promise.all(
        [...this.signatures.keys()].map(async (path) => [path, await signature(path)] as const),
      );
      if (generation !== this.generation) return;
      for (const [path, value] of current) {
        if (this.signatures.get(path) === value) continue;
        this.signatures.set(path, value);
        this.schedule(generation);
      }
    } finally {
      this.polling = false;
    }
  }
}

function syncSignature(path: string): string {
  try {
    const value = statSync(path);
    return `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}`;
  } catch {
    return 'missing';
  }
}

async function signature(path: string): Promise<string> {
  try {
    const value = await stat(path);
    return `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}`;
  } catch {
    return 'missing';
  }
}
