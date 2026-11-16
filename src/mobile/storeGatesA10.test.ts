import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { BSV20, BSV21, OrdLockV2, buildInscriptionScript } from '@1sat/templates';
import {
  STORE_MARKET_REFUSAL,
  guardStoreMarketActions,
  scriptKind,
  storeInternalizeRefusal,
  storeMarketRefusal,
  storedInputScript,
  type StoreMarketDeps,
} from '../services/storeMarketGate';

/**
 * Round A10 (review of A8 + A9, findings R1, R2, R3; 16 Nov 2026). Store build only; bWalletX behaviour unchanged.
 * The gate is only ever wrapped in a store build (initWallet.ts, the literal SITE_MARKET_ACTIONS_ENABLED), so the
 * bWalletX side is shown by the edition checks below, run in child processes as in storeGatesA9.test.ts.
 */
const STORE_ENVS = [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }];
const ROOT = new URL('../..', import.meta.url).pathname;
const srcOf = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const run = <T>(code: string, env: Record<string, string>): T => {
  const r = Bun.spawnSync(['bun', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
  });
  const out = r.stdout.toString().trim().split('\n').pop() ?? '';
  if (!out) throw new Error(r.stderr.toString());
  return JSON.parse(out) as T;
};

// ---- Fixtures: the reviewer's probe shapes (review-store-gates-a8-a9.md, scratch r89/probe*.ts) ----
const ADMIN = 'wallet-admin-originator';
const SITE = 'www.bchatx.com';
const me = new PrivateKey(7).toAddress();
const seller = new PrivateKey(8).toAddress();
const house = new PrivateKey(9).toAddress();
const p2pkh = (a: string) => new P2PKH().lock(a).toHex();
const lockTo = (a: string) => new P2PKH().lock(a);

/** A seller's listing transaction: output 0 is an OrdLock v2 for 5000 sats. */
const listingTx = new Transaction();
listingTx.addOutput({ lockingScript: OrdLockV2.lock(seller, seller, 5000), satoshis: 1 });
const LISTING_TXID = listingTx.id('hex');
const LISTING = `${LISTING_TXID}.0`;
const BUY_OUTS = [
  { lockingScript: p2pkh(me), satoshis: 1, outputDescription: 'item' },
  { lockingScript: p2pkh(seller), satoshis: 5000, outputDescription: 'seller' },
];
const BUY_IN = [{ outpoint: LISTING, inputDescription: 'listing', unlockingScriptLength: 500 }];
const txidOnly = new Beef();
txidOnly.mergeTxidOnly(LISTING_TXID);
/** R1 B: the listing as a txid-only BEEF entry with trustSelf 'known' (the toolbox reads the script from storage). */
const BUY_TXID_ONLY = {
  description: 'x',
  inputBEEF: txidOnly.toBinary(),
  inputs: BUY_IN,
  outputs: BUY_OUTS,
  options: { trustSelf: 'known', signAndProcess: false },
};
/** R1 C: no BEEF at all; the listing tx is in the wallet's storage (staged with internalizeAction). */
const BUY_NO_BEEF = { description: 'x', inputs: BUY_IN, outputs: BUY_OUTS, options: { signAndProcess: false } };
/** R1 D: as C, with the item going to the site's own basket. */
const BUY_NO_BEEF_FOO = { ...BUY_NO_BEEF, outputs: [{ ...BUY_OUTS[0], basket: 'foo' }, BUY_OUTS[1]] };

const deploy21 = BSV21.deployMint('MEME', 1000000000n, 0).lock(lockTo(me)).toHex();
const deployTb = BSV21.deployMint('MEME', 1000000000n, 0, '_0').lock(lockTo(me)).toHex();
const deployAuth = BSV21.deployAuth('MEME', 0).lock(lockTo(me)).toHex();
const mint21 = BSV21.mint(`${'b'.repeat(64)}_0`, 1000n)
  .lock(lockTo(me))
  .toHex();
const deploy20 = BSV20.deploy('MEME', 21000000n, 0, 1000n).lock(lockTo(me)).toHex();
const mint20 = BSV20.mint('PEPE', 1000n).lock(lockTo(me)).toHex();
const image = buildInscriptionScript(lockTo(me), Utils.toArray('img', 'utf8'), 'image/png').toHex();
const TOKEN = `${'a'.repeat(64)}_0`;
const transfer21 = (to: string) => BSV21.transfer(TOKEN, 10n).lock(lockTo(to)).toHex();
/** bsv-20 content in an ord envelope that no decoder reads (content type in capitals, amt 0): fails closed. */
const oddToken = buildInscriptionScript(
  lockTo(me),
  Utils.toArray('{"p":"bsv-20","op":"deploy+mint","sym":"X","amt":"0"}', 'utf8'),
  'Application/BSV-20',
).toHex();

