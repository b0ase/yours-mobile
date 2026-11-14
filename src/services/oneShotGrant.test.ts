/**
 * b-Aware row 207 (izkalavender 3 Nov 2026; ferimarliadi9 13 Nov, duplicate): the requests the background lets
 * through without a sheet (a pinned site's self-encrypt and mint label, a stream pass) were answered with a 60-second
 * grant. The manager stores protocol grants by site + protocol + counterparty only, so for that minute a decrypt,
 * a signature or an HMAC on the same protocol, any keyID, rode the encrypt's answer with no sheet. Each answer must
 * cover only the request it was decided for.
 *
 * Real LocalWalletPermissionsManager over a ProtoWallet with an in-memory grant store, wrapped with
 * guardSharedKeySigning as initWallet.ts wraps it. The callback plays background.ts: it decides each request and
 * answers with grantPermission (oneUseGrant), or declines it (a sheet the person says No to).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import * as grants from './oneShotGrant';
import { isOneUseAnswer, oneUseGrant } from './oneShotGrant';
import {
  DeferredEncrypts,
  labelCoveredByIntent,
  mintIntentFor,
  ProtocolCalls,
  shouldDeferEncrypt,
  type MintIntent,
} from './pinnedMint';
import { guardSharedKeySigning } from './sharedKeySigning';

const ADMIN = 'admin.bwalletx.invalid';
const SITE = 'bvideox.com';
const PID: [2, string] = [2, 'bvideox records'];
const LABEL = 'bvideox records';
const LABEL_PID: [1, string] = [1, `action label ${LABEL}`];
const bytes = (t: string) => Array.from(new TextEncoder().encode(t));

type Req = {
  requestID: string;
  type: string;
  originator: string;
  protocolID?: [number, string];
  counterparty?: string;
  privileged?: boolean;
  usageType?: string;
};
/** oneUse: let through (what background.ts now answers). window: the 60 s answer before this fix. deny: a No. */
type Answer = 'oneUse' | 'window' | 'deny';

type Wallet = {
  encrypt: (a: unknown, o?: string) => Promise<{ ciphertext: number[] }>;
  decrypt: (a: unknown, o?: string) => Promise<{ plaintext: number[] }>;
  createSignature: (a: unknown, o?: string) => Promise<{ signature: number[] }>;
  createHmac: (a: unknown, o?: string) => Promise<{ hmac: number[] }>;
  ensureLabelAccess: (a: unknown) => Promise<boolean>;
  grantPermission: (p: unknown) => Promise<void>;
  denyPermission: (id: string) => Promise<void>;
};

const setup = (opts: {
  answer: (r: Req, n: number) => Answer;
  /** Runs when a request arrives, before it is answered (a returned promise is awaited first). */
  before?: (r: Req, n: number, wallet: Wallet) => void | Promise<void>;
  /** Every store write waits for this (an IndexedDB write takes a while). */
  gate?: Promise<void>;
}) => {
  const store = new InMemoryPermissionStore();
  const put = store.putGrant.bind(store);
  const writes: unknown[] = [];
  store.putGrant = async (g) => {
    writes.push(g);
    if (opts.gate) await opts.gate;
    return put(g);
  };
  const keys = new ProtoWallet(PrivateKey.fromRandom());
  const underlying = {
    encrypt: (a: never, o?: string) => keys.encrypt(a, o),
    decrypt: (a: never, o?: string) => keys.decrypt(a, o),
    createSignature: (a: never, o?: string) => keys.createSignature(a, o),
    createHmac: (a: never, o?: string) => keys.createHmac(a, o),
    getPublicKey: (a: never, o?: string) => keys.getPublicKey(a, o),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }), // no on-chain permission tokens
  };
  const mgr = new LocalWalletPermissionsManager(underlying as never, ADMIN, {}, { store });
  const wallet = guardSharedKeySigning(mgr, { adminOriginator: ADMIN }) as unknown as Wallet;
  const asked: Req[] = [];
  mgr.bindCallback('onProtocolPermissionRequested', (async (r: Req) => {
    asked.push(r);
    const n = asked.length;
    const pre = opts.before?.(r, n, wallet);
    if (pre) await pre;
    const a = opts.answer(r, n);
    if (a === 'deny') return void (await wallet.denyPermission(r.requestID));
    await wallet.grantPermission(
      a === 'oneUse'
        ? oneUseGrant(r.requestID)
        : { requestID: r.requestID, ephemeral: true, expiry: Math.floor(Date.now() / 1000) + 60 },
    );
  }) as never);
  return { wallet, store, asked, writes };
};

