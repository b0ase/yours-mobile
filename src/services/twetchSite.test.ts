import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { routeTwetchMessage } from './twetchSite';
import { DISABLED_CODE, type TwetchAsk, type TwetchDeps, type TwetchWallet } from '../mobile/twetch/twetchCalls';
import { matchingKey, type TwetchLink, type TwetchStore } from '../mobile/twetch/twetchLink';
import { USER_DENIED_CODE } from './userDenied';
import { attachTwetch } from '../twetchPage';

const NOW = 1793083013296;
const CHALLENGE = `twetch-login:${'ab'.repeat(32)}:${NOW}`;
const key = PrivateKey.fromRandom();
const link: TwetchLink = {
  publicKey: key.toPublicKey().toString(),
  address: key.toPublicKey().toAddress(),
  userId: '19',
  name: 'dagashi',
  linkedAt: NOW,
};

const fakeStore = () => {
  const state = { link: { ...link } as TwetchLink, sites: [] as string[] };
  const store: TwetchStore = {
    link: () => state.link,
    key: async () => matchingKey(key.toWif(), state.link),
    accountWords: async () => undefined,
    save: async () => undefined,
    addLoginSite: async (o) => {
      state.sites.push(o);
      state.link = { ...state.link, loginSites: [...(state.link.loginSites ?? []), o] };
    },
    forget: async () => undefined,
  };
  return { store, state };
};