const out = (lockingScript: string, extra: Record<string, unknown> = {}) => ({ lockingScript, satoshis: 1, ...extra });
const fee = { lockingScript: p2pkh(house), satoshis: 5000 };
/** The reviewer's R2 probes (probe2/3/4): a deploy or mint next to an output into '1sat', with and without a fee. */
const R2_PROBES: [string, unknown][] = [
  ['image → 1sat + BSV-21 deploy+mint (free launch)', { outputs: [out(image, { basket: '1sat' }), out(deployTb)] }],
  ['P2PKH → 1sat + BSV-21 deploy+mint', { outputs: [out(p2pkh(me), { basket: '1sat' }), out(deploy21)] }],
  ['P2PKH → 1sat + BSV-20 mint', { outputs: [out(p2pkh(me), { basket: '1sat' }), out(mint20)] }],
  ['BSV-21 deploy+mint, unbasketed', { outputs: [out(deploy21)] }],
  ['BSV-21 deploy+mint into 1sat', { outputs: [out(deploy21, { basket: '1sat' })] }],
  ['BSV-20 deploy into 1sat', { outputs: [out(deploy20, { basket: '1sat' })] }],
  ['BSV-20 mint into 1sat', { outputs: [out(mint20, { basket: '1sat' })] }],
  ['TokenBlaster launch as shipped', { labels: ['tokenblaster', 'launch'], outputs: [out(image), out(deployTb), fee] }],
  ['TB launch, image into 1sat + fee', { outputs: [out(image, { basket: '1sat' }), out(deployTb), fee] }],
  ['BSV-21 deploy+auth', { outputs: [out(image, { basket: '1sat' }), out(deployAuth)] }],
  ['BSV-21 mint', { outputs: [out(p2pkh(me), { basket: '1sat' }), out(mint21)] }],
  ['bsv-20 content no decoder reads', { outputs: [out(p2pkh(me), { basket: '1sat' }), out(oddToken)] }],
];

/** A wallet whose every method records the call: proves a refused action reached nothing. */
const recorder = () => {
  const calls: { method: string; args: unknown; originator?: unknown }[] = [];
  const wallet = {
    createAction: async (args: unknown, originator?: unknown) => {
      calls.push({ method: 'createAction', args, originator });
      return { txid: 'f'.repeat(64) };
    },
    internalizeAction: async (args: unknown, originator?: unknown) => {
      calls.push({ method: 'internalizeAction', args, originator });
      return { accepted: true };
    },
  };
  return { wallet, calls };
};

/** The wallet's storage as the backstop reads it: output rows by outpoint, raw transactions by txid. */
const storage = (rows: Record<string, string> = {}, raws: Transaction[] = []) =>
  storedInputScript({
    outputScript: async (txid, vout) => rows[`${txid}.${vout}`],
    rawTx: async (txid) => raws.find((t) => t.id('hex') === txid)?.toBinary(),
  });
/** Backstop deps: no held asset coins, and the listing staged in storage as a raw tx (R1's staging step). */
const staged: StoreMarketDeps = { assetOutpoints: async () => new Set(), inputScript: storage({}, [listingTx]) };

const backstop = (deps: StoreMarketDeps) => {
  const r = recorder();
  guardStoreMarketActions(r.wallet, { adminOriginator: ADMIN, ...deps });
  return r;
};

