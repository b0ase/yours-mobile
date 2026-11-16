import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { BSV21, ORDLOCK_PREFIX, ORDLOCK_SUFFIX, OrdLock, OrdLockV2, buildInscriptionScript } from '@1sat/templates';
import { createOneSatPermissionModule, type PromptRequest } from '@1sat/permission-module';
import { enrichIntent } from '../services/oneSatEnrich';
import {
  ASSET_INPUT_BASKETS,
  STORE_MARKET_REFUSAL,
  guardStoreMarketActions,
  storeMarketVerdict,
  walletAssetOutpoints,
} from '../services/storeMarketGate';
// @ts-expect-error plain .mjs script, no type declarations
import { loadAllow } from '../../scripts/store-bundle-check.mjs';

/**
 * Round A9 (CTO + CEO decisions, 16 Nov 2026). Store build only; bWalletX behaviour and wording unchanged. Edition
 * checks run the three store envs and bWalletX in child processes (the literal flags are read at import).
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

// ---- Fixtures: what sites send ----
const ADMIN = 'wallet-admin-originator';
const SITE = 'www.bchatx.com';
const me = new PrivateKey(7).toAddress();
const seller = new PrivateKey(8).toAddress();
const p2pkh = (a: string) => new P2PKH().lock(a).toHex();
/** OrdLock v1 (the template no longer builds new v1 listings, so it is composed the way decode reads it). */
const ordLockV1 = (price: number) => {
  const pay = new P2PKH().lock(seller).toBinary();
  const payout = [
    ...Array.from({ length: 8 }, (_, i) => Number((BigInt(price) >> BigInt(i * 8)) & 255n)),
    pay.length,
    ...pay,
  ];
  const data = new Script()
    .writeBin(Utils.fromBase58Check(seller).data as number[])
    .writeBin(payout)
    .toBinary();
  return Script.fromBinary([...ORDLOCK_PREFIX, ...data, ...ORDLOCK_SUFFIX]).toHex();
};
const ordLockV2 = (price: number) => OrdLockV2.lock(seller, seller, price).toHex();
const inscription = buildInscriptionScript(new P2PKH().lock(me), Utils.toArray('hello', 'utf8'), 'text/plain').toHex();
const TOKEN = `${'a'.repeat(64)}_0`;
const tokenTransfer = (to: string) => BSV21.transfer(TOKEN, 10n).lock(new P2PKH().lock(to)).toHex();
/** The document seal: one 0-sat OP_FALSE OP_RETURN <json> (services/sealPass.ts). */
const sealOut = new Script()
  .writeOpCode(0)
  .writeOpCode(106)
  .writeBin(Utils.toArray('{"recordHash":"00"}', 'utf8'))
  .toHex();
/** A BEEF holding one transaction whose output 0 is `script`; returns its outpoint too. */
const beefWith = (script: string, sats = 1) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: Script.fromHex(script), satoshis: sats });
  const beef = new Beef();
  beef.mergeRawTx(tx.toBinary());
  return { beef: beef.toBinary(), outpoint: `${tx.id('hex')}.0` };
};

