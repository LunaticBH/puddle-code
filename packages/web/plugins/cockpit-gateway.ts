import { request } from 'node:http';
import { join } from 'node:path';
import { clientHome } from '../../cli/src/lib/paths';
import { DaemonClient } from '../../cli/src/lib/connection/daemon-client';
import type { AddressInfo } from 'node:net';
import type { Plugin } from 'vite';
import { HostConnection } from '../../cli/src/lib/auth/connection-authority';
import { LocalTransport } from '../../cli/src/lib/transport/local';
import { startUiServer, type UiServer } from '../../cli/src/lib/serve/ui-server';
import { RemoteAccessControl } from '../../cli/src/lib/host/remote-access';
import { localFileManager } from '../../cli/src/lib/host/file-manager';

/** Development uses the production browser boundary, including the isolated proxy origin. */
export function cockpitGateway(): Plugin {
  return {
    name: 'puddle-cockpit-gateway',
    configureServer(vite) {
      let gateway: UiServer | undefined;
      let ready: Promise<void>;
      vite.httpServer!.once('listening', () => {
        ready = (async () => {
          const authority = new HostConnection(new LocalTransport());
          const client = new DaemonClient(0, authority);
          authority.setVerifier(async () => {
            client.setPort(authority.port);
            await client.version();
            gateway?.setTarget({ host: '127.0.0.1', port: authority.port });
          });
          // pnpm dev starts Vite and the daemon concurrently. The same authority
          // reconnect loop handles either startup order without bypassing auth.
          await authority.establish().catch(() => {});
          const port = (vite.httpServer!.address() as AddressInfo).port;
          gateway = await startUiServer({
            assetsDir: '',
            port: 0,
            browserPort: port,
            identity: 'local',
            localSync: { file: join(clientHome(), 'local-sync.json') },
            fileManager: localFileManager(),
            remoteAccess: new RemoteAccessControl(new LocalTransport()),
            authority,
            target: { host: '127.0.0.1', port: authority.port },
          });
          vite.config.logger.info(
            `Authorise this development browser: ${gateway.createInvitation()}`,
          );
          vite.httpServer!.once('close', () => {
            authority.close();
            void gateway?.close();
          });
        })();
        void ready.catch(() =>
          vite.config.logger.error('Start puddled from a plain shell before using pnpm dev.'),
        );
      });
      vite.middlewares.use((req, res, next) => {
        const port = (vite.httpServer!.address() as AddressInfo | null)?.port;
        if (req.headers.host !== `localhost:${port}` && req.headers.host !== `127.0.0.1:${port}`) {
          res.statusCode = 403;
          res.end('Forbidden host');
          return;
        }
        const route = req.url ?? '/';
        if (
          !req.headers.host?.startsWith('127.0.0.1:') &&
          !/^\/(api|cockpit|proxy)(\/|$)/.test(route)
        )
          return next();
        void (async () => {
          await ready;
          if (!gateway) throw new Error('Gateway unavailable');
          const upstream = request(
            {
              host: '127.0.0.1',
              port: gateway.port,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on('error', () => res.destroy());
          res.on('close', () => upstream.destroy());
          req.pipe(upstream);
        })().catch(() => {
          res.statusCode = 503;
          res.end('Puddle authentication gateway is unavailable');
        });
      });
      vite.httpServer!.on('upgrade', (req, socket, head) => {
        if (req.url !== '/ws' && !req.url?.startsWith('/proxy/')) return;
        if (!gateway) {
          socket.destroy();
          return;
        }
        const upstream = request({
          host: '127.0.0.1',
          port: gateway.port,
          path: req.url,
          headers: req.headers,
        });
        upstream.on('upgrade', (response, remote, early) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n')}\r\n\r\n`,
          );
          if (head.length) remote.write(head);
          if (early.length) socket.write(early);
          socket.pipe(remote).pipe(socket);
          socket.on('close', () => remote.destroy());
          remote.on('error', () => socket.destroy());
        });
        upstream.on('response', () => socket.destroy());
        upstream.on('error', () => socket.destroy());
        upstream.end();
      });
    },
  };
}
