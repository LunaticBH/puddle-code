import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import {
  connectorPipeState,
  isPidAlive,
  killProcessTree,
  peMachine,
  supervisorRequest,
  system32Path,
  type PowerShellRunner,
} from '@puddle/shared/node/platform';
import { waitForStartedDaemon } from '../../src/lib/connection/cockpit.js';
import { readCurrentVersion } from '../../src/lib/installation/current-link.js';
import {
  controlPipePresent,
  startWindowsDaemon,
  stopWindowsDaemon,
} from '../../src/lib/installation/windows-daemon.js';
import {
  installWindowsDaemon,
  pruneCache,
  versionFromArchiveName,
  windowsInstalledVersion,
  windowsLauncher,
} from '../../src/lib/installation/windows-install.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { CliError } from '../../src/lib/types.js';

describe('Windows daemon release assets', () => {
  it('downloads the release zip and its SHA256SUMS by their release names', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'puddle-windows-download-')), '.puddle');
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return String(url).endsWith('/SHA256SUMS')
        ? new Response(`${'0'.repeat(64)}  puddled-v1.2.3-win32-x64.zip\n`)
        : new Response('not the published zip');
    }) as typeof fetch;
    const savedRepo = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      // The checksum refuses the download before anything is unpacked or started.
      await expect(
        installWindowsDaemon({ home, version: '1.2.3', fetchFn, hostArch: async () => 'x64' }),
      ).rejects.toThrow('checksum mismatch');
    } finally {
      if (savedRepo === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = savedRepo;
    }
    expect(requested).toEqual([
      'https://github.com/acme/puddle/releases/download/v1.2.3/puddled-v1.2.3-win32-x64.zip',
      'https://github.com/acme/puddle/releases/download/v1.2.3/SHA256SUMS',
    ]);
    expect(existsSync(join(home, 'cache', 'puddled-v1.2.3-win32-x64.zip'))).toBe(false);
    expect(existsSync(join(home, 'bin', 'versions', '1.2.3'))).toBe(false);
  });

  it('fetches the machine’s own architecture from the repository it is told', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'puddle-windows-arm64-')), '.puddle');
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(`${'0'.repeat(64)}  puddled-v1.2.3-win32-arm64.zip\n`);
    }) as typeof fetch;
    // The SSH host helper names its client's repository; nothing else does here.
    await expect(
      installWindowsDaemon({
        home,
        version: '1.2.3',
        fetchFn,
        slug: 'fork/puddle',
        hostArch: async () => 'arm64',
      }),
    ).rejects.toThrow('checksum mismatch');
    expect(requested[0]).toBe(
      'https://github.com/fork/puddle/releases/download/v1.2.3/puddled-v1.2.3-win32-arm64.zip',
    );
    await expect(
      installWindowsDaemon({ home, version: '1.2.3', fetchFn, hostArch: async () => 'x86' }),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('reports an offline download as not installed, which a launcher can fall back on', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'puddle-windows-offline-')), '.puddle');
    // What Node's fetch rejects with when the network is down.
    const fetchFn = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND github.com') });
    }) as typeof fetch;
    const savedRepo = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      const failure = installWindowsDaemon({
        home,
        version: '1.2.3',
        fetchFn,
        hostArch: async () => 'x64',
      });
      await expect(failure).rejects.toBeInstanceOf(CliError);
      await expect(failure).rejects.toMatchObject({
        code: 'not_installed',
        message: 'download failed: fetch failed (getaddrinfo ENOTFOUND github.com)',
      });
    } finally {
      if (savedRepo === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = savedRepo;
    }
    expect(existsSync(join(home, 'bin', 'versions', '1.2.3'))).toBe(false);
  });

  it('derives the version from a Windows archive name, whichever separator its path uses', () => {
    expect(versionFromArchiveName('C:\\dl\\puddled-v0.3.14-win32-x64.zip')).toBe('0.3.14');
    expect(versionFromArchiveName('C:/dl/puddled-v0.3.14-win32-x64.zip')).toBe('0.3.14');
    expect(versionFromArchiveName('puddled-v1.0.0-rc.1-win32-x64.zip')).toBeUndefined();
    expect(versionFromArchiveName('puddled-v0.3.14-linux-x64.tar.gz')).toBeUndefined();
    expect(versionFromArchiveName('daemon.zip')).toBeUndefined();
  });

  it('writes a launcher for people that runs the current runtime', () => {
    expect(windowsLauncher()).toBe(
      '@"%~dp0current\\bin\\node.exe" "%~dp0current\\daemon\\puddled.mjs" %*\r\n',
    );
  });

  it('keeps the current download and one previous', () => {
    const cache = mkdtempSync(join(tmpdir(), 'puddle-windows-cache-'));
    const names = ['1.0.0', '1.1.0', '1.2.0'].map((v) => `puddled-v${v}-win32-x64.zip`);
    names.forEach((name, index) => {
      writeFileSync(join(cache, name), '');
      utimesSync(join(cache, name), index + 1, index + 1);
    });
    writeFileSync(join(cache, 'SHA256SUMS'), '');
    pruneCache(cache);
    expect(names.map((name) => existsSync(join(cache, name)))).toEqual([false, true, true]);
    expect(existsSync(join(cache, 'SHA256SUMS'))).toBe(true);
  });
});