const PAYMENT = {
  description: 'Tip',
  outputs: [{ lockingScript: p2pkh(seller), satoshis: 1000, outputDescription: 'tip' }],
};
const SEAL = { description: 'Seal', outputs: [{ lockingScript: sealOut, satoshis: 0, outputDescription: 'seal' }] };
const listingInBeef = beefWith(ordLockV1(5000));
const BUY_LISTING = {
  description: 'Buy',
  labels: [`p 1sat input ${listingInBeef.outpoint}`],
  inputBEEF: listingInBeef.beef,
  inputs: [{ outpoint: listingInBeef.outpoint, inputDescription: 'listing', unlockingScriptLength: 500 }],
  outputs: [
    { lockingScript: p2pkh(me), satoshis: 1, basket: '1sat', outputDescription: 'ordinal' },
    { lockingScript: p2pkh(seller), satoshis: 5000, outputDescription: 'seller' },
  ],
};
/** No OrdLock in sight: the module itself calls it a purchase (asset into the wallet + a payment out). */
const BUY_BY_SHAPE = {
  description: 'Buy',
  outputs: [
    { lockingScript: inscription, satoshis: 1, basket: '1sat', outputDescription: 'item' },
    { lockingScript: p2pkh(seller), satoshis: 5000, outputDescription: 'seller' },
  ],
};
const BUY_TOKENS = {
  description: 'Buy tokens',
  outputs: [
    { lockingScript: tokenTransfer(me), satoshis: 1, basket: 'bsv21', outputDescription: 'tokens' },
    { lockingScript: p2pkh(seller), satoshis: 5000, outputDescription: 'seller' },
  ],
};
const LIST_V1 = {
  description: 'List',
  outputs: [{ lockingScript: ordLockV1(5000), satoshis: 1, basket: '1sat', tags: ['ordlock', 'price:5000'] }],
};
const LIST_V2_BARE = { description: 'List', outputs: [{ lockingScript: ordLockV2(5000), satoshis: 1 }] };
const LIST_TAG_ONLY = {
  description: 'List',
  outputs: [{ lockingScript: p2pkh(me), satoshis: 1, tags: ['price:5000'] }],
};
const CANCEL_HELD = {
  description: 'Cancel',
  labels: ['p 1sat input id abc123'],
  outputs: [{ lockingScript: p2pkh(me), satoshis: 1, basket: '1sat' }],
};
const HELD_COIN = `${'c'.repeat(64)}.1`;
const SELL_HELD_TOKEN = {
  description: 'Sell',
  inputs: [{ outpoint: HELD_COIN, inputDescription: 'token coin' }],
  outputs: [
    { lockingScript: tokenTransfer(seller), satoshis: 1 },
    { lockingScript: p2pkh(me), satoshis: 4000 },
  ],
};
const TOKEN_UNKNOWN = { description: 'Send', outputs: [{ lockingScript: tokenTransfer(seller), satoshis: 1 }] };
const MODULE_THROWS = { description: 'x', labels: ['p 1sat action'], outputs: {} };
const listingOutside = beefWith(ordLockV2(9000));
const SPEND_LISTING_NO_LABEL = {
  description: 'Buy',
  inputBEEF: listingOutside.beef,
  inputs: [{ outpoint: listingOutside.outpoint, inputDescription: 'listing', unlockingScriptLength: 500 }],
  outputs: [{ lockingScript: p2pkh(me), satoshis: 1 }],
};
const OUTSIDE_LABEL_NO_BEEF = {
  description: 'Buy',
  labels: [`p 1sat input ${'d'.repeat(64)}.0`],
  outputs: [{ lockingScript: p2pkh(me), satoshis: 1 }],
};
const INSCRIBE_TO_WALLET = {
  description: 'Mint',
  outputs: [{ lockingScript: inscription, satoshis: 1, basket: '1sat' }],
};
const tokenIn = beefWith(tokenTransfer(seller));
const RECEIVE_TOKENS = {
  description: 'Delivery',
  inputBEEF: tokenIn.beef,
  inputs: [{ outpoint: tokenIn.outpoint, inputDescription: 'site coin', unlockingScriptLength: 108 }],
  outputs: [{ lockingScript: tokenTransfer(me), satoshis: 1, basket: 'bsv21' }],
};

const noHeld = { assetOutpoints: async () => new Set<string>() };
const held = { assetOutpoints: async () => new Set([HELD_COIN]) };
const failing = {
  assetOutpoints: async (): Promise<Set<string>> => {
    throw new Error('storage down');
  },
};
/** A wallet whose every method records the call: proves a refused action reached nothing. */
const recorder = () => {
  const calls: { method: string; args: unknown; originator?: unknown }[] = [];
  const wallet = {
    createAction: async (args: unknown, originator?: unknown) => {
      calls.push({ method: 'createAction', args, originator });
      return { txid: 'f'.repeat(64) };
    },
    createSignature: async (args: unknown, originator?: unknown) => {
      calls.push({ method: 'createSignature', args, originator });
      return { signature: [] };
    },
  };
  return { wallet, calls };
};
const NO_WALLET = {
  listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
  decrypt: async () => {
    throw new Error('none');
  },
} as never;

