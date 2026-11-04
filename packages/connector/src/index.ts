import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registeredProfiles, profileDirectory } from './profile-state.js';
import { jsonLines, atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { administrativeRequest, configureConnector, resetConnectorIdentity } from './admin.js';
import { inspectConnector } from './inspect.js';
import { startConnectorManager } from './manager.js';
import {
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  connectorConfigSchema,
  connectorProfileSchema,
  connectorAdminSchema,
  connectorConfigureSchema,
} from '@puddle/shared';

const home = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle');
if (process.argv.includes('--version')) {
  process.stdout.write(
    `puddle-connector remote protocol ${REMOTE_PROTOCOL_VERSION}; daemon protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}; cockpit controls 2; delete registration 1\n`,
  );
} else if (process.argv.includes('--disable-all')) {
  const legacy = join(home, 'remote', 'config.json');
  if (existsSync(legacy))
    atomicPrivateJson(legacy, {
      ...connectorConfigSchema.parse(readPrivateJson(legacy)),
      enabled: false,
    });
  for (const profile of registeredProfiles(home)) {
    if (existsSync(join(profileDirectory(home, profile), 'config.json'))) {
      const result = await administrativeRequest(home, { t: 'disable' }, profile);
      if (result.error) throw new Error('Could not disable remote access');
    }
  }
} else if (
  ['--inspect', '--reset', '--admin', '--configure'].some((flag) => process.argv.includes(flag))
) {
  let used = false;
  const act = async (value: unknown) => {
    if (process.argv.includes('--configure')) {
      const { profile, setup } = connectorConfigureSchema.parse(value);
      return configureConnector(home, setup, profile);
    }
    if (process.argv.includes('--admin')) {
      const { profile, request } = connectorAdminSchema.parse(value);
      return administrativeRequest(home, request, profile);
    }
    const { profile } = connectorProfileSchema.parse(value);
    if (process.argv.includes('--inspect')) return inspectConnector(home, profile);
    await resetConnectorIdentity(home, profile);
    return { enabled: false, connected: false };
  };
  jsonLines(
    process.stdin,
    (value) => {
      if (used) return;
      used = true;
      void act(value)
        .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
        .catch(() => {
          process.stderr.write(
            'Puddle remote: operation failed; refresh status before retrying.\n',
          );
          process.exitCode = 1;
        });
    },
    () => {
      process.exitCode = 1;
    },
  );
} else {
  const connector = await startConnectorManager(home);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void connector.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform === 'win32') {
    // Closing a console sends SIGHUP and Ctrl-Break SIGBREAK; the Windows
    // supervisor stops its connector by closing the IPC channel it gave it.
    process.on('SIGHUP', stop);
    process.on('SIGBREAK', stop);
    if (process.channel) process.on('disconnect', stop);
  }
}
