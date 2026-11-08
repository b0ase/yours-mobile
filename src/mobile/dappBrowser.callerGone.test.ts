/**
 * BRC-219 review (8 Nov 2026), High 1: on the phone, closing the dApp browser left the site's sheet up, and Allow
 * still paid while browserRespond answered into the void. Driven through the real browserRequest / browserClosed
 * handlers of initDappBrowser, with a stand-in for the native shell and a wallet whose payment sheet stays open.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

const ORIGIN = 'https://tokenblaster.lol';
const listeners: Record<string, (x?: unknown) => unknown> = {};
const responses: { requestId: string; response: string }[] = [];
const ports: { name: string; posted: unknown[]; disconnected: boolean }[] = [];
const sent: Record<string, unknown>[] = [];

beforeAll(async () => {
  const m = await import('./dappBrowser');
  m.__setSiteGateForTests(
    { check: async () => 'biometric' as const, lastVerification: () => null },
    () => 60_000, // the bridge ceiling is not what ends this wait
  );
  m.setSiteTimeoutNotifier(async () => ({ success: true, data: { cancelled: 0, committed: false, asking: true } }));
  (m.initDappBrowser as (...a: unknown[]) => void)(
    () => ({
      runtime: {
        // The wallet shows the payment sheet and waits for Allow: this call does not answer on its own.
        sendMessage: (msg: Record<string, unknown>) => {
          sent.push(msg);
          return new Promise(() => undefined);
        },
        connect: ({ name }: { name: string }) => {
          const p = { name, posted: [] as unknown[], disconnected: false };
          ports.push(p);
          return { postMessage: (x: unknown) => p.posted.push(x), disconnect: () => (p.disconnected = true) };
        },
      },
    }),
    {
      isNative: true,
      YoursNative: {
        addListener: async (event: string, fn: (x?: unknown) => unknown) => {
          listeners[event] = fn;
          return { remove: async () => undefined };
        },
        browserRespond: async (r: { requestId: string; response: string }) => {
          responses.push(r);
        },
      },
    },
  );
});

const settledWithin = async <T>(p: Promise<T>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe('phone: the dApp browser closes while its payment sheet is up', () => {
  test('the call is answered ERR_PROMPT_CALLER_GONE, its liveness port closes (the sheet closes), the wait stops', async () => {
    expect(typeof listeners.browserRequest).toBe('function');
    const pending = Promise.resolve(
      listeners.browserRequest?.({
        requestId: 'r1',
        origin: ORIGIN,
        url: `${ORIGIN}/arena`,
        payload: JSON.stringify({
          type: 'createAction',
          params: { description: 'NPG Arena', outputs: [{ lockingScript: '76a914aa88ac', satoshis: 2000 }] },
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    // The call reached the wallet carrying its liveness token, and the port says which token it is.
    expect(sent).toHaveLength(1);
    expect(ports).toHaveLength(1);
    expect(ports[0].posted).toEqual([{ token: sent[0].liveToken }]);
    expect(await settledWithin(pending, 20)).toBe(false); // the sheet is up: still waiting, no clock

    listeners.browserClosed?.();

    expect(await settledWithin(pending, 50)).toBe(true);
    expect(responses).toHaveLength(1);
    expect(JSON.parse(responses[0].response)).toMatchObject({ success: false, code: 'ERR_PROMPT_CALLER_GONE' });
    // The background sees this port disconnect and closes every sheet the call could own before Allow can act.
    expect(ports[0].disconnected).toBe(true);
  });

  test('the next browser session is a new caller: its calls are not ended by the old close', async () => {
    const pending = Promise.resolve(
      listeners.browserRequest?.({
        requestId: 'r2',
        origin: ORIGIN,
        url: `${ORIGIN}/arena`,
        payload: JSON.stringify({ type: 'createAction', params: { description: 'again' } }),
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(await settledWithin(pending, 20)).toBe(false);
    expect(ports[1]?.disconnected).toBe(false);
    listeners.browserClosed?.();
    expect(await settledWithin(pending, 50)).toBe(true);
  });
});
