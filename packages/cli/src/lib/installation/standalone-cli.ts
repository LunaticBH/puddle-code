import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../types.js';

interface StandaloneInstallation {
  root: string;
  release: string;
  launcher: string;
  scriptLauncher?: string;
}

/** Match the installed script and runtime, not whichever `puddle` is on PATH. */
export function standaloneInstallation(
  entryFile = fileURLToPath(import.meta.url),
  execPath = process.execPath,
): StandaloneInstallation | null {
  const release = resolve(dirname(entryFile), '..');
  if (!existsSync(join(release, 'STANDALONE'))) return null;
  try {
    const root = resolve(release, '..', '..');
    const record = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8')) as {
      kind?: unknown;
      launcher?: unknown;
      scriptLauncher?: unknown;
    };
    if (
      readFileSync(join(release, 'STANDALONE'), 'utf8').trim() !== 'puddle-cli' ||
      readFileSync(join(root, 'INSTALLATION'), 'utf8').trim() !== 'puddle-cli' ||
      dirname(release) !== join(root, 'versions') ||
      realpathSync(release) !== release ||
      realpathSync(execPath) !== join(release, 'bin/node') ||
      record.kind !== 'puddle-cli' ||
      typeof record.launcher !== 'string' ||
      !isAbsolute(record.launcher) ||
      (record.scriptLauncher !== undefined &&
        record.scriptLauncher !== join(dirname(record.launcher), 'pudl') &&
        record.scriptLauncher !== join(dirname(record.launcher), 'puddlang'))
    )
      throw new Error('Installation metadata does not match this CLI');
    return {
      root,
      release,
      launcher: record.launcher,
      ...(typeof record.scriptLauncher === 'string'
        ? { scriptLauncher: record.scriptLauncher }
        : {}),
    };
  } catch {
    throw new CliError(
      'not_installed',
      'this standalone archive is not an installer-managed CLI',
      'run the public install.sh to install the CLI before using upgrade or remove',
    );
  }
}

export function upgradeStandaloneCli(
  installation: StandaloneInstallation,
  version: string | undefined,
  repo: string | undefined,
): Promise<number> {
  const script = readFileSync(join(installation.release, 'cli/install-cli.sh'), 'utf8');
  const args = [
    '-s',
    '--',
    '--prefix',
    installation.root,
    '--bin-dir',
    dirname(installation.launcher),
  ];
  if (version !== undefined) args.push('--version', version);
  if (repo !== undefined) args.push('--repo', repo);
  return new Promise((resolve, reject) => {
    const child = spawn('sh', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(script);
    child.on('exit', (code) => {
      if (code === 0) resolve(0);
      else reject(new CliError('not_installed', `CLI installer exited with ${code ?? 'a signal'}`));
    });
  });
}

/** Exact launcher ownership prevents removal from deleting a replacement binary. */
export function standaloneLauncher(
  root: string,
  command: 'puddle' | 'pudl' | 'puddlang' = 'puddle',
): string {
  const quoted = `'${join(root, `current/${command}`).replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\n# puddle standalone launcher\nexec ${quoted} "$@"\n`;
}

export async function removeStandaloneCli(installation: StandaloneInstallation): Promise<void> {
  const lock = join(installation.root, '.install-lock');
  try {
    await mkdir(lock);
  } catch {
    throw new CliError('already_running', 'another CLI installation operation is running');
  }
  try {
    if (
      lstatSync(installation.launcher).isSymbolicLink() ||
      (await readFile(installation.launcher, 'utf8')) !== standaloneLauncher(installation.root)
    )
      throw new CliError('not_installed', 'the CLI launcher was replaced; refusing removal');
    if (installation.scriptLauncher && existsSync(installation.scriptLauncher)) {
      // Retain removal support for installations made before the command rename.
      const command = basename(installation.scriptLauncher);
      if (
        (command !== 'pudl' && command !== 'puddlang') ||
        !lstatSync(installation.scriptLauncher).isFile() ||
        (await readFile(installation.scriptLauncher, 'utf8')) !==
          standaloneLauncher(installation.root, command)
      )
        throw new CliError(
          'not_installed',
          `the ${command} launcher was replaced; refusing removal`,
        );
      await unlink(installation.scriptLauncher);
    }
    await unlink(installation.launcher);
    await rm(installation.root, { recursive: true, force: true });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
