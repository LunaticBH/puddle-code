import { profileDirectory } from './profile-state.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  REMOTE_POLICY,
  REMOTE_PROTOCOL_VERSION,
  connectorChallengeSchema,
  connectorConfigSchema,
  connectorNotificationSchema,
  connectorLocalRequestSchema,
  remoteIdentitySchema,
  relayMessageSchema,
  type RemoteAdminRequest,
  type RemoteAdminResponse,
  type RemoteInvitation,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  ipcPath,
  ipcProof,
  jsonLines,
  listenPrivate,
  privateDirectory,
  readPrivateJson,
} from '@puddle/shared/node';
import { createIdentity, identityPeer, secureChannel, SocketWire } from '@puddle/remote-transport';
import { DeviceStore } from './devices.js';
import { admit } from './admission.js';
import { ConnectorNotifications } from './notifications.js';
import { deleteRegistration } from './delete-registration.js';

export async function startConnector(home: string, profile: string) {
  const directory = profileDirectory(home, profile);
  privateDirectory(directory);
  const configPath = join(directory, 'config.json');
  const config = connectorConfigSchema.parse(readPrivateJson(configPath));
  const identityPath = join(directory, 'identity.json');
  if (!existsSync(identityPath)) {
    if (existsSync(join(directory, 'devices.db')))
      throw new Error('Host identity is missing; restore it or reset remote pairing locally');
    atomicPrivateJson(identityPath, [...(await createIdentity())]);
  }
  const identity = Uint8Array.from(remoteIdentitySchema.parse(readPrivateJson(identityPath)));
  const peer = identityPeer(identity);
  const devices = new DeviceStore(directory);
  let stopped = false;
  let registrationDeleted = false;
  let connected = false;
  let control: WebSocket | null = null;
  let nextAttempt = 0;
  let backoff = 500;
  let controlUntil = 0;
  const pipes = new Set<WebSocket>();
  const notifications = new ConnectorNotifications(config, devices, () => {
    if (!config.enabled || stopped || registrationDeleted) return false;
    try {
      const stored = connectorConfigSchema.parse(readPrivateJson(configPath));
      return stored.enabled && stored.credential === config.credential;
    } catch {
      return false;
    }
  });
  const admin = (request: RemoteAdminRequest): RemoteAdminResponse => {
    // An old process must never recreate deleted configuration or approve old requests.
    if (registrationDeleted) throw new Error('Remote registration has been deleted');
    switch (request.t) {
      case 'status':
        return { enabled: config.enabled, connected, host: config.host, peer };
      case 'devices':
        return { devices: devices.list() };
      case 'pair': {
        if (!config.enabled) throw new Error('Remote access is disabled');
        const invitation: RemoteInvitation = {
          version: REMOTE_PROTOCOL_VERSION,
          service: config.service,
          host: config.host,
          peer,
          ...devices.invite(),
        };
        return {
          invitation,
          url: `${config.app}/remote/pair#pair=${encodeURIComponent(JSON.stringify(invitation))}`,
        };
      }
      case 'approve':
        devices.approve(request.id);
        return { devices: devices.list() };
      case 'revoke':
        devices.revoke(request.id);
        return { devices: devices.list() };
      case 'disable': {
        config.enabled = false;
        atomicPrivateJson(configPath, config);
        // Persist first. Allow the administrative acknowledgement to leave before closing viewers.
        setTimeout(() => {
          control?.terminate();
          for (const pipe of pipes) pipe.terminate();
        }, 25);
        return { enabled: false, connected: false };
      }
    }
  };
  const adminSockets = new Set<import('node:net').Socket>();
  const server = await listenPrivate(ipcPath(home, `remote-${profile}`), (socket) => {
    adminSockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    let used = false;
    let challenged = false;
    const stop = jsonLines(
      socket,
      (value) => {
        // Windows (25.7): one optional challenge first, proving this server
        // reads the home, before the single request.
        if (process.platform === 'win32' && !used && !challenged) {
          const challenge = connectorChallengeSchema.safeParse(value);
          if (challenge.success) {
            challenged = true;
            const proof = ipcProof(home, `remote-${profile}`, challenge.data.challenge);
            socket.write(JSON.stringify({ t: 'proven', proof }) + '\n');
            return;
          }
        }
        if (used) return socket.destroy();
        used = true;
        let result: RemoteAdminResponse;
        try {
          const notification = connectorNotificationSchema.safeParse(value);
          if (notification.success) {
            void notifications
              .notify(notification.data.id, notification.data.content)
              .catch(() => {});
            socket.end('{}\n');
            return;
          }
          const request = connectorLocalRequestSchema.parse(value);
          if (request.t === 'delete_registration') {
            config.enabled = false;
            control?.terminate();
            for (const pipe of pipes) pipe.terminate();
            deleteRegistration(directory, devices);
            registrationDeleted = true;
            result = { enabled: false, connected: false };
          } else result = admin(request);
        } catch {
          result = { error: 'Remote administrative operation failed or expired' };
        }
        socket.end(JSON.stringify(result) + '\n');
      },
      () => socket.destroy(),
    );
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      stop();
      adminSockets.delete(socket);
    });
  }).catch((error: unknown) => {
    devices.close();
    throw error;
  });
  const openPipe = (connection: string) => {
    if (!config.enabled || pipes.size >= REMOTE_POLICY.connectionsPerHost) return;
    const url = new URL('/remote/pipe', config.service);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.credential}`, 'x-puddle-pipe': connection },
      maxPayload: REMOTE_POLICY.frameBytes,
      handshakeTimeout: REMOTE_POLICY.handshakeMs,
      perMessageDeflate: false,
    });
    pipes.add(socket);
    const wire = new SocketWire(socket, 'inbound');
    socket.on('message', (data, binary) => {
      if (!binary) return socket.terminate();
      wire.receive(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      pipes.delete(socket);
      wire.onTransportClosed();
    });
    socket.on('open', () => {
      void secureChannel(
        wire,
        identity,
        { service: config.service, host: config.host, hostPeer: peer, connection },
        'inbound',
      )
        .then((channel) =>
          admit(channel, {
            home,
            profile,
            account: config.account,
            devices,
            notifications,
            enabled: () => config.enabled && !stopped,
            admin,
          }),
        )
        .catch(() => socket.terminate());
    });
  };
  const establish = () => {
    // Host-local disable must also work if the administrative IPC is unavailable.
    // Fail closed on removal, unreadable state, or a changed registration.
    if (config.enabled) {
      try {
        const stored = connectorConfigSchema.parse(readPrivateJson(configPath));
        if (!stored.enabled || stored.credential !== config.credential) config.enabled = false;
      } catch {
        config.enabled = false;
      }
      if (!config.enabled) {
        control?.terminate();
        for (const pipe of pipes) pipe.terminate();
      }
    }
    if (control && performance.now() >= controlUntil) control.terminate();
    if (stopped || !config.enabled || control || Date.now() < nextAttempt) return;
    const url = new URL('/remote/connector', config.service);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.credential}` },
      maxPayload: 16_384,
      handshakeTimeout: REMOTE_POLICY.handshakeMs,
      perMessageDeflate: false,
    });
    control = socket;
    controlUntil = performance.now() + 45_000;
    socket.on('ping', () => {
      controlUntil = performance.now() + 45_000;
    });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('Invalid control frame');
        const message = relayMessageSchema.parse(JSON.parse(String(raw)));
        if (message.t === 'registered' && message.host === config.host) {
          connected = true;
          backoff = 500;
        } else if (message.t === 'open' && connected && message.account === config.account)
          openPipe(message.connection);
        else socket.terminate();
      } catch {
        socket.terminate();
      }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      if (control !== socket) return;
      control = null;
      connected = false;
      for (const pipe of pipes) pipe.terminate();
      nextAttempt = Date.now() + backoff;
      backoff = Math.min(10_000, backoff * 2);
    });
  };
  const reconnect = setInterval(establish, 500);
  establish();
  return {
    fingerprint: JSON.stringify([config, [...identity]]),
    admin,
    async close() {
      stopped = true;
      clearInterval(reconnect);
      control?.terminate();
      for (const pipe of pipes) pipe.terminate();
      for (const socket of adminSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Admissions close their authority synchronously when their transport is torn down.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      devices.close();
    },
  };
}