describe('A9.1 the store refuses a site purchase, listing or cancel before any sheet', () => {
  const REFUSED: [string, unknown, string][] = [
    ['buy an outside listing (OrdLock input, "p 1sat input <outpoint>")', BUY_LISTING, 'ordlock'],
    ['an action the module calls a purchase (asset in + payment out)', BUY_BY_SHAPE, 'purchase'],
    ['buy tokens (BSV-21 into the wallet + payment out)', BUY_TOKENS, 'purchase'],
    ['list with an OrdLock v1 output and listing tags', LIST_V1, 'ordlock'],
    ['list with a bare OrdLock v2 output (the module does not read v2)', LIST_V2_BARE, 'ordlock'],
    ['an output carrying only a listing tag', LIST_TAG_ONLY, 'ordlock'],
    ['cancel a held listing ("p 1sat input id …")', CANCEL_HELD, 'held-asset'],
    ['spend an OrdLock from the BEEF with no label', SPEND_LISTING_NO_LABEL, 'ordlock'],
  ];
  for (const [name, args, why] of REFUSED)
    test(`refused: ${name}`, async () => {
      expect(await storeMarketVerdict(args, noHeld)).toEqual({ refuse: true, why: why as never });
      const { wallet, calls } = recorder();
      guardStoreMarketActions(wallet, { adminOriginator: ADMIN, ...noHeld });
      await expect(wallet.createAction(args, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
      expect(calls).toEqual([]);
    });
  test('the refusal is the edition note, word for word', () => {
    expect(STORE_MARKET_REFUSAL).toBe('Not available in this edition');
  });
  test('agreement: every fixture the real module classifies as buying or listing is refused', async () => {
    const all = [BUY_LISTING, BUY_BY_SHAPE, BUY_TOKENS, LIST_V1, LIST_V2_BARE, CANCEL_HELD, SPEND_LISTING_NO_LABEL];
    const marketish = [];
    for (const args of [...all, PAYMENT, SEAL, INSCRIBE_TO_WALLET, RECEIVE_TOKENS]) {
      const e = await enrichIntent(NO_WALLET, args as never);
      const market =
        ['purchase', 'listing', 'cancel-listing'].includes(e.kind) ||
        e.ordinalEdges.some((x) => ['purchase', 'list', 'cancel-listing'].includes(x.operation));
      if (market) {
        marketish.push(e.kind);
        expect((await storeMarketVerdict(args, noHeld)).refuse).toBe(true);
      }
    }
    // The module's own words for these: what the store bundle carries only as unreachable library text.
    expect(marketish).toEqual(['purchase', 'purchase', 'purchase', 'listing']);
    const buy = await enrichIntent(NO_WALLET, BUY_BY_SHAPE as never);
    expect(buy.summary).toBe('Buy asset');
    expect(buy.ordinalEdges.map((e) => e.title)).toEqual(['Buy collectable']);
    const list = await enrichIntent(NO_WALLET, LIST_V1 as never);
    expect(list.summary).toBe('List an ordinal for 5000 sats');
  });
});

describe('A9.1 fails closed on 1Sat assets the module cannot classify', () => {
  test('a wallet-held token coin spent by outpoint (the module has no metadata for it)', async () => {
    expect(await storeMarketVerdict(SELL_HELD_TOKEN, held)).toEqual({ refuse: true, why: 'held-asset' });
  });
  test('the asset-basket lookup failing refuses', async () => {
    expect(await storeMarketVerdict(SELL_HELD_TOKEN, failing)).toEqual({ refuse: true, why: 'unclassified' });
  });
  test('a token output the module calls "unknown"', async () => {
    expect((await enrichIntent(NO_WALLET, TOKEN_UNKNOWN as never)).kind).toBe('unknown');
    expect(await storeMarketVerdict(TOKEN_UNKNOWN, noHeld)).toEqual({ refuse: true, why: 'unclassified' });
  });
  test('the module throwing on an action routed to it', async () => {
    await expect(enrichIntent(NO_WALLET, MODULE_THROWS as never)).rejects.toThrow();
    expect(await storeMarketVerdict(MODULE_THROWS, noHeld)).toEqual({ refuse: true, why: 'unclassified' });
  });
  test('an outside coin named for the module that is not in the BEEF (missing metadata)', async () => {
    expect(await storeMarketVerdict(OUTSIDE_LABEL_NO_BEEF, noHeld)).toEqual({ refuse: true, why: 'unclassified' });
  });
  test('an asset action with an input the gate cannot read', async () => {
    const args = { ...TOKEN_UNKNOWN, inputs: [{ outpoint: `${'e'.repeat(64)}.0` }] };
    expect((await storeMarketVerdict(args, noHeld)).refuse).toBe(true);
  });
  test('asset baskets read for the held-coin check: every 1Sat basket, page by page, through the base wallet', async () => {
    expect(ASSET_INPUT_BASKETS).toEqual([
      '1sat',
      'bsv21',
      'bsv20',
      'opns',
      'lock',
      'sigma',
      'bsocial',
      'bap',
      'p 1sat bsv21',
    ]);
    const asked: string[] = [];
    const base = {
      listOutputs: async (a: { basket: string }) => {
        asked.push(a.basket);
        return a.basket === 'bsv21'
          ? { totalOutputs: 1, outputs: [{ outpoint: `${'C'.repeat(64)}_1` }] }
          : { totalOutputs: 0, outputs: [] };
      },
    };
    expect([...(await walletAssetOutpoints(base as never)())]).toEqual([HELD_COIN]);
    expect(asked).toEqual([...ASSET_INPUT_BASKETS]);
  });
});

describe('A9.1 plain payments, the seal and other asset actions are untouched', () => {
  const PASSED: [string, unknown][] = [
    ['a plain BSV payment from a catalogue site', PAYMENT],
    ['the document seal (0-sat OP_RETURN)', SEAL],
    ['an inscription into the wallet with no payment out (the module: inscription)', INSCRIBE_TO_WALLET],
    ['tokens delivered into the wallet from the site’s own coin (the module: token-transfer)', RECEIVE_TOKENS],
    [
      'a payment that spends a site coin from its BEEF',
      {
        ...PAYMENT,
        inputBEEF: beefWith(p2pkh(seller), 5000).beef,
        inputs: [{ outpoint: beefWith(p2pkh(seller), 5000).outpoint }],
      },
    ],
  ];
  for (const [name, args] of PASSED)
    test(`reaches the wallet unchanged: ${name}`, async () => {
      expect((await storeMarketVerdict(args, noHeld)).refuse).toBe(false);
      const { wallet, calls } = recorder();
      guardStoreMarketActions(wallet, { adminOriginator: ADMIN, ...failing });
      await wallet.createAction(args, SITE);
      expect(calls).toEqual([{ method: 'createAction', args, originator: SITE }]);
    });
  test('the wallet’s own actions are never gated (a purchase from the admin originator passes)', async () => {
    const { wallet, calls } = recorder();
    guardStoreMarketActions(wallet, { adminOriginator: ADMIN, ...failing });
    await wallet.createAction(BUY_LISTING, ADMIN);
    expect(calls.length).toBe(1);
  });
  test('sign-in and message signing are not createAction and are not wrapped', async () => {
    const { wallet, calls } = recorder();
    const before = wallet.createSignature;
    guardStoreMarketActions(wallet, { adminOriginator: ADMIN, ...failing });
    expect(wallet.createSignature).toBe(before);
    await wallet.createSignature({ protocolID: [2, 'bwallet sign in'], keyID: 'n', data: [1] }, SITE);
    expect(calls.map((c) => c.method)).toEqual(['createSignature']);
  });
});

describe('A9.1 with the real permission module: store refuses before its sheet, bWalletX still shows it', () => {
  /** The permissions manager's hand-off to the module, as WalletPermissionsManager makes it for a "p" action. */
  const managerWithModule = () => {
    const sheets: PromptRequest[] = [];
    const mod = createOneSatPermissionModule({
      wallet: NO_WALLET,
      adminOriginator: ADMIN,
      promptHandler: async (req) => {
        sheets.push(req);
        return false; // the person taps Don't allow
      },
    });
    const forwarded: unknown[] = [];
    const manager = {
      createAction: async (args: { labels?: string[]; outputs?: { basket?: string }[] }, originator?: string) => {
        const routed =
          args.labels?.some((l) => l.startsWith('p ')) || args.outputs?.some((o) => o.basket?.startsWith('p '));
        if (routed) await mod.onRequest({ method: 'createAction', args: args as never, originator: originator! });
        forwarded.push(args);
        return { txid: 'f'.repeat(64) };
      },
    };
    return { manager, sheets, forwarded, dispose: () => mod.dispose?.() };
  };
  const PURCHASE_VIA_MODULE = { ...BUY_BY_SHAPE, labels: ['p 1sat action'] };

  test('bWalletX (the wallet is not wrapped): the module shows its Buy sheet, as before', async () => {
    const m = managerWithModule();
    await expect(m.manager.createAction(PURCHASE_VIA_MODULE, SITE)).rejects.toThrow('user rejected');
    expect(m.sheets.length).toBe(1);
    expect(m.sheets[0].kind).toBe('transaction');
    expect(m.sheets[0].summary).toBe('Buy asset');
    m.dispose();
  });
  test('bWalletX: a listing request reaches the module sheet too', async () => {
    const m = managerWithModule();
    await expect(m.manager.createAction({ ...LIST_V1, labels: ['p 1sat action'] }, SITE)).rejects.toThrow(
      'user rejected',
    );
    expect(m.sheets.map((s) => s.summary)).toEqual(['List an ordinal for 5000 sats']);
    m.dispose();
  });
  test('store (wrapped): refused with the edition note; the module never builds or shows a sheet', async () => {
    const m = managerWithModule();
    guardStoreMarketActions(m.manager, { adminOriginator: ADMIN, ...noHeld });
    await expect(m.manager.createAction(PURCHASE_VIA_MODULE, SITE)).rejects.toThrow(STORE_MARKET_REFUSAL);
    await expect(m.manager.createAction({ ...LIST_V1, labels: ['p 1sat action'] }, SITE)).rejects.toThrow(
      STORE_MARKET_REFUSAL,
    );
    expect(m.sheets).toEqual([]);
    expect(m.forwarded).toEqual([]);
    m.dispose();
  });
  test('store: a plain payment from a catalogue site still reaches the normal approval path', async () => {
    const m = managerWithModule();
    guardStoreMarketActions(m.manager, { adminOriginator: ADMIN, ...noHeld });
    await m.manager.createAction(PAYMENT as never, SITE);
    await m.manager.createAction(SEAL as never, 'chat.bwalletx.com');
    expect(m.forwarded).toEqual([PAYMENT, SEAL]);
    m.dispose();
  });
});

describe('A9.1 one gate, outermost, store build only', () => {
  test('SITE_MARKET_ACTIONS_ENABLED: off in every store env, on in bWalletX', () => {
    const code = `const s = await import('./src/mobile/storeBuild.ts'); console.log(JSON.stringify(s.SITE_MARKET_ACTIONS_ENABLED));`;
    for (const env of STORE_ENVS) expect(run<boolean>(code, env)).toBe(false);
    expect(run<boolean>(code, {})).toBe(true);
  }, 60_000);
  test('initWallet wraps the whole site wallet with it, outside guardSiteTokens, only when the literal is off', () => {
    const s = srcOf('../initWallet.ts');
    expect(s).toContain('  const siteWallet = guardSiteTokens(\n    guardSpendRecipients(');
    expect(s).toContain(
      '  const wallet = SITE_MARKET_ACTIONS_ENABLED\n    ? siteWallet\n    : guardStoreMarketActions(siteWallet, {\n        adminOriginator: ADMIN_ORIGINATOR,\n        assetOutpoints: walletAssetOutpoints(baseWallet),\n      });',
    );
    // Nothing else is wrapped around it, and it is the wallet the account context hands out.
    expect(s.match(/guardStoreMarketActions\(/g)?.length).toBe(1);
    expect(s).toMatch(/\n {4}wallet,\n/);
  });
  test('every phone site call reaches that wallet: handleSiteCall → background → walletForSiteRequest', () => {
    const browser = srcOf('./dappBrowser.ts');
    expect(browser).toContain(
      'chrome.runtime.sendMessage({ action: type, params: params ?? {}, originator: key.originator })',
    );
    const bg = srcOf('../background.ts');
    expect(bg).toContain(
      'const w = message.originator === ADMIN_ORIGINATOR ? await ensureWallet() : await walletForSiteRequest();',
    );
    expect(bg).toContain('ready: () => (masterBackupGate.active ? undefined : accountContext?.wallet),');
  });
  test('bWalletX: the gate leaves a wallet it is not given untouched (never called; identity when it is)', () => {
    const s = srcOf('../services/storeMarketGate.ts');
    expect(s).not.toContain('STORE_BUILD');
    expect(srcOf('../initWallet.ts')).toContain('SITE_MARKET_ACTIONS_ENABLED\n    ? siteWallet');
  });
  test('the module classifier is the pinned package file', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@1sat/permission-module']).toBe('0.0.77');
    expect(existsSync(join(ROOT, 'node_modules/@1sat/permission-module/dist/enrichIntent.js'))).toBe(true);
    expect(srcOf('../services/oneSatEnrich.ts')).toContain(
      "export { enrichIntent } from '../../node_modules/@1sat/permission-module/dist/enrichIntent.js';",
    );
    // OrdLock v1 decodes the fixture, so the gate is checked against the real lock shape.
    expect(OrdLock.decode(Script.fromHex(ordLockV1(5000)))?.price).toBe(5000n);
  });
});

describe('A9.1 the permission-module Buy / List text: unreachable in a store build, with the proof as its reason', () => {
  test('the allowlist entry now gives the gate as its proof', () => {
    const e = (loadAllow() as { chunk: string; pattern?: string; reason: string }[]).filter((a) =>
      a.pattern?.includes('List on marketplace lock'),
    );
    expect(e.length).toBe(1);
    expect(e[0].reason).toContain('services/storeMarketGate.ts');
    expect(e[0].reason).toContain('storeGatesA9.test.ts');
    expect(e[0].reason).not.toContain('so the user can refuse it');
  });
});

describe('A9.2 the app is "bWallet" in a store build: APP_NAME, a literal build constant', () => {
  const code = `const s = await import('./src/mobile/storeBuild.ts');
    const r = await import('./src/services/reservedProtocols.ts'); const o = await import('./src/services/originKey.ts');
    const g = await import('./src/mobile/siteGate.ts'); const n = await import('./src/mobile/names/names.ts');
    const c = await import('./src/utils/constants.ts'); const w = await import('./src/services/walletSetupWait.ts');
    console.log(JSON.stringify({ name: s.APP_NAME, reserved: r.RESERVED_REFUSAL, https: o.INSECURE_ORIGIN_ERROR,
      faceId: g.VERIFICATION_TIMEOUT_MESSAGE, user: n.noSuchUser('$al'), mail: c.SUPPORT_EMAIL_URL, ns: 'appNameFor' in s }));`;
  type R = { name: string; reserved: string; https: string; faceId: string; user: string; mail: string; ns: boolean };
  test('store: "bWallet" in every store env, in the strings that name the app', () => {
    for (const env of STORE_ENVS)
      expect(run<R>(code, env)).toEqual({
        name: 'bWallet',
        reserved: 'This protocol is reserved for bWallet itself',
        https: 'bWallet only works with secure (https) sites',
        faceId: "bWallet didn't get a Face ID, fingerprint or passcode answer in time.",
        user: 'No bWallet user called $al',
        mail: 'mailto:support@bwalletx.com?subject=bWallet%20support',
        ns: false,
      });
  }, 60_000);
  test('bWalletX: the same strings, word for word as before', () => {
    expect(run<R>(code, {})).toEqual({
      name: 'bWalletX',
      reserved: 'This protocol is reserved for bWalletX itself',
      https: 'bWalletX only works with secure (https) sites',
      faceId: "bWalletX didn't get a Face ID, fingerprint or passcode answer in time.",
      user: 'No bWalletX user called $al',
      mail: 'mailto:support@bwalletx.com?subject=bWalletX%20support',
      ns: false,
    });
  }, 60_000);
  test('APP_NAME is a literal env check (folded by Rollup), and the old function form is gone', () => {
    const s = srcOf('./storeBuild.ts');
    expect(s).toContain(
      "export const APP_NAME: string =\n  import.meta.env.VITE_STORE_BUILD === '1' ||\n  import.meta.env.VITE_CHANNEL === 'ios-store' ||\n  import.meta.env.VITE_CHANNEL === 'android-play'\n    ? 'bWallet'\n    : 'bWalletX';",
    );
    expect(s).not.toContain('export const appNameFor');
    // The YoursIcon alt text patched in at build time follows it too.
    expect(readFileSync(join(ROOT, 'vite.brand.ts'), 'utf8')).toContain("['alt=\"Yours Head\"', 'alt={APP_NAME}'],");
  });
  test('constants.ts still loads under plain node / tsx (its own optional-chain copy of the check)', () => {
    const s = srcOf('../utils/constants.ts');
    expect(s).not.toContain("from '../mobile/storeBuild'");
    expect(s).toContain(
      'export const SUPPORT_EMAIL_URL = `mailto:support@bwalletx.com?subject=${SUPPORT_APP_NAME}%20support`;',
    );
  });
});

describe('A9.2 the store bundle check fails a store bundle that still names the app "bWalletX"', () => {
  test('PRODUCT_NAME: the app name, never a domain, paymail or longer identifier', async () => {
    // @ts-expect-error plain .mjs script, no type declarations
    const { PRODUCT_NAME } = await import('../../scripts/store-bundle-check.mjs');
    for (const s of ['Unlock bWalletX first', 'bWalletX', ' · bWalletX #3', '(your bWalletX).', "bWalletX's storage"])
      expect(PRODUCT_NAME.test(s)).toBe(true);
    for (const s of [
      'https://web.bwalletx.com/x',
      'support@bwalletx.com',
      'name@bwalletx.com',
      'bWalletX.com',
      'bWalletXRequest',
      'bWallet',
      'Unlock bWallet first',
    ])
      expect(PRODUCT_NAME.test(s)).toBe(false);
  });
  test('scanProductName reads strings, template parts and text files, and honours the productName allowlist', async () => {
    // @ts-expect-error plain .mjs script, no type declarations
    const { scanProductName } = await import('../../scripts/store-bundle-check.mjs');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const dir = mkdtempSync(join(tmpdir(), 'a9-name-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets/main-Ab12Cd34.js'),
      'const a="Unlock bWalletX first",b=`Open ${x} in bWalletX now`,c=/bWalletX/,d="https://web.bwalletx.com",e="ok";',
    );
    writeFileSync(join(dir, 'assets/keep-Zz99Yy88.js'), 'const k="bWalletX: link token ";');
    writeFileSync(join(dir, 'index.html'), '<title>bWalletX</title>');
    const allow = [
      {
        chunk: 'keep',
        match: 'bWalletX: link token ',
        reason: 'signed protocol text',
        test: (s: string) => s.includes('bWalletX: link token '),
      },
    ];
    const r = await scanProductName(dir, allow);
    expect(r.hits.map((h: { file: string; around: string }) => [h.file, h.around]).sort()).toEqual([
      ['assets/main-Ab12Cd34.js', ' in bWalletX now'],
      ['assets/main-Ab12Cd34.js', 'Unlock bWalletX first'],
      ['index.html', '<title>bWalletX</title>'],
    ]);
    expect(r.unused).toEqual([]);
  });
  test('the productName allowlist: on-chain ids and protocol text only, each with its reason', async () => {
    // @ts-expect-error plain .mjs script, no type declarations
    const { loadNameAllow } = await import('../../scripts/store-bundle-check.mjs');
    const list = loadNameAllow() as { chunk: string; match?: string; pattern?: string; reason: string }[];
    expect(list.map((a) => [a.chunk, a.match ?? a.pattern])).toEqual([
      ['BavatarMintSheet', ' · bWalletX '],
      ['BavatarMintSheet', 'fill="#f1ead9">bWalletX '],
      ['BavatarMintSheet', '^bWalletX$'],
      ['bwalletx-glyph', "aria-label='bWalletX'"],
      ['index', 'bWalletX: link token '],
      ['index', '^bWalletX$'],
    ]);
    for (const a of list) expect(a.reason.length).toBeGreaterThan(60);
  });
  test('the check runs pass 3 and fails on it; "is clean" names it', () => {
    const s = readFileSync(join(ROOT, 'scripts/store-bundle-check.mjs'), 'utf8');
    expect(s).toContain('  const names = await scanProductName(dir);');
    expect(s).toContain('  if (hits.length || words.hits.length || names.hits.length) process.exit(1);');
    expect(s).toContain('no "bWalletX" app name)');
  });
});
