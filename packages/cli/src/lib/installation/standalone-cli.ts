import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { system32Path } from '@puddle/shared/node/platform';
import { CliError } from '../types.js';

interface StandaloneInstallation {
  root: string;
  release: string;
  launcher: string;
  scriptLauncher?: string;
  /** Windows: install.ps1 added the launcher directory to the user PATH. */
  pathEntry?: boolean;
}

/** Match the installed script and runtime, not whichever `puddle` is on PATH. */
export function standaloneInstallation(
  entryFile = fileURLToPath(import.meta.url),
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): StandaloneInstallation | null {
  const release = resolve(dirname(entryFile), '..');
  if (!existsSync(join(release, 'STANDALONE'))) return null;
  // Windows paths compare case-insensitively; the junction resolves with
  // whatever case the installer recorded.
  const windows = platform === 'win32';
  const same = (left: string, right: string): boolean =>
    windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  try {
    const root = resolve(release, '..', '..');
    const record = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8')) as {
      kind?: unknown;
      launcher?: unknown;
      scriptLauncher?: unknown;
      pathEntry?: unknown;
    };
    if (
      readFileSync(join(release, 'STANDALONE'), 'utf8').trim() !== 'puddle-cli' ||
      readFileSync(join(root, 'INSTALLATION'), 'utf8').trim() !== 'puddle-cli' ||
      !same(dirname(release), join(root, 'versions')) ||
      !same(realpathSync(release), release) ||
      !same(realpathSync(execPath), join(release, windows ? 'bin/node.exe' : 'bin/node')) ||
      record.kind !== 'puddle-cli' ||
      typeof record.launcher !== 'string' ||
      !isAbsolute(record.launcher) ||
      (record.scriptLauncher !== undefined &&
        !scriptCommands(platform).some(
          (command) =>
            record.scriptLauncher ===
            join(dirname(record.launcher as string), launcherFile(command, platform)),
        ))
    )
      throw new Error('Installation metadata does not match this CLI');
    return {
      root,
      release,
      launcher: record.launcher,
      ...(typeof record.scriptLauncher === 'string'
        ? { scriptLauncher: record.scriptLauncher }
        : {}),
      ...(windows && record.pathEntry === true ? { pathEntry: true } : {}),
    };
  } catch {
    throw new CliError(
      'not_installed',
      'this standalone archive is not an installer-managed CLI',
      windows
        ? 'run the public install.ps1 to install the CLI before using upgrade or remove'
        : 'run the public install.sh to install the CLI before using upgrade or remove',
    );
  }
}

type ScriptCommand = 'pudl' | 'puddlang';

/** Windows releases never shipped the pre-rename `puddlang` command. */
function scriptCommands(platform: NodeJS.Platform): ScriptCommand[] {
  return platform === 'win32' ? ['pudl'] : ['pudl', 'puddlang'];
}