const daemonDist = fileURLToPath(new URL('../../../daemon/dist/daemon.js', import.meta.url));
const supervisorDist = fileURLToPath(
  new URL('../../../daemon/dist/windows-supervisor.js', import.meta.url),
);
const connectorDist = fileURLToPath(new URL('../../../connector/dist/index.js', import.meta.url));

/**
 * Task Scheduler and WMI as a PowerShell that refuses both (or, with
 * `registers`, accepts the task but never runs it, as without a desktop
 * session): the supervisor then starts as the installer's detached child.
 * No test registers a real task.
 */
function taskScheduler(registers = false) {
  const calls: Array<Readonly<Record<string, string>>> = [];
  const powershell: PowerShellRunner = async (_script, env) => {
    calls.push(env);
    const reply =
      'PUDDLE_PROCESS_COMMAND' in env
        ? { code: 2, pid: 0, error: '' }
        : 'PUDDLE_TASK_XML' in env
          ? registers
            ? { registered: true, disabled: false, ran: false, state: 'Ready', error: '' }
            : { registered: false, disabled: false, error: 'refused in tests' }
          : { ran: false, removed: false, state: 'Ready', error: '' };
    return { code: 0, stdout: JSON.stringify(reply), stderr: '' };
  };
  return { calls, supervision: { powershell } };
}

const install = (opts: Parameters<typeof installWindowsDaemon>[0]) =>
  installWindowsDaemon({ supervision: taskScheduler().supervision, ...opts });

/**
 * A release-shaped `puddled-v<version>-win32-x64.zip` (with its `.sha256`) in
 * `dir`: this machine's node.exe as the runtime and, as the daemon, a fixture
 * that runs the built daemon. PUDDLE_FIXTURE_VERSION_DELAY_MS slows its
 * `--version`, PUDDLE_FIXTURE_START_DELAY_MS the start before it binds.
 * Without `supervised`, it is a release from before the Windows supervisor.
 */
function releaseZip(dir: string, version: string, supervised = true): string {
  const tree = join(dir, `stage-${version}`, `puddled-v${version}`);
  mkdirSync(join(tree, 'bin'), { recursive: true });
  mkdirSync(join(tree, 'daemon'), { recursive: true });
  try {
    linkSync(process.execPath, join(tree, 'bin', 'node.exe'));
  } catch {
    copyFileSync(process.execPath, join(tree, 'bin', 'node.exe'));
  }
  const delay = (name: string) =>
    `await new Promise((r) => setTimeout(r, Number(process.env.${name} ?? 0)));`;
  writeFileSync(
    join(tree, 'daemon', 'puddled.mjs'),
    [
      "if (process.argv.includes('--version')) {",
      `  ${delay('PUDDLE_FIXTURE_VERSION_DELAY_MS')}`,
      `  console.log('puddled ${version} (protocol 25.7)');`,
      '  process.exit(0);',
      '}',
      delay('PUDDLE_FIXTURE_START_DELAY_MS'),
      `const { startDaemon } = await import(${JSON.stringify(pathToFileURL(daemonDist).href)});`,
      `await startDaemon({ port: 0, adapters: [], version: "${version}", onShutdown: () => process.exit(0) });`,
      '',
    ].join('\n'),
  );
  if (supervised) {
    writeFileSync(
      join(tree, 'daemon', 'supervisor.mjs'),
      `await import(${JSON.stringify(pathToFileURL(supervisorDist).href)});\n`,
    );
    // Only Task Scheduler and WMI run the windowless launcher, and both are stand-ins here.
    writeFileSync(join(tree, 'bin', 'puddle-hidden.exe'), '');
  }
  writeFileSync(
    join(tree, 'daemon', 'connector.mjs'),
    `await import(${JSON.stringify(pathToFileURL(connectorDist).href)});\n`,
  );
  writeFileSync(join(tree, 'VERSION'), `${version}\n`);
  writeFileSync(join(tree, 'PROTOCOL'), '25.7\n');
  const file = `puddled-v${version}-win32-x64.zip`;
  const zip = join(dir, file);
  execFileSync(
    system32Path('tar.exe'),
    [
      '-a',
      '-c',
      '--options',
      'zip:compression=store',
      '-f',
      file,
      '-C',
      dirname(tree),
      basename(tree),
    ],
    // Relative names: tar.exe takes its arguments in the ANSI code page.
    { cwd: dir, windowsHide: true },
  );
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
  writeFileSync(`${zip}.sha256`, `${digest}  ${file}\n`);
  return zip;
}

