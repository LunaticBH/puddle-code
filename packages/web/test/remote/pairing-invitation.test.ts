import { expect, it } from 'vitest';
import { REMOTE_PROTOCOL_VERSION } from '@puddle/shared';
import {
  parsePairingInvitation,
  parsePairingLink,
} from '../../src/features/remote/pairing-invitation';

const app = 'https://app.example.test';
const service = 'https://relay.example.test';
const invitation = {
  version: REMOTE_PROTOCOL_VERSION,
  service,
  host: '00000000-0000-4000-8000-000000000001',
  peer: 'A'.repeat(44),
  invitation: 'b'.repeat(64),
  expires: Date.now() + 300_000,
};
const link = (value = invitation) =>
  `${app}/remote/pair#pair=${encodeURIComponent(JSON.stringify(value))}`;

it('accepts the existing connector QR format without visiting its URL', () => {
  expect(parsePairingLink(` ${link()} `, app, service)).toEqual(invitation);
});

it.each([
  'not a URL',
  'javascript:alert(1)',
  'data:text/html,hello',
  link().replace(app, 'https://other.example.test'),
  link().replace('https://', 'https://user:password@'),
  link().replace('/remote/pair', '/preview.html'),
  `${app}/remote/pair#pair=invalid`,
  `${link()}&pair=duplicate`,
  'x'.repeat(8193),
])('rejects untrusted or malformed pairing links', (value) => {
  expect(() => parsePairingLink(value, app, service)).toThrow();
});

it('rejects another service and expired invitations with useful errors', () => {
  expect(() =>
    parsePairingLink(link({ ...invitation, service: 'https://other.example.test' }), app, service),
  ).toThrow('different remote service');
  expect(() => parsePairingLink(link({ ...invitation, expires: 1 }), app, service)).toThrow(
    'expired',
  );
});

it('checks expiry again when a previously read invitation is confirmed', () => {
  const expired = { ...invitation, expires: Date.now() - 1 };
  expect(() => parsePairingInvitation(JSON.stringify(expired), service)).toThrow('expired');
});
