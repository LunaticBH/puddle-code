// Compiles src/ssh-askpass-shim.cs (the Windows SSH_ASKPASS program) with the
// .NET Framework 4 C# compiler that every supported Windows ships, so neither
// the build nor the user needs an SDK.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ssh-askpass-shim.cs');

function compiler() {
  const windows = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map((framework) =>
    join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`no .NET Framework C# compiler at ${candidates[0]}`);
  return found;
}

export function compileAskpassShim(outFile) {
  execFileSync(compiler(), ['/nologo', '/target:exe', '/optimize+', `/out:${outFile}`, source], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
