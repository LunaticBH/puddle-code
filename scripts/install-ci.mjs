#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';

// actions/setup-node installs headers alongside its Node binary on Linux and
// macOS. Use those exact headers if an addon falls back to a source build: a
// prebuild download timeout must not require another download from nodejs.org.
// Its Windows toolcache comes from the zip distribution, which has no include
// directory; both addons ship win32 prebuilds, and node-gyp fetches headers
// and node.lib itself if one ever needs a source build there.
const windows = process.platform === 'win32';
const nodeDir = dirname(dirname(process.execPath));
if (!windows) {
  for (const file of ['node.h', 'common.gypi', 'config.gypi']) {
    accessSync(join(nodeDir, 'include', 'node', file));
  }
  console.log(`Using installed Node ${process.versions.node} headers from ${nodeDir}`);
}

const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
  stdio: 'inherit',
  // pnpm is a batch shim on Windows, which Node starts only through a shell;
  // the arguments are constant.
  shell: windows,
  // Keep this override inside dependency installation. Later electron-builder
  // rebuilds must select Electron's own headers, not the host Node headers.
  env: windows ? process.env : { ...process.env, npm_config_nodedir: nodeDir },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