describe('A10 R1: a purchase whose listing is not in the BEEF in full is read from storage and refused', () => {
  const SHAPES: [string, unknown][] = [
    ['B: txid-only BEEF entry + trustSelf "known"', BUY_TXID_ONLY],
    ['C: no BEEF, listing tx in the wallet’s storage', BUY_NO_BEEF],
    ['D: no BEEF, item into the site’s own basket', BUY_NO_BEEF_FOO],
  ];
  for (const [name, args] of SHAPES) {
    test(`refused by the backstop, nothing reaches the wallet: ${name}`, async () => {
      expect(await storeMarketRefusal(args, staged)).toBe('ordlock');
      const { wallet, calls } = backstop(staged);
      await expect(wallet.createAction(args, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
      expect(calls).toEqual([]);
    });
    test(`refused when the listing sits in an output row (internalized into a site basket): ${name}`, async () => {
      const rows = { [LISTING]: OrdLockV2.lock(seller, seller, 5000).toHex() };
      expect(
        await storeMarketRefusal(args, { assetOutpoints: async () => new Set(), inputScript: storage(rows) }),
      ).toBe('ordlock');
    });
  }
  test('fails closed: a coin neither the BEEF nor storage has, or a storage read that throws', async () => {
    const none = { assetOutpoints: async () => new Set<string>(), inputScript: storage() };
    expect(await storeMarketRefusal(BUY_NO_BEEF, none)).toBe('unclassified');
    expect(await storeMarketRefusal(BUY_TXID_ONLY, none)).toBe('unclassified');
    const throws = {
      assetOutpoints: async () => new Set<string>(),
      inputScript: async (): Promise<string | null> => {
        throw new Error('storage down');
      },
    };
    expect(await storeMarketRefusal(BUY_NO_BEEF, throws)).toBe('unclassified');
  });
  test('a 1Sat asset or a token deploy read from storage is refused (the user’s own asset is not moved by a site)', async () => {
    const ins = (script: string) => ({
      assetOutpoints: async () => new Set<string>(),
      inputScript: storage({ [LISTING]: script }),
    });
    expect(await storeMarketRefusal(BUY_NO_BEEF, ins(image))).toBe('held-asset');
    expect(await storeMarketRefusal(BUY_NO_BEEF, ins(transfer21(me)))).toBe('held-asset');
    expect(await storeMarketRefusal(BUY_NO_BEEF, ins(deploy21))).toBe('token-mint');
  });
  test('a wallet-held asset coin is refused even when the site also puts its transaction in the BEEF', async () => {
    const coin = new Transaction();
    coin.addOutput({ lockingScript: Script.fromHex(transfer21(me)), satoshis: 1 });
    const beef = new Beef();
    beef.mergeRawTx(coin.toBinary());
    const op = `${coin.id('hex')}.0`;
    const sell = {
      description: 'Sell',
      inputBEEF: beef.toBinary(),
      inputs: [{ outpoint: op, unlockingScriptLength: 108 }],
      outputs: [out(transfer21(seller)), { lockingScript: p2pkh(me), satoshis: 4000 }],
    };
    expect(await storeMarketRefusal(sell, { assetOutpoints: async () => new Set([op]) })).toBe('held-asset');
    // And a site action that spends coins needs that lookup: a failing one refuses.
    const failing = {
      assetOutpoints: async (): Promise<Set<string>> => {
        throw new Error('storage down');
      },
    };
    expect(await storeMarketRefusal(sell, failing)).toBe('unclassified');
  });
  test('still passes: a site spending its own plain coin by outpoint, read from storage (a site-basket coin)', async () => {
    const pay = {
      description: 'Tip',
      inputs: [{ outpoint: LISTING, unlockingScriptLength: 108 }],
      outputs: [{ lockingScript: p2pkh(seller), satoshis: 1000 }],
      options: { trustSelf: 'known' },
    };
    const deps = { assetOutpoints: async () => new Set<string>(), inputScript: storage({ [LISTING]: p2pkh(me) }) };
    expect(await storeMarketRefusal(pay, deps)).toBeNull();
    const { wallet, calls } = backstop(deps);
    await wallet.createAction(pay, SITE);
    expect(calls).toEqual([{ method: 'createAction', args: pay, originator: SITE }]);
  });
  test('the page side (no wallet) leaves these to the backstop, exactly as in A9', async () => {
    for (const args of [BUY_TXID_ONLY, BUY_NO_BEEF, BUY_NO_BEEF_FOO]) expect(await storeMarketRefusal(args)).toBeNull();
  });
  test('the wallet’s own (admin) actions are never gated', async () => {
    const { wallet, calls } = backstop(staged);
    await wallet.createAction(BUY_NO_BEEF, ADMIN);
    expect(calls.length).toBe(1);
  });
});

describe('A10 R1: storedInputScript reads a coin the way wallet-toolbox does', () => {
  test('the output row first, else the stored raw transaction, else null', async () => {
    const other = p2pkh(me);
    expect(await storage({ [LISTING]: other }, [listingTx])(LISTING)).toBe(other);
    expect(await storage({}, [listingTx])(LISTING)).toBe(OrdLockV2.lock(seller, seller, 5000).toHex());
    expect(await storage({}, [listingTx])(`${LISTING_TXID}.7`)).toBeNull();
    expect(await storage()(LISTING)).toBeNull();
  });
  test('an output row holding bytes, or an empty row, are read as the toolbox would', async () => {
    const bytes = storedInputScript({
      outputScript: async () => Utils.toArray(p2pkh(me), 'hex'),
      rawTx: async () => undefined,
    });
    expect(await bytes(LISTING)).toBe(p2pkh(me));
    const empty = storedInputScript({ outputScript: async () => [], rawTx: async () => listingTx.toBinary() });
    expect(scriptKind(await empty(LISTING))).toBe('ordlock');
  });
  test('initWallet wires it in the store wrapper only: the account’s output row, else localRawTx', () => {
    const s = srcOf('../initWallet.ts');
    const at = s.indexOf(
      '  const wallet = SITE_MARKET_ACTIONS_ENABLED\n    ? siteWallet\n    : guardStoreMarketActions(',
    );
    expect(at).toBeGreaterThan(0);
    const wiring = s.slice(at, s.indexOf('      });\n', at));
    expect(wiring).toContain('inputScript: storedInputScript({');
    expect(wiring).toContain('const rows = await sp.findOutputs({ partial: { userId, txid, vout } });');
    expect(wiring).toContain('rawTx: localRawTx,');
    expect(s.match(/storedInputScript\(/g)?.length).toBe(1);
  });
});

describe('A10 R1 + R2: a site’s internalizeAction is gated in a store build', () => {
  const atomic = (...scripts: string[]) => {
    const tx = new Transaction();
    for (const s of scripts) tx.addOutput({ lockingScript: Script.fromHex(s), satoshis: 1 });
    return tx.toAtomicBEEF();
  };
  const insert = (basket: string, customInstructions?: string) => ({
    outputIndex: 0,
    protocol: 'basket insertion',
    insertionRemittance: { basket, ...(customInstructions ? { customInstructions } : {}) },
  });
  const REFUSED: [string, unknown, string][] = [
    [
      'staging a listing: an OrdLock into the site’s basket',
      { tx: atomic(OrdLockV2.lock(seller, seller, 5000).toHex()), outputs: [insert('foo')] },
      'ordlock',
    ],
    ['a BSV-21 deploy+mint into bsv21', { tx: atomic(deploy21), outputs: [insert('bsv21')] }, 'token-mint'],
    ['a BSV-20 mint into a site basket', { tx: atomic(mint20), outputs: [insert('foo')] }, 'token-mint'],
    [
      'anything recorded to the site-token deploy key',
      { tx: atomic(p2pkh(me)), outputs: [insert('bsv21', JSON.stringify({ keyID: 'deploy-1763251200000' }))] },
      'token-mint',
    ],
    ['a transaction the gate cannot read', { tx: [1, 2, 3], outputs: [insert('foo')] }, 'unclassified'],
    [
      'an output index the transaction does not have',
      { tx: atomic(p2pkh(me)), outputs: [{ outputIndex: 3 }] },
      'unclassified',
    ],
  ];
  for (const [name, args, why] of REFUSED)
    test(`refused, nothing reaches the wallet: ${name}`, async () => {
      expect(storeInternalizeRefusal(args)).toBe(why as never);
      const { wallet, calls } = backstop(staged);
      await expect(wallet.internalizeAction(args, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
      expect(calls).toEqual([]);
    });
  const PASSED: [string, unknown][] = [
    [
      'a payment to the wallet',
      { tx: atomic(p2pkh(me)), outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: {} }] },
    ],
    [
      'tokens delivered into bsv21 (a transfer)',
      { tx: atomic(transfer21(me)), outputs: [insert('bsv21', JSON.stringify({ keyID: `${TOKEN}-1763251200000` }))] },
    ],
    ['an image ordinal into 1sat', { tx: atomic(image), outputs: [insert('1sat', '{"keyID":"ordinal-1"}')] }],
  ];
  for (const [name, args] of PASSED)
    test(`reaches the wallet unchanged: ${name}`, async () => {
      expect(storeInternalizeRefusal(args)).toBeNull();
      const { wallet, calls } = backstop(staged);
      await wallet.internalizeAction(args, SITE);
      expect(calls).toEqual([{ method: 'internalizeAction', args, originator: SITE }]);
    });
  test('the wallet’s own internalize is never gated', async () => {
    const { wallet, calls } = backstop(staged);
    await wallet.internalizeAction({ tx: atomic(deploy21), outputs: [insert('bsv21')] }, ADMIN);
    expect(calls.length).toBe(1);
  });
});

describe('A10 R2: a token deploy or mint is judged output by output, whatever the module calls the action', () => {
  for (const [name, outputs] of R2_PROBES)
    test(`refused (page check and backstop): ${name}`, async () => {
      const args = { description: 'x', ...(outputs as object) };
      expect(await storeMarketRefusal(args)).toBe('token-mint');
      const { wallet, calls } = backstop(staged);
      await expect(wallet.createAction(args, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
      expect(calls).toEqual([]);
    });
  test('a deploy+mint spent from the BEEF is refused too', async () => {
    const t = new Transaction();
    t.addOutput({ lockingScript: Script.fromHex(deploy21), satoshis: 1 });
    const beef = new Beef();
    beef.mergeRawTx(t.toBinary());
    const args = {
      description: 'x',
      inputBEEF: beef.toBinary(),
      inputs: [{ outpoint: `${t.id('hex')}.0`, unlockingScriptLength: 108 }],
      outputs: [out(transfer21(me), { basket: 'bsv21' })],
    };
    expect(await storeMarketRefusal(args, staged)).toBe('token-mint');
  });
  test('scriptKind: creation ops are "mint"; transfers, images and plain scripts keep their A9 kind', () => {
    for (const s of [deploy21, deployTb, deployAuth, mint21, deploy20, mint20, oddToken])
      expect(scriptKind(s)).toBe('mint');
    expect(scriptKind(transfer21(me))).toBe('asset');
    expect(scriptKind(BSV20.transfer('PEPE', 5n).lock(lockTo(me)).toHex())).toBe('asset');
    expect(scriptKind(image)).toBe('asset');
    expect(scriptKind(p2pkh(me))).toBe('plain');
    // Text that merely mentions the content type, outside an ord envelope, is not a token.
    const post = new Script().writeOpCode(0).writeOpCode(106).writeBin(Utils.toArray('application/bsv-20', 'utf8'));
    expect(scriptKind(post.toHex())).toBe('plain');
  });
  test('a token delivery from the site’s own coin still passes (A9 behaviour kept)', async () => {
    const t = new Transaction();
    t.addOutput({ lockingScript: Script.fromHex(transfer21(seller)), satoshis: 1 });
    const beef = new Beef();
    beef.mergeRawTx(t.toBinary());
    const args = {
      description: 'Delivery',
      inputBEEF: beef.toBinary(),
      inputs: [{ outpoint: `${t.id('hex')}.0`, unlockingScriptLength: 108 }],
      outputs: [out(transfer21(me), { basket: 'bsv21' })],
    };
    expect(await storeMarketRefusal(args, staged)).toBeNull();
  });
});

describe('A10 R3 (pinned, CTO under App Review 3.1.1): a paid NFT mint from a site stays refused in a store build', () => {
  const PAID_MINT = {
    description: 'Mint this for me',
    outputs: [out(image, { basket: '1sat' }), { lockingScript: p2pkh(house), satoshis: 500 }],
  };
  test('store: refused as a purchase, before any sheet, by both checks', async () => {
    expect(await storeMarketRefusal(PAID_MINT)).toBe('purchase');
    const { wallet, calls } = backstop(staged);
    await expect(wallet.createAction(PAID_MINT, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
    expect(calls).toEqual([]);
  });
  test('the same mint with no fee is not a purchase and still passes (A9 behaviour kept)', async () => {
    expect(await storeMarketRefusal({ description: 'Mint', outputs: [out(image, { basket: '1sat' })] })).toBeNull();
  });
});

describe('A10 editions: store refuses before Face ID; bWalletX unchanged', () => {
  const code = `const { P2PKH, PrivateKey, Utils } = await import('@bsv/sdk');
    const { BSV21, buildInscriptionScript } = await import('@1sat/templates');
    const m = await import('./src/mobile/dappBrowser.ts');
    const face = []; const sent = [];
    m.__setSiteGateForTests({ check: async (_o, c) => { face.push(c); return 'biometric'; }, lastVerification: () => null }, () => 5000);
    m.initDappBrowser(() => ({ runtime: { sendMessage: async (msg) => { sent.push(msg.action); return { success: true, data: { txid: 'ab' } }; } } }));
    const me = new PrivateKey(7).toAddress(); const house = new PrivateKey(9).toAddress();
    const img = buildInscriptionScript(new P2PKH().lock(me), Utils.toArray('img', 'utf8'), 'image/png').toHex();
    const deploy = BSV21.deployMint('MEME', 1000000000n, 0, '_0').lock(new P2PKH().lock(me)).toHex();
    const cases = {
      launch: { description: 'x', outputs: [{ lockingScript: img, satoshis: 1, basket: '1sat' }, { lockingScript: deploy, satoshis: 1 }] },
      paidMint: { description: 'x', outputs: [{ lockingScript: img, satoshis: 1, basket: '1sat' }, { lockingScript: new P2PKH().lock(house).toHex(), satoshis: 500 }] },
    };
    const out = {};
    for (const [k, args] of Object.entries(cases)) {
      face.length = 0; sent.length = 0;
      const r = await m.handleSiteCall('https://www.bchatx.com', 'https://www.bchatx.com/r', 'createAction', args);
      out[k] = { r, face: [...face], sent: [...sent] };
    }
    console.log(JSON.stringify(out));`;
  type Step = { r: { success: boolean; error?: string }; face: string[]; sent: string[] };
  const REFUSED = { r: { success: false, error: 'Not available in this edition' }, face: [], sent: [] };
  const NORMAL = { r: { success: true, data: { txid: 'ab' } }, face: ['createAction'], sent: ['createAction'] };
  test('store: a free token launch and a paid mint get no Face ID prompt and never reach the wallet', () => {
    for (const env of STORE_ENVS) {
      const r = run<Record<string, Step>>(code, env);
      expect(r.launch).toEqual(REFUSED);
      expect(r.paidMint).toEqual(REFUSED);
    }
  }, 90_000);
  test('bWalletX: both ask Face ID and go to the wallet, as before', () => {
    const r = run<Record<string, Step>>(code, {});
    expect([r.launch, r.paidMint]).toEqual([NORMAL, NORMAL]);
  }, 60_000);

  const keyCode = `const { PrivateKey } = await import('@bsv/sdk');
    const { guardSiteTokens, SITE_TOKEN_RECEIVE, SITE_ORDINAL_RECEIVE } = await import('./src/services/siteTokens.ts');
    const pub = new PrivateKey(5).toPublicKey().toString();
    const w = guardSiteTokens({ getPublicKey: async () => ({ publicKey: pub }) }, { adminOriginator: 'admin', normalize: (o) => o, prompt: async () => true });
    const ask = (protocolID, keyID) => w.getPublicKey({ protocolID, keyID, counterparty: 'self' }, 'www.bchatx.com').then((r) => r.keyID.replace(/\\d+$/, 'N'), (e) => 'error: ' + e.message);
    console.log(JSON.stringify({ deploy: await ask(SITE_TOKEN_RECEIVE, 'deploy'), ordinal: await ask(SITE_ORDINAL_RECEIVE, 'ordinal'),
      token: await ask(SITE_TOKEN_RECEIVE, '${TOKEN}') }));`;
  test('store: the site-token deploy receive key is refused; ordinal and token receive keys are not', () => {
    for (const env of STORE_ENVS)
      expect(run(keyCode, env)).toEqual({
        deploy: 'error: Not available in this edition',
        ordinal: 'ordinal-N',
        token: `${TOKEN}-N`,
      });
  }, 60_000);
  test('bWalletX: the deploy key is issued, as before', () => {
    expect(run(keyCode, {})).toEqual({ deploy: 'deploy-N', ordinal: 'ordinal-N', token: `${TOKEN}-N` });
  }, 30_000);
  test('siteTokens: the refusal sits behind the literal flag, inside the deploy branch only', () => {
    expect(srcOf('../services/siteTokens.ts')).toContain(
      "      } else if (asked === 'deploy') {\n        // Store edition (A10, R2): a site may not have the wallet deploy a fungible token, so it gets no deploy key.\n        if (!SITE_MARKET_ACTIONS_ENABLED) throw new Error(STORE_NAME_NOTE);\n        mint = (ms) => `deploy-${ms}`;",
    );
  });
});
