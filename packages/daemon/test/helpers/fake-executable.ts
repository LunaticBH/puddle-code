import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes a fake command `name` into `dir` that runs `nodeSource`, an ES
 * module, under the `node` on PATH, and returns the launcher's path. With
 * `dir` on PATH the command runs by name on every platform:
 *
 * - POSIX: `<name>`, mode 0755, a `#!/usr/bin/env node` launcher that imports
 *   `<name>.mjs`;
 * - Windows: `<name>.mjs` plus `<name>.cmd` in npm's cmd-shim format, so
 *   `findExecutable` resolves it through PATHEXT and `resolveSpawn` unwraps it
 *   into `node <name>.mjs`, as it does for npm-installed agents.
 *
 * Arguments start at `process.argv[2]` either way. Keep Node's own directory
 * on any PATH handed to the code under test.
 */
export function writeFakeExecutable(dir: string, name: string, nodeSource: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mjs`), nodeSource);
  if (process.platform !== 'win32') {
    const launcher = join(dir, name);
    writeFileSync(
      launcher,
      '#!/usr/bin/env node\n' +
        "import(require('node:url').pathToFileURL(" +
        `require('node:path').join(__dirname, ${JSON.stringify(`${name}.mjs`)})).href);\n`,
    );
    chmodSync(launcher, 0o755); // independent of the umask
    return launcher;
  }
  const launcher = join(dir, `${name}.cmd`);
  writeFileSync(launcher, npmCmdShim(`${name}.mjs`));
  return launcher;
}

/** The launcher npm's cmd-shim writes for a `#!/usr/bin/env node` script. */
function npmCmdShim(script: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    '',
  ].join('\r\n');
}
