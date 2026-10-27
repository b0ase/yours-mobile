import { describe, expect, test } from 'bun:test';
import { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import {
  BAD_REQUEST_CODE,
  DISABLED_CODE,
  KEY_MISMATCH_CODE,
  NOT_LINKED_CODE,
  TWETCH_LOGIN,
  TWETCH_POST,
  TWETCH_STATUS,
  handleTwetchCall,
  isTwetchAction,
  sheetText,
  type TwetchAsk,
  type TwetchDeps,
  type TwetchWallet,
} from './twetchCalls';
import { TwetchKeyMismatch, matchingKey, type TwetchLink, type TwetchStore } from './twetchLink';
import { aipMessage, bsmVerifyAddress, dataPushes } from './twetchPost';
import { USER_DENIED_CODE } from '../../services/userDenied';

const ORIGIN = 'https://bchatx.com';
const NOW = 1793083013296;
const CHALLENGE = `twetch-login:${'ab'.repeat(32)}:${NOW}`;

const linkFor = (key: PrivateKey, extra: Partial<TwetchLink> = {}): TwetchLink => ({
  publicKey: key.toPublicKey().toString(),
  address: key.toPublicKey().toAddress(),
  userId: '19',
  name: 'dagashi',
  linkedAt: NOW,
  ...extra,
});

/** In-memory store: `wif` is what decrypts, `link` the public record (mismatch when they differ). */
const fakeStore = (wifKey: PrivateKey, link: TwetchLink | undefined) => {
  const state = { link, sites: [] as string[] };
  const store: TwetchStore = {
    link: () => state.link,
    key: async () => matchingKey(wifKey.toWif(), state.link),
    accountWords: async () => undefined,
    save: async () => undefined,
    addLoginSite: async (o) => {
      state.sites.push(o);
      if (state.link) state.link = { ...state.link, loginSites: [...(state.link.loginSites ?? []), o] };
    },
    forget: async () => undefined,
  };
  return { store, state };
};

/** A wallet whose createAction funds the given output from one 10,000-sat coin (mined, fake proof) and returns
 * AtomicBEEF, like the real noSend path. Nothing is broadcast: there is no network here at all. */
const fakeWallet = (opts: { tamper?: boolean } = {}) => {
  const coinKey = PrivateKey.fromRandom();
  const calls = { create: [] as unknown[], abort: [] as string[] };
  const wallet: TwetchWallet = {
    createAction: async (a: never) => {
      calls.create.push(a);
      const args = a as { outputs: { lockingScript: string; satoshis: number }[]; options: Record<string, unknown> };
      const parent = new Transaction();
      parent.addOutput({ lockingScript: new P2PKH().lock(coinKey.toPublicKey().toAddress()), satoshis: 10_000 });
      parent.merklePath = new MerklePath(900000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
      const tx = new Transaction();
      tx.addInput({
        sourceTransaction: parent,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(coinKey),
      });
      for (const o of args.outputs)
        tx.addOutput({
          lockingScript: LockingScript.fromHex(opts.tamper ? '006a' : o.lockingScript),
          satoshis: o.satoshis,
        });
      tx.addOutput({ lockingScript: new P2PKH().lock(coinKey.toPublicKey().toAddress()), satoshis: 9_800 });
      await tx.sign();
      return { tx: tx.toAtomicBEEF(), txid: tx.id('hex') };
    },
    abortAction: async ({ reference }) => {
      calls.abort.push(reference);
      return { aborted: true };
    },
  };
  return { wallet, calls };
};

const depsFor = (over: Partial<TwetchDeps> & { answer?: boolean } = {}) => {
  const asks: TwetchAsk[] = [];
  const settled: string[] = [];
  const deps: TwetchDeps = {
    store: undefined,
    wallet: undefined,
    bsvUsd: async () => 40,
    proven: true,
    ask: async (a) => {
      asks.push(a);
      return over.answer ?? true;
    },
    settle: (_w, txid) => settled.push(txid),
    now: () => NOW,
    enabled: true,
    ...over,
  };
  return { deps, asks, settled };
};

describe('routing and flag', () => {
  test('exact call names', () => {
    expect([TWETCH_STATUS, TWETCH_LOGIN, TWETCH_POST]).toEqual([
      'twetch.status',
      'twetch.loginSign',
      'twetch.buildPost',
    ]);
    expect(isTwetchAction('twetch.status')).toBe(true);
    expect(isTwetchAction('twetch.signAnything')).toBe(false);
  });
  test('off when the flag is off (store builds)', async () => {
    const { deps } = depsFor({ enabled: false });
    const r = await handleTwetchCall(TWETCH_STATUS, {}, ORIGIN, deps);
    expect(r).toEqual({ error: { code: DISABLED_CODE, message: expect.any(String) } });
  });
});

describe('twetch.status', () => {
  test('not linked', async () => {
    const { deps, asks } = depsFor();
    expect(await handleTwetchCall(TWETCH_STATUS, undefined, ORIGIN, deps)).toEqual({ result: { linked: false } });
    expect(asks).toHaveLength(0);
  });
  test('linked: public facts only, no prompt', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { deps, asks } = depsFor({ store });
    const r = (await handleTwetchCall(TWETCH_STATUS, undefined, ORIGIN, deps)) as { result: Record<string, unknown> };
    expect(r.result).toEqual({
      linked: true,
      handle: 'dagashi',
      userId: '19',
      publicKey: key.toPublicKey().toString(),
    });
    expect(JSON.stringify(r)).not.toContain(key.toWif());
    expect(asks).toHaveLength(0);
  });
});

describe('twetch.loginSign', () => {
  test('asks the first time per site, then signs without a sheet', async () => {
    const key = PrivateKey.fromRandom();
    const { store, state } = fakeStore(key, linkFor(key));
    const { deps, asks } = depsFor({ store });
    const r = (await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, ORIGIN, deps)) as {
      result: { signature: string; publicKey: string; address: string };
    };
    expect(asks).toEqual([{ kind: 'login', host: 'bchatx.com', handle: '@dagashi', proven: true }]);
    expect(sheetText(asks[0]).title).toBe('Sign in to Twetch as @dagashi?');
    expect(r.result.publicKey).toBe(key.toPublicKey().toString());
    expect(r.result.address).toBe(key.toPublicKey().toAddress());
    expect(bsmVerifyAddress(Utils.toArray(CHALLENGE, 'utf8'), r.result.signature, r.result.address)).toBe(true);
    expect(state.sites).toEqual([ORIGIN]);
    await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, ORIGIN, deps);
    expect(asks).toHaveLength(1);
    await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, 'https://other.example', deps);
    expect(asks).toHaveLength(2);
  });
  test('declined: no signature, site not remembered', async () => {
    const key = PrivateKey.fromRandom();
    const { store, state } = fakeStore(key, linkFor(key));
    const { deps } = depsFor({ store, answer: false });
    const r = await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, ORIGIN, deps);
    expect(r).toEqual({ error: { code: USER_DENIED_CODE, message: expect.any(String) } });
    expect(state.sites).toEqual([]);
  });
  test('refuses anything that is not a fresh Twetch challenge, before any sheet', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { deps, asks } = depsFor({ store });
    for (const challenge of [
      'please sign',
      'a'.repeat(10_000),
      `twetch-login:${'ab'.repeat(32)}:${NOW - 3_600_000}`,
      'tw\u0007',
    ]) {
      const r = (await handleTwetchCall(TWETCH_LOGIN, { challenge }, ORIGIN, deps)) as { error: { code: string } };
      expect(r.error.code).toBe(BAD_REQUEST_CODE);
    }
    expect(asks).toHaveLength(0);
  });
  test('not linked', async () => {
    const { deps } = depsFor({ store: fakeStore(PrivateKey.fromRandom(), undefined).store });
    const r = (await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, ORIGIN, deps)) as {
      error: { code: string };
    };
    expect(r.error.code).toBe(NOT_LINKED_CODE);
  });
  test('refuses to sign when the stored key is not the Twetch account key', async () => {
    const stored = PrivateKey.fromRandom();
    const twetchAccount = PrivateKey.fromRandom();
    const { store } = fakeStore(stored, linkFor(twetchAccount));
    const { deps, asks } = depsFor({ store });
    const r = (await handleTwetchCall(TWETCH_LOGIN, { challenge: CHALLENGE }, ORIGIN, deps)) as {
      error: { code: string };
    };
    expect(r.error.code).toBe(KEY_MISMATCH_CODE);
    expect(asks).toHaveLength(0);
  });
});