const encryptArgs = (keyID: string, text = 'video record') => ({
  protocolID: PID,
  keyID,
  counterparty: 'self',
  plaintext: bytes(text),
});
const firstOnly =
  (kind: 'oneUse' | 'window') =>
  (_r: Req, n: number): Answer =>
    n === 1 ? kind : 'deny';

describe('a let-through encrypt covers that encrypt only (row 207)', () => {
  test('control, the old 60 s answer: a decrypt of the same records rides it with no sheet', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('window') });
    const { ciphertext } = await wallet.encrypt(encryptArgs('1'), SITE);
    const out = await wallet.decrypt({ protocolID: PID, keyID: '1', counterparty: 'self', ciphertext }, SITE);
    expect(out.plaintext).toEqual(bytes('video record'));
    expect(asked.length).toBe(1); // the hole this fix closes
  });

  test('a decrypt right after asks again, and a No refuses it', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('oneUse') });
    const { ciphertext } = await wallet.encrypt(encryptArgs('1'), SITE);
    await expect(
      wallet.decrypt({ protocolID: PID, keyID: '1', counterparty: 'self', ciphertext }, SITE),
    ).rejects.toThrow();
    expect(asked.length).toBe(2);
  });

  test('a signature and an HMAC on the protocol, any keyID, ask again too', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('oneUse') });
    await wallet.encrypt(encryptArgs('1'), SITE);
    await expect(
      wallet.createSignature({ protocolID: PID, keyID: 'other', counterparty: 'self', data: bytes('x') }, SITE),
    ).rejects.toThrow();
    await expect(
      wallet.createHmac({ protocolID: PID, keyID: 'other', counterparty: 'self', data: bytes('x') }, SITE),
    ).rejects.toThrow();
    expect(asked.length).toBe(3);
  });

  test('a second encrypt inside the old minute comes back to be judged again', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('oneUse') });
    await wallet.encrypt(encryptArgs('1'), SITE);
    await expect(wallet.encrypt(encryptArgs('2'), SITE)).rejects.toThrow();
    expect(asked.length).toBe(2);
  });

  test('nothing is written to the grant store', async () => {
    const { wallet, writes, store } = setup({ answer: firstOnly('oneUse') });
    await wallet.encrypt(encryptArgs('1'), SITE);
    expect(writes.length).toBe(0);
    expect(await store.listGrants()).toEqual([]);
  });

  test('no other call joins the request while the answer is on its way', async () => {
    // A decrypt shares an encrypt's request key (same protocol, counterparty and usage type), so a decrypt arriving
    // while the answer still waits for its store write would be released by it. The one-use answer writes nothing.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let decrypting: Promise<unknown> | undefined;
    const { wallet, asked } = setup({
      gate,
      answer: firstOnly('oneUse'),
      before: (_r, n, w) => {
        if (n !== 1) return;
        decrypting = w.decrypt({ protocolID: PID, keyID: '1', counterparty: 'self', ciphertext: [1, 2, 3] }, SITE);
        setTimeout(open, 100); // the store write, if any, finishes well after the decrypt reached the manager
      },
    });
    await wallet.encrypt(encryptArgs('1'), SITE);
    await expect(decrypting).rejects.toThrow('Permission denied');
    expect(asked.length).toBe(2);
  });

  test('a standing grant given meanwhile on a sheet is not overwritten by the one-use answer', async () => {
    const key = {
      type: 'protocol' as const,
      originator: SITE,
      privileged: false,
      protocolLevel: 2 as const,
      protocolName: PID[1],
      counterparty: 'self',
    };
    const { wallet, store } = setup({
      answer: firstOnly('oneUse'),
      // The mint sheet's "open my records later" line approved while this encrypt was waiting.
      before: (_r, n) => (n === 1 ? store.putGrant({ key, expiry: 0, grantedAt: Date.now() }) : undefined),
    });
    await wallet.encrypt(encryptArgs('1'), SITE);
    expect((await store.findGrant(key))?.expiry).toBe(0);
  });
});

describe("a mint's let-through label covers that label check only", () => {
  test('control, the old 60 s answer: a level-1 decrypt under the label name rides it', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('window') });
    await wallet.ensureLabelAccess({ originator: SITE, label: LABEL, usageType: 'apply' });
    await wallet
      .decrypt({ protocolID: LABEL_PID, keyID: '1', counterparty: 'self', ciphertext: [1, 2, 3] }, SITE)
      .catch(
        (e: Error) => expect(e.message).not.toContain('Permission denied'), // got past the permission check
      );
    expect(asked.length).toBe(1);
  });

  test('a level-1 call under the label name, or the next label check, asks again', async () => {
    const { wallet, asked } = setup({ answer: firstOnly('oneUse') });
    expect(await wallet.ensureLabelAccess({ originator: SITE, label: LABEL, usageType: 'apply' })).toBe(true);
    await expect(
      wallet.decrypt({ protocolID: LABEL_PID, keyID: '1', counterparty: 'self', ciphertext: [1, 2, 3] }, SITE),
    ).rejects.toThrow('Permission denied');
    await expect(wallet.ensureLabelAccess({ originator: SITE, label: LABEL, usageType: 'apply' })).rejects.toThrow();
    expect(asked.length).toBe(3);
  });
});