/** noSend-style createAction returning AtomicBEEF from a fake mined coin. No network anywhere. */
const fakeWallet = () => {
  const coin = PrivateKey.fromRandom();
  const calls = { create: 0, abort: [] as string[] };
  const wallet: TwetchWallet = {
    createAction: async (a: never) => {
      calls.create++;
      const args = a as { outputs: { lockingScript: string; satoshis: number }[] };
      const parent = new Transaction();
      parent.addOutput({ lockingScript: new P2PKH().lock(coin.toPublicKey().toAddress()), satoshis: 10_000 });
      parent.merklePath = new MerklePath(900000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
      const tx = new Transaction();
      tx.addInput({
        sourceTransaction: parent,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(coin),
      });
      for (const o of args.outputs)
        tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
      tx.addOutput({ lockingScript: new P2PKH().lock(coin.toPublicKey().toAddress()), satoshis: 9_800 });
      await tx.sign();
      return { tx: tx.toAtomicBEEF(), txid: tx.id('hex') };
    },
    abortAction: async ({ reference }) => {
      calls.abort.push(reference);
      return {};
    },
  };
  return { wallet, calls };
};

const setup = (answer: boolean, extra: Partial<TwetchDeps> = {}) => {
  const { store, state } = fakeStore();
  const { wallet, calls } = fakeWallet();
  const asks: TwetchAsk[] = [];
  const built: string[] = [];
  const deps = async (action: string) => {
    built.push(action);
    return {
      store,
      wallet,
      bsvUsd: async () => 50,
      ask: async (a: TwetchAsk) => {
        asks.push(a);
        return answer;
      },
      settle: () => undefined,
      now: () => NOW,
      enabled: true,
      ...extra,
    };
  };
  return { deps, asks, calls, state, built };
};

const SITE = { origin: 'https://bchatx.com', isFromExtension: false };

describe('twetch.* through the extension bridge', () => {
  test('status routes to twetchCalls with no sheet', async () => {
    const s = setup(true);
    const r = await routeTwetchMessage({ action: 'twetch.status', params: {} }, SITE, s.deps);
    expect(r).toEqual({
      success: true,
      data: { linked: true, handle: 'dagashi', userId: '19', publicKey: link.publicKey },
    });
    expect(s.asks).toHaveLength(0);
  });

  test('loginSign: origin comes from the sender, never the page; sheet the first time only', async () => {
    const s = setup(true);
    const msg = {
      action: 'twetch.loginSign',
      originator: 'evil.example',
      params: { challenge: CHALLENGE, domain: 'evil.example' },
    };
    const r1 = await routeTwetchMessage(msg, SITE, s.deps);
    expect(r1.success).toBe(true);
    expect(s.asks).toEqual([{ kind: 'login', host: 'bchatx.com', handle: '@dagashi', proven: true }]);
    expect(s.state.sites).toEqual(['https://bchatx.com']);
    await routeTwetchMessage(msg, SITE, s.deps);
    expect(s.asks).toHaveLength(1);
    // Another site asks again.
    await routeTwetchMessage(msg, { origin: 'https://other.example', isFromExtension: false }, s.deps);
    expect(s.asks).toHaveLength(2);
    expect(s.asks[1].host).toBe('other.example');
  });

  test('buildPost needs the sheet every time; a decline aborts and answers ERR_PERMISSION_DENIED', async () => {
    const s = setup(false);
    const r = await routeTwetchMessage({ action: 'twetch.buildPost', params: { text: 'gm' } }, SITE, s.deps);
    expect(r).toMatchObject({ success: false, code: USER_DENIED_CODE, status: 403 });
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]).toMatchObject({ kind: 'post', host: 'bchatx.com', preview: 'gm' });
    expect(s.calls.abort).toHaveLength(1);
  });

  test('buildPost approved returns the unsent txHex and txid', async () => {
    const s = setup(true);
    const r = await routeTwetchMessage({ action: 'twetch.buildPost', params: { text: 'gm' } }, SITE, s.deps);
    expect(r.success).toBe(true);
    const d = (r as { data: { txHex: string; txid: string } }).data;
    expect(Transaction.fromHex(d.txHex).id('hex')).toBe(d.txid);
    expect(s.calls.abort).toHaveLength(0);
  });

  test('bad params keep the paired error codes', async () => {
    const s = setup(true);
    const r = await routeTwetchMessage({ action: 'twetch.loginSign', params: { challenge: 'sign me' } }, SITE, s.deps);
    expect(r).toMatchObject({ success: false, code: 'INVALID_PARAMS' });
    expect(s.asks).toHaveLength(0);
  });

  test('flag off → NOT_SUPPORTED, no sheet', async () => {
    const s = setup(true, { enabled: false });
    for (const action of ['twetch.status', 'twetch.loginSign', 'twetch.buildPost']) {
      const r = await routeTwetchMessage({ action, params: { challenge: CHALLENGE, text: 'gm' } }, SITE, s.deps);
      expect(r).toMatchObject({ success: false, code: DISABLED_CODE });
    }
    expect(s.asks).toHaveLength(0);
  });

  test('extension pages, insecure and missing origins are refused before the wallet is touched', async () => {
    const s = setup(true);
    const msg = { action: 'twetch.status', params: {} };
    expect(
      (await routeTwetchMessage(msg, { origin: 'chrome-extension://x', isFromExtension: true }, s.deps)).success,
    ).toBe(false);
    expect(
      (await routeTwetchMessage(msg, { origin: 'http://bchatx.com', isFromExtension: false }, s.deps)).success,
    ).toBe(false);
    expect((await routeTwetchMessage(msg, { origin: undefined, isFromExtension: false }, s.deps)).success).toBe(false);
    expect(s.built).toHaveLength(0);
  });

  test('page side: window.CWI.twetch.* sends the twetch.* actions through the provider transport', async () => {
    const sent: [string, unknown][] = [];
    const cwi: Record<string, unknown> = {};
    attachTwetch(cwi, async (a, p) => {
      sent.push([a, p]);
      return null;
    });
    const t = cwi.twetch as Record<string, (p?: unknown) => Promise<unknown>>;
    await t.status();
    await t.loginSign({ challenge: CHALLENGE });
    await t.buildPost({ text: 'gm' });
    expect(sent).toEqual([
      ['twetch.status', {}],
      ['twetch.loginSign', { challenge: CHALLENGE }],
      ['twetch.buildPost', { text: 'gm' }],
    ]);
  });

  test('wiring: content script forwards, background routes and shows the twetch sheet', () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(src('../content.ts')).toContain('isTwetchAction(type)');
    // The extension's page-side wallet is brand/cwi.ts (vite.brand.ts swaps it in for cwi.ts): both attach it.
    expect(src('../brand/cwi.ts')).toContain('attachTwetch(CWI');
    expect(src('../cwi.ts')).toContain('attachTwetch(CWI');
    const bg = src('../background.ts');
    expect(bg).toContain('routeTwetchMessage(message, { origin: sender.origin, isFromExtension }');
    expect(bg).toContain("showPromptUi('twetch', requestID)");
    expect(bg).toContain("message?.action === 'TWETCH_RESPONSE'");
    expect(src('../prompt-tab.tsx')).toContain("screen.kind === 'twetch'");
  });
});