function launcherFile(command: 'puddle' | ScriptCommand, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${command}.cmd` : command;
}

export function upgradeStandaloneCli(
  installation: StandaloneInstallation,
  version: string | undefined,
  repo: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  if (platform === 'win32') return upgradeWindowsStandaloneCli(installation, version, repo);
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

/**
 * The Windows upgrade runs the release's own install-cli.ps1 with the
 * built-in Windows PowerShell. `-File`, not stdin: `-Command -` misparses
 * multi-line blocks. An upgrade never edits PATH: that stays the first
 * installation's decision.
 */
export function windowsUpgradeCommand(
  installation: StandaloneInstallation,
  version: string | undefined,
  repo: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const args = [
    ...POWERSHELL_FLAGS,
    '-File',
    win32.join(installation.release, 'cli', 'install-cli.ps1'),
    '-Prefix',
    installation.root,
    '-BinDir',
    win32.dirname(installation.launcher),
    '-NoPathUpdate',
  ];
  if (version !== undefined) args.push('-Version', version);
  if (repo !== undefined) args.push('-Repo', repo);
  return { file: windowsPowerShell(env), args };
}

const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  return system32Path('WindowsPowerShell\\v1.0\\powershell.exe', env);
}

function upgradeWindowsStandaloneCli(
  installation: StandaloneInstallation,
  version: string | undefined,
  repo: string | undefined,
): Promise<number> {
  const command = windowsUpgradeCommand(installation, version, repo);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
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

/**
 * The batch launcher install.ps1 writes (its activation script builds the
 * same bytes). cmd.exe reads batch files in the OEM code page, so the root is
 * reached through %~dp0 whenever a plain relative path leads there. `(goto)`
 * leaves the batch context once the line is read, so cmd.exe never rereads
 * the file: an upgrade or removal may replace or delete it while it runs.
 */
export function windowsStandaloneLauncher(
  root: string,
  binDir: string,
  command: 'puddle' | 'pudl' = 'puddle',
): string {
  const relative = win32.relative(binDir, root);
  const base =
    !win32.isAbsolute(relative) && batchSafe(relative)
      ? `%~dp0${relative === '' ? '' : `${relative}\\`}`
      : `${root}\\`;
  const script = command === 'puddle' ? 'index.js' : 'pudl.js';
  return (
    '@rem puddle standalone launcher\r\n' +
    `@(goto) 2>nul & "${base}current\\bin\\node.exe" "${base}current\\cli\\${script}" %*\r\n`
  );
}

function batchSafe(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text) && !/[%"]/.test(text);
}

export async function removeStandaloneCli(
  installation: StandaloneInstallation,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return removeWindowsStandaloneCli(installation);
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

/**
 * Windows cannot delete the node.exe that is running this removal, so when
 * the CLI removes itself a detached cmd.exe deletes the tree once this
 * process has exited. The PATH entry goes only when install.ps1 added it.
 */
async function removeWindowsStandaloneCli(installation: StandaloneInstallation): Promise<void> {
  const { root, launcher, scriptLauncher } = installation;
  const binDir = dirname(launcher);
  const lock = join(root, '.install-lock');
  try {
    await mkdir(lock);
  } catch {
    throw new CliError('already_running', 'another CLI installation operation is running');
  }
  try {
    if (
      lstatSync(launcher).isSymbolicLink() ||
      (await readFile(launcher, 'utf8')) !== windowsStandaloneLauncher(root, binDir)
    )
      throw new CliError('not_installed', 'the CLI launcher was replaced; refusing removal');
    if (scriptLauncher && existsSync(scriptLauncher)) {
      if (
        basename(scriptLauncher).toLowerCase() !== 'pudl.cmd' ||
        !lstatSync(scriptLauncher).isFile() ||
        (await readFile(scriptLauncher, 'utf8')) !== windowsStandaloneLauncher(root, binDir, 'pudl')
      )
        throw new CliError('not_installed', 'the pudl launcher was replaced; refusing removal');
      await unlink(scriptLauncher);
    }
    // The launchers leave the batch context before starting node.exe, so the
    // one running this command can go too.
    await unlink(launcher);
    await rm(join(root, 'current'), { force: true }); // the junction only, never its target
    if (installation.pathEntry) await removeUserPathEntry(binDir);
    if (isInside(process.execPath, root)) removeTreeAfterExit(root);
    else await rm(root, { recursive: true, force: true });
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isInside(path: string, root: string): boolean {
  const relative = win32.relative(root, path);
  return relative !== '' && !relative.startsWith('..') && !win32.isAbsolute(relative);
}

/**
 * Retries the tree once a second until the exiting node.exe releases it. It
 * must be cmd.exe: libuv starts a detached child without a console
 * (DETACHED_PROCESS), where Windows PowerShell exits without running its
 * command, and kills non-detached children with their parent. The root
 * travels in the environment, inside quotes, so cmd.exe never parses it.
 */
function removeTreeAfterExit(root: string): void {
  const retry =
    'for /l %i in (1,1,60) do @(rmdir /s /q "%PUDDLE_CLEANUP_ROOT%" 2>nul & ' +
    'if not exist "%PUDDLE_CLEANUP_ROOT%" exit /b 0 & ping -n 2 127.0.0.1 >nul)';
  const child = spawn(system32Path('cmd.exe'), ['/d', '/s', '/c', `"${retry}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: { ...process.env, PUDDLE_CLEANUP_ROOT: root },
  });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Takes the launcher directory out of HKCU\Environment\Path without expanding
 * the other entries' %VARIABLES%, then broadcasts the change. The directory
 * travels in the environment and the script as -EncodedCommand, so no path is
 * parsed as PowerShell.
 */
const REMOVE_PATH_ENTRY = `
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:PUDDLE_CLEANUP_PATH_ENTRY
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($key) {
  $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($value) {
    $kind = $key.GetValueKind('Path')
    $keep = @($value -split ';' | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ne $dir.TrimEnd('\\')) })
    $key.SetValue('Path', ($keep -join ';'), $kind)
  }
  $key.Close()
  [Environment]::SetEnvironmentVariable('PUDDLE_INSTALL_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('PUDDLE_INSTALL_REFRESH', $null, 'User')
}
`;

function removeUserPathEntry(directory: string): Promise<void> {
  const child = spawn(
    windowsPowerShell(process.env),
    [
      ...POWERSHELL_FLAGS,
      '-EncodedCommand',
      Buffer.from(REMOVE_PATH_ENTRY, 'utf16le').toString('base64'),
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PUDDLE_CLEANUP_PATH_ENTRY: directory },
    },
  );
  return new Promise((resolve) => {
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}