describe('twetch.buildPost', () => {
  test('builds a noSend tx with the signed post, shows text + fee, returns txHex', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { wallet, calls } = fakeWallet();
    const { deps, asks, settled } = depsFor({ store, wallet });
    const r = (await handleTwetchCall(TWETCH_POST, { text: 'gm Twetch', replyTxid: 'c'.repeat(64) }, ORIGIN, deps)) as {
      result: { txHex: string; txid: string };
    };
    const args = calls.create[0] as { options: Record<string, unknown>; outputs: { satoshis: number }[] };
    expect(args.options.noSend).toBe(true);
    expect(args.outputs).toHaveLength(1);
    expect(args.outputs[0].satoshis).toBe(0); // nothing paid to Twetch
    expect(asks).toEqual([
      {
        kind: 'post',
        host: 'bchatx.com',
        handle: '@dagashi',
        proven: true,
        preview: 'gm Twetch',
        reply: true,
        fee: 'under $0.01',
      },
    ]);
    const t = sheetText(asks[0]);
    expect(t.title).toBe('Reply on Twetch as @dagashi?');
    expect(t.body).toContain('Network fee under $0.01');
    expect(t.body).toContain('Nothing is paid to Twetch');
    const tx = Transaction.fromHex(r.result.txHex);
    expect(tx.id('hex')).toBe(r.result.txid);
    // The post verifies against the Twetch key (AIP), with the ts the call stamped.
    const pushes = dataPushes({ text: 'gm Twetch', replyTxid: 'c'.repeat(64) }, NOW);
    const sig = Utils.toUTF8(Utils.toArray(tx.outputs[0].lockingScript.toHex().slice(-176), 'hex'));
    expect(bsmVerifyAddress(aipMessage(pushes), sig, key.toPublicKey().toAddress())).toBe(true);
    // Handed off: never aborted, watched instead.
    expect(calls.abort).toEqual([]);
    expect(settled).toEqual([r.result.txid]);
  });
  test('declined: the unsent action is aborted (it never left the phone)', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { wallet, calls } = fakeWallet();
    const { deps, settled } = depsFor({ store, wallet, answer: false });
    const r = (await handleTwetchCall(TWETCH_POST, { text: 'no' }, ORIGIN, deps)) as { error: { code: string } };
    expect(r.error.code).toBe(USER_DENIED_CODE);
    expect(calls.abort).toHaveLength(1);
    expect(settled).toEqual([]);
  });
  test('refuses a tx the wallet changed, and aborts it', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { wallet, calls } = fakeWallet({ tamper: true });
    const { deps, asks } = depsFor({ store, wallet });
    const r = (await handleTwetchCall(TWETCH_POST, { text: 'x' }, ORIGIN, deps)) as { error: { message: string } };
    expect(r.error.message).toMatch(/changed the post/);
    expect(asks).toHaveLength(0);
    expect(calls.abort).toHaveLength(1);
  });
  test('refuses oversized text and bad replies before building anything', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { wallet, calls } = fakeWallet();
    const { deps } = depsFor({ store, wallet });
    for (const p of [{ text: 'a'.repeat(25_001) }, { text: 'x', replyTxid: 'zz' }, { text: '' }]) {
      const r = (await handleTwetchCall(TWETCH_POST, p, ORIGIN, deps)) as { error: { code: string } };
      expect(r.error.code).toBe(BAD_REQUEST_CODE);
    }
    expect(calls.create).toHaveLength(0);
  });
  test('key mismatch: nothing built', async () => {
    const { store } = fakeStore(PrivateKey.fromRandom(), linkFor(PrivateKey.fromRandom()));
    const { wallet, calls } = fakeWallet();
    const { deps } = depsFor({ store, wallet });
    const r = (await handleTwetchCall(TWETCH_POST, { text: 'x' }, ORIGIN, deps)) as { error: { code: string } };
    expect(r.error.code).toBe(KEY_MISMATCH_CODE);
    expect(calls.create).toHaveLength(0);
  });
  test('locked wallet', async () => {
    const key = PrivateKey.fromRandom();
    const { store } = fakeStore(key, linkFor(key));
    const { deps } = depsFor({ store });
    const r = (await handleTwetchCall(TWETCH_POST, { text: 'x' }, ORIGIN, deps)) as { error: { code: string } };
    expect(r.error.code).toBe('LOCKED');
  });
});

describe('matchingKey', () => {
  test('throws on mismatch or missing', () => {
    const k = PrivateKey.fromRandom();
    expect(matchingKey(k.toWif(), linkFor(k)).toWif()).toBe(k.toWif());
    expect(() => matchingKey(k.toWif(), linkFor(PrivateKey.fromRandom()))).toThrow(TwetchKeyMismatch);
    expect(() => matchingKey(undefined, linkFor(k))).toThrow(TwetchKeyMismatch);
    expect(() => matchingKey('not a wif', linkFor(k))).toThrow(TwetchKeyMismatch);
  });
});
