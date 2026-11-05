// A compile command's host, as the daemon is (the built CompilationService),
// in a process of its own, for compilation/compilation-windows-tree.test.ts:
//
//   node compile-host.mjs <command> <cwd>
//
// It runs <command> as a compile command and prints `running`. On a line on
// its standard input it disposes of the service, as the daemon's stop does,
// and exits as soon as that resolves, as the daemon may.
const dist = (path) => new URL(`../../dist/${path}`, import.meta.url).href;
const { runCompilationCommand } = await import(dist('compilation/process.js'));
const { CompilationService } = await import(dist('compilation/service.js'));

const [file, cwd] = process.argv.slice(2);
if (!file || !cwd) throw new Error('usage: compile-host.mjs <command> <cwd>');
const service = new CompilationService([]);
runCompilationCommand({ file, args: [], cwd, timeoutMs: 120_000 }).catch(() => {});
process.stdout.write('running\n');
process.stdin.once('data', async () => {
  await service.dispose();
  process.exit(0);
});
