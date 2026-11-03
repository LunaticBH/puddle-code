import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../../src/lib/transport/auth';
import { openBrowserLink } from '../../src/features/ports/forward-link';

const origin = 'http://localhost:7436';
const session = '8a89814f-152c-434d-9b56-6570c0303b4c';
const forwarding = `/forward/${session}/3000?path=%2Fapp%3Fx%3D1%23section`;
const credential = 'br_' + 'a'.repeat(64);
const invitation = `http://127.0.0.1:7436/proxy/${session}/3000/_puddle/enter#invite=iv_${'b'.repeat(64)}`;
const open = vi.fn();
const fetcher = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', {
    location: { origin, href: origin + '/project/fixture' },
    puddleDesktop: { raiseWindow() {} },
    open,
  });
  vi.stubGlobal('fetch', fetcher);
  tokenStore.set(credential);
});
afterEach(() => vi.unstubAllGlobals());

describe('forwarded application browser hand-off', () => {
  it('uses desktop authorisation before opening an application invitation in a fresh browser', async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((done) => (resolve = done)));
    const pending = openBrowserLink(forwarding);
    expect(open).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/cockpit/proxy-grant', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session, port: 3000, path: '/app?x=1#section' }),
    });
    resolve(new Response(JSON.stringify({ url: invitation })));
    await pending;
    expect(open).toHaveBeenCalledExactlyOnceWith(invitation, '_blank', 'noopener,noreferrer');
    expect(open.mock.calls[0]?.[0]).not.toContain(credential);
  });

  it('opens browser cockpit links during the original gesture without requesting a grant', async () => {
    delete window.puddleDesktop;
    const pending = openBrowserLink(forwarding);
    expect(open).toHaveBeenCalledExactlyOnceWith(forwarding, '_blank', 'noopener,noreferrer');
    expect(fetcher).not.toHaveBeenCalled();
    await pending;
  });

  it.each([
    'http://localhost:3000/app',
    'https://example.test/forward/' + session + '/3000',
    'http://localhost:7437' + forwarding,
    'http://localhost.example.test:7436' + forwarding,
  ])('opens an unrelated URL without issuing authority: %s', async (uri) => {
    await openBrowserLink(uri);
    expect(open).toHaveBeenCalledExactlyOnceWith(uri, '_blank', 'noopener,noreferrer');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('defaults a port-strip link to the application root', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ url: invitation })));
    await openBrowserLink(`${origin}/forward/${session}/3000`);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ session, port: 3000, path: '/' });
  });

  it('reports upstream failure without opening a login gate or discarding desktop login', async () => {
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'upstream_unavailable', message: 'Reconnect to Puddle.' },
        }),
        { status: 503 },
      ),
    );
    await expect(openBrowserLink(forwarding)).rejects.toThrow('Reconnect to Puddle.');
    expect(open).not.toHaveBeenCalled();
    expect(tokenStore.get()).toBe(credential);
  });
});
