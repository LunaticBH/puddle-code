import { promisify } from 'node:util';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { startRemoteService } from '../../remote/src/server.js';
import { githubFixture } from '../../remote/test/helpers/oauth.js';
import { atomicPrivateJson } from '../../shared/src/node/security.js';
import { administrativeRequest } from '../../connector/src/admin.js';
import { fixture, createSession, env, stop, until, root } from '../../cli/e2e/helpers.js';
import { findFreePort } from '../../cli/src/lib/transport/net.js';

/** Real daemon, cockpit, service and connector; only the coding agent and GitHub are fixtures. */
export async function mobileFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-mobile-browser-'));
  const servicePort = await findFreePort();
  const appPort = await findFreePort();
  const serviceOrigin = `https://localhost:${servicePort}`;
  const appOrigin = `https://localhost:${appPort}`;
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  const local = await fixture({ caCert: certPath });
  // Make the actual connector entry point available to the built desktop cockpit.
  // No supervisor is installed or invoked; this fixture owns the connector process.
  mkdirSync(join(local.home, 'bin/current/bin'), { recursive: true });
  mkdirSync(join(local.home, 'bin/current/daemon'), { recursive: true });
  symlinkSync(process.execPath, join(local.home, 'bin/current/bin/node'));
  symlinkSync(
    join(root, 'packages/connector/dist/index.js'),
    join(local.home, 'bin/current/daemon/connector.mjs'),
  );
  const session = await createSession(local);
  const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  const github = githubFixture();
  const remote = await startRemoteService({
    service: serviceOrigin,
    app: appOrigin,
    home: join(directory, 'service'),
    port: 0,
    address: '127.0.0.1',
    secret: 'isolated-mobile-test-secret-long-enough-for-auth',
    github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
  });
  const address = remote.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing service port');
  const relay = createServer(tls, (req, res) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: address.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const sockets = new Set<Socket>();
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  relay.on('upgrade', (req, socket, head) => {
    const upstream = connect(address.port, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          req.rawHeaders.reduce(
            (text, part, index) => text + part + (index % 2 ? '\r\n' : ': '),
            '',
          ) +
          '\r\n',
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(servicePort, '127.0.0.1', resolve));
  const web = join(directory, 'web');
  await promisify(execFile)(
    process.execPath,
    [
      join(root, 'packages/web/node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      web,
      '--logLevel',
      'silent',
    ],
    {
      cwd: join(root, 'packages/web'),
      env: { ...env(local.home), VITE_PUDDLE_REMOTE_SERVICE: serviceOrigin },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await promisify(execFile)(process.execPath, [
    join(root, 'deploy/remote/externalise-theme.mjs'),
    web,
  ]);
  const app = createServer(tls, (req, res) => {
    const path = resolve(web, '.' + new URL(req.url!, appOrigin).pathname);
    if (path !== web && !path.startsWith(web + '/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = existsSync(path) && extname(path) ? path : join(web, 'index.html');
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader(
      'content-security-policy',
      file === join(web, 'preview.html')
        ? "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: https:; style-src 'unsafe-inline' data: https:; img-src data: https:; font-src data: https:; media-src data: https:; connect-src https:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
        : `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; media-src blob:; frame-src 'self' blob:; connect-src ${serviceOrigin} ${serviceOrigin.replace('https:', 'wss:')}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`,
    );
    res.end(readFileSync(file));
  });
  app.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => app.listen(appPort, '127.0.0.1', resolve));
  const profile = (await (await local.req('/api/profiles')).json())[0].id as string;
  let connector: ReturnType<typeof spawn> | undefined;
  return {
    local,
    session,
    remote,
    appOrigin,
    serviceOrigin,
    github,
    profile,
    admin: (request: unknown, selectedProfile = profile) =>
      administrativeRequest(local.home, request, selectedProfile),
    async enable(account: string, code?: string, selectedProfile = profile) {
      if (code) {
        await new Promise<void>((resolve, reject) => {
          const configure = spawn(
            process.execPath,
            [join(root, 'packages/connector/dist/index.js'), '--configure'],
            {
              env: { ...env(local.home), NODE_EXTRA_CA_CERTS: certPath },
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          configure.once('error', reject);
          configure.once('exit', (status) =>
            status === 0 ? resolve() : reject(new Error('Fixture registration failed')),
          );
          configure.stdin.end(
            JSON.stringify({
              profile: selectedProfile,
              setup: { service: serviceOrigin, app: appOrigin, code, managed: false },
            }) + '\n',
          );
        });
      } else {
        const registration = remote.store.redeem(
          remote.store.register(account, 'Fixture host').code,
        );
        atomicPrivateJson(join(local.home, 'remote', 'profiles', selectedProfile, 'config.json'), {
          ...registration,
          service: serviceOrigin,
          app: appOrigin,
          enabled: true,
        });
      }
      connector ??= spawn(process.execPath, [join(root, 'packages/connector/dist/index.js')], {
        env: { ...env(local.home), NODE_EXTRA_CA_CERTS: certPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      connector.stderr!.on('data', (part) => {
        errors += String(part);
      });
      await until(
        async () => {
          if (connector!.exitCode !== null) throw new Error(errors || 'Connector exited');
          return administrativeRequest(local.home, { t: 'status' }, selectedProfile).catch(
            () => null,
          );
        },
        (value) => value?.connected === true,
      );
      return JSON.parse(
        readFileSync(
          join(local.home, 'remote', 'profiles', selectedProfile, 'config.json'),
          'utf8',
        ),
      ) as unknown;
    },
    async close() {
      github.close();
      if (connector) await stop(connector);
      for (const socket of sockets) socket.destroy();
      relay.closeAllConnections();
      app.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => relay.close(() => resolve())),
        new Promise<void>((resolve) => app.close(() => resolve())),
      ]);
      await remote.close();
      await local.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(local.home, { recursive: true, force: true });
    },
  };
}