describe('the pinned mint still needs no sheet for its encrypts and label (callers keep working)', () => {
  test("bvideox.com: 3 encrypts and the action's label go through, then a decrypt still asks", async () => {
    const calls = new ProtocolCalls();
    const deferred = new DeferredEncrypts();
    const intent = mintIntentFor(SITE, {
      description: 'bVideoX: 3 private video records',
      labels: [LABEL],
      outputs: [{ satoshis: 0 }, { satoshis: 0 }, { satoshis: 0 }, { satoshis: 3600 }],
      options: { spendingAuthorization: { protocolID: PID } },
    }) as MintIntent & { spendSeen?: boolean };
    expect(intent).not.toBeNull();
    const sheets: Req[] = [];
    // background.ts showPermissionPrompt's pinned-mint branch; anything else is a sheet (here: the person says No).
    const { wallet, asked } = setup({
      answer: (r) => {
        const now = Date.now();
        if (shouldDeferEncrypt(r, calls, deferred, now)) {
          deferred.note(r.originator, r.protocolID as [number, string], now);
          return 'oneUse';
        }
        if (!intent.spendSeen && labelCoveredByIntent(r, intent)) return 'oneUse';
        sheets.push(r);
        return 'deny';
      },
    });
    // The site's calls go through the router, which notes each one (background.ts trackProtocolCall).
    const tracked = async <T>(method: string, args: unknown, run: () => Promise<T>) => {
      const end = calls.start(method, SITE, args);
      try {
        return await run();
      } finally {
        end();
      }
    };
    const records: number[][] = [];
    for (const k of ['v1', 'v2', 'v3']) {
      const a = encryptArgs(k, `record ${k}`);
      records.push((await tracked('encrypt', a, () => wallet.encrypt(a, SITE))).ciphertext);
    }
    expect(await wallet.ensureLabelAccess({ originator: SITE, label: LABEL, usageType: 'apply' })).toBe(true);
    expect(sheets.length).toBe(0); // one sheet for the whole mint: its spend (not modelled here)
    expect(asked.length).toBe(4); // each request judged on its own, none answered by an earlier one
    intent.spendSeen = true; // the spend reached its sheet: nothing more is let through
    const d = { protocolID: PID, keyID: 'v1', counterparty: 'self', ciphertext: records[0] };
    await expect(tracked('decrypt', d, () => wallet.decrypt(d, SITE))).rejects.toThrow('Permission denied');
    expect(sheets.length).toBe(1);
  });
});

describe('no time-window answer is left', () => {
  const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');

  test('oneShotGrant is gone from the helper module and from background.ts', () => {
    expect(grants).not.toHaveProperty('oneShotGrant');
    expect(grants).not.toHaveProperty('ONE_SHOT_SECONDS');
    expect(/\boneShotGrant\s*\(/.test(bg)).toBe(false);
    expect(/import\s*\{[^}]*\boneShotGrant\b/.test(bg)).toBe(false);
  });

  test('the pinned-mint branch answers its encrypt and its label with oneUseGrant', () => {
    const at = bg.indexOf('if (mintSite && accountContext?.wallet) {');
    const branch = bg.slice(at, bg.indexOf('// A stream-approved createAction', at));
    expect(branch.split('grantPermission(oneUseGrant(request.requestID))').length - 1).toBe(2);
    expect(branch).not.toMatch(/grantPermission\((?!oneUseGrant)/);
  });

  test('the stream-pass branch answers with oneUseGrant', () => {
    const at = bg.indexOf('passCovers(pass, {');
    const branch = bg.slice(at, bg.indexOf('}\n', at));
    expect(branch).toContain('grantPermission(oneUseGrant(request.requestID))');
  });

  test('oneUseGrant is marked one-use and, unguarded, already expired', () => {
    const g = oneUseGrant('r1');
    expect(g).toMatchObject({ requestID: 'r1', ephemeral: true, expiry: 1 });
    expect(isOneUseAnswer(g)).toBe(true);
    expect(isOneUseAnswer({ requestID: 'r1', expiry: 0 })).toBe(false);
  });
});