/**
 * The whole decision-5/6 path against a real release-shaped zip (`pnpm build`
 * first). Windows only: it drives tar.exe, junctions and detached node.exe
 * processes.
 */
describe.runIf(
  process.platform === 'win32' &&
    [daemonDist, supervisorDist, connectorDist].every((file) => existsSync(file)),
)('installing and supervising a Windows daemon', () => {
  const root = mkdtempSync(join(tmpdir(), 'puddle-windows-install-'));
  const home = join(root, '.puddle');
  let zip: string;
  let newer: string;
  const homes = [home];
  const savedHome = process.env.PUDDLE_HOME;
  const logger = (lines: string[] = []) => ({
    lines,
    info: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
  });
  /** A fresh home, which PUDDLE_HOME then names (as `spelling`, if given). */
  const freshHome = (parent = root, spelling?: (path: string) => string) => {
    const path = join(mkdtempSync(join(parent, 'home-')), '.puddle');
    homes.push(path);
    process.env.PUDDLE_HOME = spelling ? spelling(path) : path;
    return spelling ? spelling(path) : path;
  };
  const pid = (at: string) => Number(readFileSync(join(at, 'puddled.pid'), 'utf8'));

  beforeAll(() => {
    zip = releaseZip(root, '1.2.3');
    newer = releaseZip(root, '1.2.4');
    process.env.PUDDLE_HOME = home;
  }, 120_000);

  afterAll(async () => {
    for (const each of homes) await stopWindowsDaemon(each).catch(() => undefined);
    if (savedHome === undefined) delete process.env.PUDDLE_HOME;
    else process.env.PUDDLE_HOME = savedHome;
    delete process.env.PUDDLE_FIXTURE_START_DELAY_MS;
    delete process.env.PUDDLE_FIXTURE_VERSION_DELAY_MS;
  });

  it('verifies, unpacks, links, starts and stops the daemon', async () => {
    process.env.PUDDLE_HOME = home;
    const { lines, ...log } = logger();
    const opts = { home, tarball: zip, logger: log };
    await install(opts);

    expect(readCurrentVersion(home)).toBe('1.2.3');
    expect(readlinkSync(join(home, 'bin', 'current'))).toContain('versions\\1.2.3');
    // Task Scheduler refused the task: launches start the supervisor instead.
    expect(readFileSync(join(home, 'supervisor'), 'utf8')).toBe('detached\n');
    expect(lines.join('\n')).toMatch(/could not register the scheduled task .*refused in tests/);
    expect(readFileSync(join(home, 'bin', 'puddled.cmd'), 'utf8')).toBe(windowsLauncher());
    const firstPid = pid(home);

    const started = await waitForStartedDaemon(new LocalTransport(), 60_000);
    expect(started.authority.version?.version).toBe('1.2.3');
    started.authority.close();
    // The supervisor runs the daemon whose pid it recorded.
    expect(await supervisorRequest(home, 'status')).toMatchObject({
      kind: 'answered',
      state: { daemon: firstPid, connector: null, stopping: false },
    });

    // The idempotent path: nothing is unpacked again, but the daemon is replaced.
    await install(opts);
    expect(lines).toContain('version 1.2.3 already installed');
    expect(pid(home)).not.toBe(firstPid);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();

    // A launcher that only needs a daemon leaves a running one alone.
    const secondPid = pid(home);
    await install({ ...opts, replaceRunning: false });
    expect(pid(home)).toBe(secondPid);

    await stopWindowsDaemon(home);
    expect(await controlPipePresent(home)).toBe(false);
    expect((await supervisorRequest(home, 'status')).kind).toBe('absent');
    expect(existsSync(join(home, 'puddled.pid'))).toBe(false);
  }, 180_000);

  it('refuses an archive of another architecture, and never counts such a tree as installed', async () => {
    const at = freshHome();
    // This machine's node.exe stands for the archive's runtime.
    const other = peMachine(process.execPath) === 'arm64' ? 'x64' : 'arm64';
    await expect(
      install({ home: at, tarball: zip, hostArch: async () => other }),
    ).rejects.toMatchObject({
      code: 'not_installed',
      message: expect.stringContaining(`this machine is win32-${other}`),
      hint: `use puddled-v1.2.3-win32-${other}.zip`,
    });
    expect(existsSync(join(at, 'bin', 'versions', '1.2.3'))).toBe(false);

    await install({ home: at, tarball: zip });
    expect(await windowsInstalledVersion(at)).toBe('1.2.3');
    expect(await windowsInstalledVersion(at, async () => other)).toBeNull();
    await stopWindowsDaemon(at);
  }, 180_000);

  it('refuses a start that would end with the SSH session that asked for it', async () => {
    const at = freshHome();
    // Task Scheduler and WMI are both refused: only a detached child is left.
    await expect(install({ home: at, tarball: zip, detachedStart: false })).rejects.toMatchObject({
      code: 'session_bound',
    });
    expect(await supervisorRequest(at, 'status')).toMatchObject({ kind: 'absent' });
    expect(await controlPipePresent(at)).toBe(false);
  }, 180_000);

  it('runs a release from before the supervisor detached, until an archive replaces it', async () => {
    const at = freshHome();
    const legacyDir = join(root, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = releaseZip(legacyDir, '1.2.3', false);
    const scheduler = taskScheduler(true);
    await installWindowsDaemon({ home: at, tarball: legacy, supervision: scheduler.supervision });
    expect(readFileSync(join(at, 'supervisor'), 'utf8')).toBe('detached\n');
    // No task names a supervisor this release does not ship.
    expect(scheduler.calls.filter((env) => 'PUDDLE_TASK_XML' in env)).toEqual([]);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect((await supervisorRequest(at, 'status')).kind).toBe('absent');

    const { lines, ...log } = logger();
    await install({ home: at, tarball: zip, logger: log });
    expect(lines).toContain(
      'existing version 1.2.3 predates the Windows supervisor — reinstalling',
    );
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect(await supervisorRequest(at, 'status')).toMatchObject({
      kind: 'answered',
      state: { daemon: pid(at) },
    });
    await stopWindowsDaemon(at);
  }, 180_000);

  it('registers the logon task, and restarts a daemon that crashes', async () => {
    const at = freshHome();
    const scheduler = taskScheduler(true);
    const { lines, ...log } = logger();
    await installWindowsDaemon({
      home: at,
      tarball: zip,
      logger: log,
      supervision: scheduler.supervision,
    });
    expect(readFileSync(join(at, 'supervisor'), 'utf8')).toBe('task\n');
    const registration = scheduler.calls.find((env) => 'PUDDLE_TASK_XML' in env)!;
    expect(registration.PUDDLE_TASK_NAME).toMatch(/^Puddle [0-9a-f]{16}$/);
    expect(registration.PUDDLE_TASK_XML).toContain('\\bin\\current\\daemon\\supervisor.mjs');
    expect(registration.PUDDLE_TASK_XML).toMatch(
      /<Command>[^<]*\\bin\\current\\bin\\puddle-hidden\.exe<\/Command>/,
    );
    expect(registration.PUDDLE_TASK_START).toBe('1');
    // The task did not run and WMI refused: the supervisor is this process's detached child.
    expect(lines.join('\n')).toMatch(/no desktop session/);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    const crashed = pid(at);
    await killProcessTree(crashed, { platform: 'win32' });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (!existsSync(join(at, 'puddled.pid')) || pid(at) === crashed)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(pid(at)).not.toBe(crashed);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect(readFileSync(join(at, 'logs', 'supervisor.log'), 'utf8')).toMatch(
      /restarting puddled in 1 s/,
    );
    await stopWindowsDaemon(at);
    expect((await supervisorRequest(at, 'status')).kind).toBe('absent');
  }, 180_000);

  it('supervises a home whose path holds %, which its logon task cannot start', async () => {
    const at = freshHome(mkdtempSync(join(root, 'puddle-100%-')));
    const scheduler = taskScheduler(true);
    const { lines, ...log } = logger();
    await installWindowsDaemon({
      home: at,
      tarball: zip,
      logger: log,
      supervision: scheduler.supervision,
    });
    expect(readFileSync(join(at, 'supervisor'), 'utf8')).toBe('detached\n');
    expect(lines.join('\n')).toMatch(/Task Scheduler cannot start Puddle for a home whose path/);
    // Task Scheduler would expand `%…%`: nothing is registered or started through it.
    expect(scheduler.calls.filter((env) => 'PUDDLE_TASK_NAME' in env)).toEqual([]);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect(await supervisorRequest(at, 'status')).toMatchObject({
      kind: 'answered',
      state: { daemon: pid(at) },
    });
    await stopWindowsDaemon(at);
    expect((await supervisorRequest(at, 'status')).kind).toBe('absent');
  }, 180_000);

  it('runs the connector while remote access is supervised, and stops it cleanly', async () => {
    const at = freshHome();
    mkdirSync(join(at, 'remote'), { recursive: true });
    writeFileSync(join(at, 'remote', 'supervised'), '');
    await install({ home: at, tarball: zip });
    const connector = async () => {
      const answer = await supervisorRequest(at, 'status');
      return answer.kind === 'answered' ? answer.state.connector : undefined;
    };
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 60_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await until(async () => (await connectorPipeState(at, 'remote')) === 'proven');
    const first = await connector();
    expect(first).toEqual(expect.any(Number));
    // After an upgrade the supervisor replaces it.
    await supervisorRequest(at, 'restart_connector');
    await until(async () => {
      const now = await connector();
      return typeof now === 'number' && now !== first;
    });
    await until(async () => (await connectorPipeState(at, 'remote')) === 'proven');
    // Supervision ends: the connector closes over its IPC channel; the daemon keeps running.
    rmSync(join(at, 'remote', 'supervised'));
    await supervisorRequest(at, 'reconcile');
    await until(async () => (await connectorPipeState(at, 'remote')) === 'absent');
    expect(await connector()).toBeNull();
    expect(readFileSync(join(at, 'logs', 'supervisor.log'), 'utf8')).not.toMatch(
      /did not stop — terminating/,
    );
    expect(await controlPipePresent(at)).toBe(true);
    await stopWindowsDaemon(at);
  }, 180_000);

  it('refuses an archive that does not match its checksum', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    const bad = join(other, 'puddled-v1.2.4-win32-x64.zip');
    copyFileSync(zip, bad);
    writeFileSync(`${bad}.sha256`, `${'0'.repeat(64)}  puddled-v1.2.4-win32-x64.zip\n`);
    await expect(install({ home, tarball: bad })).rejects.toThrow('checksum mismatch');
    expect(existsSync(join(home, 'bin', 'versions', '1.2.4'))).toBe(false);
  });

  it('reaches its daemon however the home is spelled', async () => {
    // `d:\…` for `D:\…`: the daemon canonicalises its home, the CLI does not.
    const at = freshHome(root, (path) => path[0]!.toLowerCase() + path.slice(1));
    await install({ home: at, tarball: zip });
    const started = await waitForStartedDaemon(new LocalTransport(), 60_000);
    expect(started.authority.version?.version).toBe('1.2.3');
    started.authority.close();
    await stopWindowsDaemon(at);
    expect(existsSync(join(at, 'puddled.pid'))).toBe(false);
  }, 180_000);

  it('unpacks under a profile whose name the ANSI code page cannot hold', async () => {
    // CJK and Greek: neither fits cp1252, so tar.exe would read `?` for them.
    const parent = join(root, '测试 Ελληνικά');
    mkdirSync(parent);
    const at = freshHome(parent);
    // The archive itself sits under that name too, so it is copied first.
    const archive = join(parent, basename(zip));
    copyFileSync(zip, archive);
    copyFileSync(`${zip}.sha256`, `${archive}.sha256`);
    await install({ home: at, tarball: archive });
    expect(readCurrentVersion(at)).toBe('1.2.3');
    expect(readdirSync(join(at, 'cache')).filter((name) => name.startsWith('.extract-'))).toEqual(
      [],
    );
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    await stopWindowsDaemon(at);
  }, 180_000);

  it('keeps the event loop running while it smoke-tests the runtime', async () => {
    const at = freshHome();
    process.env.PUDDLE_FIXTURE_VERSION_DELAY_MS = '1500';
    let last = Date.now();
    let longest = 0;
    const gap = () => {
      longest = Math.max(longest, Date.now() - last);
      last = Date.now();
    };
    const tick = setInterval(gap, 25);
    try {
      await install({ home: at, tarball: zip });
      gap(); // a stall just before the install returns leaves no later tick to see it
    } finally {
      clearInterval(tick);
      delete process.env.PUDDLE_FIXTURE_VERSION_DELAY_MS;
    }
    // The desktop runs this in Electron's main process: a blocked loop freezes its windows.
    expect(longest).toBeLessThan(1000);
    await stopWindowsDaemon(at);
  }, 180_000);

  it('never stops a daemon that a concurrent launcher started and is still starting', async () => {
    const at = freshHome();
    // Slow to bind, as under Defender's first scan of a fresh runtime.
    process.env.PUDDLE_FIXTURE_START_DELAY_MS = '4000';
    const first = logger();
    const second = logger();
    try {
      const a = install({
        home: at,
        tarball: zip,
        replaceRunning: false,
        logger: first,
      });
      // The second launcher queues on the install lock behind the first.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const b = install({
        home: at,
        tarball: zip,
        replaceRunning: false,
        logger: second,
      });
      await Promise.all([a, b]);
    } finally {
      delete process.env.PUDDLE_FIXTURE_START_DELAY_MS;
    }
    const started = pid(at);
    expect(isPidAlive(started, 'win32')).toBe(true);
    expect(second.lines.join('\n')).toMatch(/leaving it running/);
    expect(second.lines.join('\n')).not.toMatch(/stopping puddled|terminating/);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect(pid(at)).toBe(started);
    await stopWindowsDaemon(at);
  }, 180_000);

  it('leaves an identified daemon that has not served its pipe yet to start', async () => {
    const at = freshHome();
    await install({ home: at, tarball: zip });
    await stopWindowsDaemon(at);
    // Started outside the install lock, and slow to bind: the lock's holder
    // finds no pipe, only the pid file and the daemon's command line.
    process.env.PUDDLE_FIXTURE_START_DELAY_MS = '8000';
    const started = await startWindowsDaemon(at, '1.2.3');
    delete process.env.PUDDLE_FIXTURE_START_DELAY_MS;
    const { lines, ...log } = logger();
    await install({ home: at, tarball: zip, replaceRunning: false, logger: log });
    expect(lines).toContain('puddled was starting meanwhile — leaving it running');
    expect(lines.join('\n')).not.toMatch(/stopping puddled|terminating/);
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    expect(pid(at)).toBe(started);
    expect(isPidAlive(started, 'win32')).toBe(true);
    await stopWindowsDaemon(at);
  }, 180_000);

  it('leaves `current` naming the daemon it leaves running', async () => {
    const at = freshHome();
    await install({ home: at, tarball: zip });
    (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();
    const running = pid(at);
    // Another launcher, on another release, that only needs a daemon.
    const { lines, ...log } = logger();
    await install({ home: at, tarball: newer, replaceRunning: false, logger: log });
    expect(existsSync(join(at, 'bin', 'versions', '1.2.4'))).toBe(true);
    expect(readCurrentVersion(at)).toBe('1.2.3');
    expect(pid(at)).toBe(running);
    expect(lines).toContain('puddled 1.2.4 is unpacked; the running daemon was left in place');
    await stopWindowsDaemon(at);
  }, 180_000);

  it('renames the home’s pipes when another program squats the control pipe', async () => {
    const at = freshHome();
    const squatted = ipcPath(at, 'host');
    // A server on a name it saw earlier, unable to prove it reads the home.
    const squatter = await listenPrivate(squatted, (socket) => {
      socket.on('error', () => {});
      socket.on('data', () =>
        socket.end(JSON.stringify({ t: 'error', code: 'unavailable' }) + '\n'),
      );
    });
    try {
      const { lines, ...log } = logger();
      await install({ home: at, tarball: zip, logger: log });
      expect(lines.join('\n')).toMatch(/not this home’s daemon/);
      expect(ipcPath(at, 'host')).not.toBe(squatted);
      const started = await waitForStartedDaemon(new LocalTransport(), 60_000);
      expect(started.authority.version?.version).toBe('1.2.3');
      started.authority.close();
      expect(squatter.listening).toBe(true);
      await stopWindowsDaemon(at);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 180_000);
});
