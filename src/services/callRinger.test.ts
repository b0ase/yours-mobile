import { describe, expect, test } from 'bun:test';
import { callNotification, callsToAnnounce, CALL_NOTIFICATION_PREFIX } from './callRinger';
import { canPopOutCalls, isCallsWindow, openCallsWindow, pipSupported, startRoute, togglePip } from '../mobile/calls/popout';

describe('background call ringing', () => {
  test('announces only new calls', () => {
    const out = callsToAnnounce([{ id: 'a' }, { id: 'b' }], new Set(['a']), false);
    expect(out.map((c) => c.id)).toEqual(['b']);
  });
  test('stays quiet while a panel or calls window is open (it rings itself)', () => {
    expect(callsToAnnounce([{ id: 'a' }], new Set(), true)).toEqual([]);
  });
  test('notification names the caller without the $', () => {
    const n = callNotification({ id: 'x1', peer_label: '$bchatx' });
    expect(n.id).toBe(`${CALL_NOTIFICATION_PREFIX}x1`);
    expect(n.options.message).toBe('bchatx is calling you on bWalletX');
    expect(n.options.requireInteraction).toBe(true);
  });
  test('unknown caller still rings', () => {
    expect(callNotification({ id: 'x2' }).options.message).toBe('Someone is calling you on bWalletX');
  });
});

describe('calls window', () => {
  test('only the calls route may start a window', () => {
    expect(startRoute('?route=%2Fm%2Fcalls')).toBe('/m/calls');
    expect(startRoute('?route=%2Fsettings')).toBe('/');
    expect(startRoute('')).toBe('/');
    expect(isCallsWindow('?route=/m/calls')).toBe(true);
  });
  test('pop-out only in the extension, and not from the window itself', () => {
    const c = { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` }, windows: { create: () => undefined } };
    expect(canPopOutCalls('', true, c)).toBe(true);
    expect(canPopOutCalls('?route=/m/calls', true, c)).toBe(false);
    expect(canPopOutCalls('', false, c)).toBe(false);
    expect(canPopOutCalls('', true, {})).toBe(false);
  });
  test('opens a small popup window on the calls route', () => {
    let got: Record<string, unknown> | null = null;
    const ok = openCallsWindow({ runtime: { getURL: (p) => `chrome-extension://id/${p}` }, windows: { create: (o) => (got = o) } });
    expect(ok).toBe(true);
    expect(got!.type).toBe('popup');
    expect(String(got!.url)).toBe('chrome-extension://id/index.html?route=%2Fm%2Fcalls');
  });
});

describe('picture-in-picture', () => {
  test('supported only when the document and video allow it', () => {
    const v = { requestPictureInPicture: async () => undefined } as unknown as HTMLVideoElement;
    expect(pipSupported(v, { pictureInPictureEnabled: true } as never)).toBe(true);
    expect(pipSupported(v, { pictureInPictureEnabled: false } as never)).toBe(false);
    expect(pipSupported(null, { pictureInPictureEnabled: true } as never)).toBe(false);
  });
  test('toggles in and out', async () => {
    const calls: string[] = [];
    const v = { requestPictureInPicture: async () => calls.push('in') } as unknown as HTMLVideoElement;
    await togglePip(v, { pictureInPictureElement: null } as never);
    await togglePip(v, { pictureInPictureElement: v, exitPictureInPicture: async () => void calls.push('out') } as never);
    expect(calls).toEqual(['in', 'out']);
  });
});

import { fetchIncoming, resetRingSession, ringProofMessage, RING_ORIGIN } from './callRinger';
import { sessionProofMessage } from '../mobile/calls/api';
import { BCHAT_ORIGIN } from '../mobile/chat/api';

describe('background calls poll', () => {
  test('same session proof and origin as the app', () => {
    expect(ringProofMessage('02ab', 5, 'n')).toBe(sessionProofMessage('02ab', 5, 'n'));
    expect(RING_ORIGIN).toBe(BCHAT_ORIGIN);
  });
  test('signs a session, lists incoming, re-signs once on 401', async () => {
    resetRingSession();
    const seen: string[] = [];
    let lists = 0;
    const f = async (url: string) => {
      seen.push(url.replace(RING_ORIGIN, ''));
      if (url.endsWith('/session')) return { status: 200, json: async () => ({ token: `t${seen.length}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) };
      lists++;
      return lists === 1 ? { status: 401, json: async () => ({}) } : { status: 200, json: async () => ({ incoming: [{ id: 'c1', peer_label: '$x' }] }) };
    };
    const out = await fetchIncoming(f, { identityKey: async () => '02AB', sign: async () => 'sig' });
    expect(out).toEqual([{ id: 'c1', peer_label: '$x' }]);
    expect(seen).toEqual(['/api/bitsign/wallet-calls/session', '/api/bitsign/wallet-calls', '/api/bitsign/wallet-calls/session', '/api/bitsign/wallet-calls']);
  });
});
