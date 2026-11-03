import { fork } from 'node:child_process';
import { join } from 'node:path';
import { nodeBinary } from './node-runtime.mjs';

/** Exercise the shipped runner and both imports without a daemon or agent. */
export async function smokePuddlang(stage) {
  const child = fork(join(stage, 'daemon/runner.js'), [], {
    execPath: nodeBinary(stage),
    cwd: stage,
    // On Windows libuv still copies SystemRoot, TEMP and the profile variables.
    env: {},
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostic = '';
  let result;
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-8192);
  });
  child.on('message', (message) => {
    result = message;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      child.send({
        type: 'start',
        input: 42,
        source: `
        import { input } from 'puddlang';
        import { z } from 'zod';
        const answer: number = z.number().parse(input);
        export default answer;
      `,
      });
    });
    if (code !== 0 || result?.type !== 'finished' || result.result !== 42)
      throw new Error(
        `Puddlang archive smoke test failed: ${JSON.stringify(result)} ${diagnostic}`,
      );
  } finally {
    clearTimeout(timer);
  }
}
