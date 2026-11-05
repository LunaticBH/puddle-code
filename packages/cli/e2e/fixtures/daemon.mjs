import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../../daemon/dist/daemon.js';

if (!process.env.PUDDLE_HOME?.includes('puddle-auth-e2e-'))
  throw new Error('An isolated test home is required');
// Deterministic subprocess: PTY input is logged exactly once by this fake agent.
const fake = {
  id: 'fake',
  displayName: 'Test agent',
  binary: process.execPath,
  capabilities: {
    resume: true,
    presetSessionId: true,
    skipPermissions: false,
    migratableSessions: false,
  },
  env: () => ({}),
  checkLoggedIn: async () => true,
  // The home names the agent's command line, so the test run's process
  // guard recognises it (daemon/test/helpers/process-guard.ts).
  launchArgs: () => [
    fileURLToPath(new URL('./fake-agent.mjs', import.meta.url)),
    process.env.PUDDLE_HOME,
  ],
  resumeArgs: () => [
    fileURLToPath(new URL('./fake-agent.mjs', import.meta.url)),
    process.env.PUDDLE_HOME,
  ],
  loginArgs: () => ['-c', 'exit 0'],
  resolveSessionRef: async (options) => `fake-${options.sessionId}`,
  hasConversation: () => true,
  statusPatterns: { waitingInput: [/READY/], busy: [/BUSY/] },
};
const daemon = await startDaemon({
  home: process.env.PUDDLE_HOME,
  port: 0,
  adapters: [fake],
  version: '0.1.13',
  statusQuietMs: 20,
});
process.send?.({ port: daemon.port });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().then(() => process.exit(0));
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
// Windows has no SIGTERM from another process (that is TerminateProcess):
// the test asks over the IPC channel instead.
process.on('message', (message) => {
  if (message?.t === 'stop') stop();
});
