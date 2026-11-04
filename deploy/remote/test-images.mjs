// Exercise the built images with the same restrictions as the Compose deployment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const [serviceImage = 'puddle-remote-service:test', appImage = 'puddle-remote-app:test'] =
  process.argv.slice(2);
const containers = [];
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();

function start(image, port, extra) {
  const id = docker(
    'run',
    '-d',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--tmpfs',
    '/tmp',
    '-e',
    'PUDDLE_REMOTE_SERVICE=https://relay.example.test',
    '-e',
    'PUDDLE_REMOTE_APP=https://app.example.test',
    '-p',
    `127.0.0.1::${port}`,
    ...extra,
    image,
  );
  containers.push(id);
  return { id, base: `http://${docker('port', id, `${port}/tcp`)}` };
}

// Use node:http to preserve the exact Host header required by the service.
function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function ready(container, path, headers = {}) {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await get(`${container.base}${path}`, { headers });
      if (response.status === 200) return response;
      last = `${response.status}: ${response.body}`;
    } catch (error) {
      last = String(error);
    }
    if (docker('inspect', '--format', '{{.State.Running}}', container.id) !== 'true') break;
    await delay(100);
  }
  throw new Error(`Container failed readiness: ${last}`);
}

try {
  const service = start(serviceImage, 7440, [
    // Docker must copy the image's directory permissions, as with the Compose volume.
    '--mount',
    'type=volume,dst=/data',
    '-e',
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    '-e',
    'GITHUB_CLIENT_ID=container-smoke-test',
    '-e',
    'GITHUB_CLIENT_SECRET=container-smoke-test',
  ]);
  const health = await ready(service, '/health', { host: 'relay.example.test' });
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  docker('restart', service.id);
  service.base = `http://${docker('port', service.id, '7440/tcp')}`;
  const restarted = await ready(service, '/health', { host: 'relay.example.test' });
  assert.deepEqual(JSON.parse(restarted.body), { status: 'ok' });
  console.log('Remote service: fresh-volume startup and restart with retained state pass.');

  const app = start(appImage, 8080, [
    '--tmpfs',
    '/config',
    '--tmpfs',
    '/data',
    '-e',
    'PUDDLE_REMOTE_WSS=wss://relay.example.test',
  ]);
  const index = await ready(app, '/');
  const guide = await get(`${app.base}/guide`);
  assert.equal(guide.status, 200);
  assert.match(guide.headers['content-type'], /^text\/html/);
  assert.ok(index.headers['content-security-policy']?.includes('https://relay.example.test'));
  assert.ok(index.headers['content-security-policy']?.includes("script-src 'self';"));
  assert.equal(index.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=()');
  const preview = await get(`${app.base}/preview.html`);
  assert.equal(preview.status, 200);
  assert.ok(preview.headers['content-security-policy']?.includes('sandbox allow-scripts;'));
  assert.ok(preview.headers['content-security-policy']?.includes("frame-ancestors 'self';"));
  assert.ok(!preview.headers['content-security-policy']?.includes('allow-same-origin'));
  assert.equal(preview.headers['x-frame-options'], undefined);
  assert.equal(preview.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  const script = await get(`${app.base}/install.sh`);
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/plain/);
  assert.equal(script.headers['cache-control'], 'no-store');
  assert.ok(script.body.startsWith('#!/bin/sh\n'));
  assert.ok(script.body.includes('Standalone CLI installer'));
  assert.ok(!script.body.includes('@@REPO@@'));
  execFileSync('sh', ['-n'], { input: script.body });
  // `irm …/install.ps1 | iex` must receive the script itself, never the SPA.
  const windowsScript = await get(`${app.base}/install.ps1`);
  assert.equal(windowsScript.status, 200);
  assert.match(windowsScript.headers['content-type'], /^text\/plain/);
  assert.equal(windowsScript.headers['cache-control'], 'no-store');
  assert.ok(windowsScript.body.startsWith('# Standalone CLI installer for Windows'));
  assert.ok(!windowsScript.body.includes('@@REPO@@'));
  for (const name of [
    'install-cli.sh',
    'install-daemon.sh',
    'install-missing.sh',
    'install-cli.ps1',
    'install-missing.ps1',
  ]) {
    assert.equal((await get(`${app.base}/${name}`)).status, 404);
  }
  const assets = docker('exec', app.id, 'find', '/srv', '-type', 'f').split('\n');
  assert.ok(assets.includes('/srv/index.html'));
  for (const file of assets) {
    const response = await get(`${app.base}${file.slice('/srv'.length)}`, { method: 'HEAD' });
    assert.equal(response.status, 200, `Unreadable application asset: ${file}`);
  }
  console.log(`Remote application: non-root, read-only startup and ${assets.length} assets pass.`);
} catch (error) {
  console.error(error);
  for (const id of containers) console.error(docker('logs', id));
  process.exitCode = 1;
} finally {
  for (const id of containers) docker('rm', '-f', '-v', id);
}
