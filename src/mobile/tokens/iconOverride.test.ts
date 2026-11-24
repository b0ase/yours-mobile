import { beforeEach, describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, KeyDeriver, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import {
  aipMessage,
  aipValid,
  MAP_PREFIX,
  issuerSigningPrivateKey,
  parseIssueScript,
  signIssueWithKey,
} from '../issuer/issuer';
import { REGISTRY, WOC_TX_HEX } from '../issuer/issuerVerify';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import {
  cachedOverride,
  clearOverrideCache,
  iconOverrideScript,
  iconSigningKey,
  iconSigningPrivateKey,
  MAX_ICON_BYTES,
  newestOverride,
  onOverrideChange,
  overridesInTx,
  pickIcon,
  publishIconOverride,
  resolveIconOverride,
  TS_SKEW_SECS,
  overrideIconUrl,
} from './iconOverride';
import { hasPinnedArt } from './officialTokens';

const TOKEN = `${'ab'.repeat(32)}_0`;
const OTHER_TOKEN = `${'cd'.repeat(32)}_0`;
const ICON_A = `${'a1'.repeat(32)}_0`;
const ICON_B = `${'b2'.repeat(32)}_0`;
const DEPLOY_ICON = 'https://ordfs.example/deploy-icon';
const NOW = 1_800_000_000_000;
const secs = NOW / 1000;
const { toArray } = Utils;

const issuer = PrivateKey.fromRandom();
const issuerKey = issuer.toPublicKey().toString();
const stranger = PrivateKey.fromRandom();

/** The signed statement script. `signer` signs; `claim` is the identity_key it states. */
function signedStatement(o: {
  icon?: string;
  ts: number;
  signer?: PrivateKey;
  claim?: string;
  tokenId?: string;
  /** Sign with the issuer-statement key (the one room admin uses) instead of the icon key. */
  oldKey?: boolean;
}) {
  const unsigned = iconOverrideScript({
    tokenId: o.tokenId ?? TOKEN,
    icon: o.icon ?? ICON_A,
    ts: o.ts,
    identityKey: o.claim ?? issuerKey,
  });
  const who = o.signer ?? issuer;
  return signIssueWithKey(unsigned, o.oldKey ? issuerSigningPrivateKey(who) : iconSigningPrivateKey(who));
}

function txWith(script: Script, salt = 0) {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: script, satoshis: 0 });
  // Different change amounts give each tx its own txid.
  tx.addOutput({ lockingScript: new P2PKH().lock(issuer.toPublicKey().toAddress()), satoshis: 500 + salt });
  return Transaction.fromHex(tx.toHex()); // as a reader sees it
}
const overrideTx = (o: Parameters<typeof signedStatement>[0] & { salt?: number }) =>
  txWith(signedStatement(o), o.salt ?? 0);

interface Net {
  /** blocktime / time per txid (default: confirmed at `secs`). */
  info?: Record<string, { blocktime?: number; time?: number }>;
  listed?: string[] | 'down';
  /** Txids whose hex the node does not serve. */
  missing?: string[];
  /** Serve this hex for these txids instead (a lying node). */
  swap?: Record<string, string>;
  icon?: (url: string) => Response;
}
const png = () => new Response(new Uint8Array(200), { headers: { 'content-type': 'image/png' } });
let calls: string[] = [];
function fakeFetch(txs: Transaction[], net: Net = {}) {
  const byId = new Map(txs.map((t) => [t.id('hex'), t.toHex()]));
  return (async (url: string) => {
    calls.push(url);
    if (url === `${REGISTRY}/${TOKEN}/icon`) {
      if (net.listed === 'down') return new Response('x', { status: 500 });
      return new Response(JSON.stringify({ txids: net.listed ?? txs.map((t) => t.id('hex')) }));
    }
    for (const [id, hex] of byId) {
      if (net.missing?.includes(id)) continue;
      if (url === WOC_TX_HEX(id)) return new Response(net.swap?.[id] ?? hex);
      if (url === `https://api.whatsonchain.com/v1/bsv/main/tx/hash/${id}`)
        return new Response(JSON.stringify(net.info?.[id] ?? { blocktime: secs }));
    }
    if (url === overrideIconUrl({ icon: ICON_A }) || url === overrideIconUrl({ icon: ICON_B }))
      return net.icon ? net.icon(url) : png();
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

// Other test files leave their own localStorage shims on globalThis; start each test from a clean one.
let store = new Map<string, string>();
beforeEach(() => {
  store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  clearOverrideCache();
  calls = [];
});

describe('icon override: reading a tx', () => {
  test('a valid override by the recorded issuer is accepted', () => {
    const tx = overrideTx({ ts: secs - 10 });
    const got = overridesInTx(tx, TOKEN, issuerKey, secs);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tokenId: TOKEN, icon: ICON_A, ts: secs - 10, txid: tx.id('hex') });
  });

  test('a statement signed by someone else is ignored, even when it claims the issuer key', () => {
    expect(overridesInTx(overrideTx({ ts: secs, signer: stranger }), TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('a stranger signing honestly as themselves is ignored: they are not the recorded issuer', () => {
    const strangerKey = stranger.toPublicKey().toString();
    const tx = overrideTx({ ts: secs, signer: stranger, claim: strangerKey });
    expect(overridesInTx(tx, TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('an override for another token is ignored', () => {
    expect(overridesInTx(overrideTx({ ts: secs, tokenId: OTHER_TOKEN }), TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('the room-admin key (issuer statement key) is not an icon signer', () => {
    const tx = overrideTx({ ts: secs, oldKey: true });
    expect(overridesInTx(tx, TOKEN, issuerKey, secs)).toEqual([]);
    expect(iconSigningKey(issuerKey).toAddress()).not.toBe(issuerSigningPrivateKey(issuer).toPublicKey().toAddress());
    expect(iconSigningKey(issuerKey).toAddress()).toBe(iconSigningPrivateKey(issuer).toPublicKey().toAddress());
  });

  test('a tampered field breaks the signature', () => {
    const tx = overrideTx({ ts: secs });
    const hex = tx.toHex().replace(Buffer.from(ICON_A).toString('hex'), Buffer.from(ICON_B).toString('hex'));
    expect(overridesInTx(Transaction.fromHex(hex), TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('newest ts wins; equal ts resolves the same way everywhere', () => {
    const a = { tokenId: TOKEN, icon: ICON_A, ts: 5, txid: 'bb', identityKey: issuerKey };
    const b = { ...a, icon: ICON_B, ts: 9, txid: 'cc' };
    expect(newestOverride([a, b])?.icon).toBe(ICON_B);
    expect(newestOverride([b, a])?.icon).toBe(ICON_B);
    const tie = { ...b, ts: 5, txid: 'aa' };
    expect(newestOverride([a, tie])?.txid).toBe('aa');
    expect(newestOverride([])).toBeNull();
  });

  test('ts boundary: block time + skew is the last good second, one more is invalid', () => {
    const block = secs - 100_000;
    expect(overridesInTx(overrideTx({ ts: block + TS_SKEW_SECS }), TOKEN, issuerKey, block)).toHaveLength(1);
    expect(overridesInTx(overrideTx({ ts: block + TS_SKEW_SECS + 1 }), TOKEN, issuerKey, block)).toEqual([]);
    expect(overridesInTx(overrideTx({ ts: 0 }), TOKEN, issuerKey, block)).toHaveLength(1);
  });
});

describe('icon override: forged layouts are refused (replayed issuer signature + unsigned MAP)', () => {
  const push = (s: Script, v: string) => s.writeBin(toArray(v, 'utf8'));
  const evil = (): [string, string][] => [
    ['p', 'bsv-21-meta'],
    ['tokenId', TOKEN],
    ['icon', ICON_B],
    ['ts', String(secs)],
    ['identity_key', issuerKey],
  ];
  /** The issuer's real signature (for a statement about ANOTHER token) hidden from a MAP reader, then an unsigned MAP. */
  function forge(variant: 'op0' | 'resplit', pairs = evil()): Script {
    const real = signedStatement({ ts: secs - 50, tokenId: OTHER_TOKEN }).chunks;
    const ret = real.findIndex((c) => c.op === OP.OP_RETURN);
    const pipe = real.findIndex((c, i) => i > ret && c.data?.length === 1 && c.data[0] === 0x7c);
    const signedPushes = real.slice(ret + 1, pipe);
    const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
    if (variant === 'op0') {
      s.writeOpCode(OP.OP_0);
      for (const c of signedPushes) s.writeBin(c.data!);
    } else {
      const first = signedPushes[0].data!;
      s.writeBin(first.slice(0, 5));
      s.writeBin(first.slice(5));
      for (const c of signedPushes.slice(1)) s.writeBin(c.data!);
    }
    for (const c of real.slice(pipe)) s.writeBin(c.data!);
    s.writeBin([0x7c]);
    push(s, MAP_PREFIX);
    push(s, 'SET');
    for (const [k, v] of pairs) {
      push(s, k);
      push(s, v);
    }
    return s;
  }

  test('the real statement for the other token is valid on its own (so the forge replays a genuine signature)', () => {
    expect(
      overridesInTx(txWith(signedStatement({ ts: secs - 50, tokenId: OTHER_TOKEN })), OTHER_TOKEN, issuerKey, secs),
    ).toHaveLength(1);
  });

  for (const variant of ['op0', 'resplit'] as const) {
    test(`OP_0 / re-split prefix then an unsigned MAP after the AIP (${variant})`, () => {
      // the replayed signature really does verify over the forged script's signed region (that is the attack)
      const ch = forge(variant).chunks;
      const pipe = ch.findIndex((c) => c.data?.length === 1 && c.data[0] === 0x7c);
      const aip = ch.slice(pipe + 1, pipe + 5).map((c) => c.data!);
      expect(aipValid(aipMessage(ch.slice(0, pipe)), aip[3], Utils.toUTF8(aip[2]))).toBe(true);
      expect(overridesInTx(txWith(forge(variant)), TOKEN, issuerKey, secs)).toEqual([]);
      // and the issuer-statement parser (the other half of the same fix) agrees
      expect(parseIssueScript(forge(variant))).toBeNull();
    });
  }

  test('extra, duplicate and reordered keys, and empty pushes, are refused', () => {
    const base = evil();
    const variants: [string, string][][] = [
      [...base, ['x', 'y']],
      [base[0], ...base],
      [base[1], base[0], ...base.slice(2)],
      [base[0], base[1], base[2], ['ts', '1'], ...base.slice(3)],
    ];
    for (const pairs of variants) {
      const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
      push(s, MAP_PREFIX);
      push(s, 'SET');
      for (const [k, v] of pairs) {
        push(s, k);
        push(s, v);
      }
      expect(overridesInTx(txWith(signIssueWithKey(s, iconSigningPrivateKey(issuer))), TOKEN, issuerKey, secs)).toEqual(
        [],
      );
    }
    const real = signedStatement({ ts: secs - 5 }).chunks;
    const gap = new Script(real.slice(0, 4));
    gap.writeOpCode(OP.OP_0);
    for (const c of real.slice(4)) gap.writeBin(c.data!);
    expect(overridesInTx(txWith(gap), TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('values must be strict: upper-case key or token id, leading-zero ts, a second statement part', () => {
    const upper = issuerKey.toUpperCase();
    const mk = (pairs: [string, string][]) => {
      const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
      push(s, MAP_PREFIX);
      push(s, 'SET');
      for (const [k, v] of pairs) {
        push(s, k);
        push(s, v);
      }
      return txWith(signIssueWithKey(s, iconSigningPrivateKey(issuer)));
    };
    const b = evil();
    expect(overridesInTx(mk(b), TOKEN, issuerKey, secs)).toHaveLength(1); // the control: strict values pass
    expect(overridesInTx(mk([...b.slice(0, 4), ['identity_key', upper]]), TOKEN, issuerKey, secs)).toEqual([]);
    expect(overridesInTx(mk([b[0], ['tokenId', TOKEN.toUpperCase()], ...b.slice(2)]), TOKEN, issuerKey, secs)).toEqual(
      [],
    );
    expect(overridesInTx(mk([...b.slice(0, 3), ['ts', '0' + String(secs)], b[4]]), TOKEN, issuerKey, secs)).toEqual([]);
    const two = signedStatement({ ts: secs - 5 });
    two.writeBin([0x7c]);
    push(two, 'extra');
    expect(overridesInTx(txWith(two), TOKEN, issuerKey, secs)).toEqual([]);
  });
});

describe('icon override: what the wallet shows', () => {
  test('a valid override is shown instead of the deploy icon', async () => {
    const tx = overrideTx({ ts: secs - 5 });
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx]), NOW);
    expect(o?.icon).toBe(ICON_A);
    expect(pickIcon(DEPLOY_ICON, o)).toContain(ICON_A);
    expect(pickIcon(DEPLOY_ICON, o)).not.toBe(DEPLOY_ICON);
  });

  test('a wrong-signer override is ignored: the deploy icon stays', async () => {
    const tx = overrideTx({ ts: secs - 5, signer: stranger });
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx]), NOW);
    expect(o).toBeNull();
    expect(pickIcon(DEPLOY_ICON, o)).toBe(DEPLOY_ICON);
  });

  test('an older ts does not replace a newer one', async () => {
    const newer = overrideTx({ ts: secs - 5, icon: ICON_B, salt: 1 });
    const older = overrideTx({ ts: secs - 500, icon: ICON_A, salt: 2 });
    for (const order of [
      [newer, older],
      [older, newer],
    ]) {
      clearOverrideCache();
      const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch(order), NOW);
      expect(o?.icon).toBe(ICON_B);
    }
  });

  test('a foreign newer override does not beat the issuer older one', async () => {
    const mine = overrideTx({ ts: secs - 500, icon: ICON_A, salt: 1 });
    const foreign = overrideTx({ ts: secs - 5, icon: ICON_B, signer: stranger, salt: 2 });
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([mine, foreign]), NOW);
    expect(o?.icon).toBe(ICON_A);
  });

  test('no override: the deploy icon is used, and "none" is cached', async () => {
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([]), NOW);
    expect(o).toBeNull();
    expect(pickIcon(DEPLOY_ICON, o)).toBe(DEPLOY_ICON);
    expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeNull();
  });

  test('a ts past its block time + skew stays invalid however late it is read', async () => {
    const tx = overrideTx({ ts: secs - 1000 + TS_SKEW_SECS + 1 });
    const info = { [tx.id('hex')]: { blocktime: secs - 1000 } };
    expect(await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx], { info }), NOW)).toBeNull();
    clearOverrideCache();
    // a year later it is still invalid: it is not "not yet"
    expect(await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx], { info }), NOW + 365 * 86400_000)).toBeNull();
  });

  test('an unconfirmed tx is bounded by when it was first seen', async () => {
    const tx = overrideTx({ ts: secs - 100 + TS_SKEW_SECS });
    const seen = fakeFetch([tx], { info: { [tx.id('hex')]: { time: secs - 100 } } });
    expect((await resolveIconOverride(TOKEN, issuerKey, seen, NOW))?.icon).toBe(ICON_A);
    clearOverrideCache();
    const late = overrideTx({ ts: secs - 100 + TS_SKEW_SECS + 1, salt: 9 });
    const seen2 = fakeFetch([late], { info: { [late.id('hex')]: { time: secs - 100 } } });
    expect(await resolveIconOverride(TOKEN, issuerKey, seen2, NOW)).toBeNull();
  });
});

describe('icon override: failures are never cached as "none"', () => {
  test('the index being down shows the deploy icon and is not cached', async () => {
    const tx = overrideTx({ ts: secs - 5 });
    expect(await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx], { listed: 'down' }), NOW)).toBeNull();
    expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
    expect((await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx]), NOW + 1))?.icon).toBe(ICON_A);
  });

  test('a tx that cannot be fetched means no "none" is cached', async () => {
    const tx = overrideTx({ ts: secs - 5 });
    const net = { missing: [tx.id('hex')] };
    expect(await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx], net), NOW)).toBeNull();
    expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
    expect((await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx]), NOW + 1))?.icon).toBe(ICON_A);
  });

  test('a partial failure keeps the valid one but only for a short time', async () => {
    const good = overrideTx({ ts: secs - 500, salt: 1 });
    const lost = overrideTx({ ts: secs - 5, icon: ICON_B, salt: 2 });
    const f = fakeFetch([good, lost], { missing: [lost.id('hex')] });
    expect((await resolveIconOverride(TOKEN, issuerKey, f, NOW))?.icon).toBe(ICON_A);
    expect(cachedOverride(TOKEN, issuerKey, NOW + 30_000)?.icon).toBe(ICON_A);
    expect(cachedOverride(TOKEN, issuerKey, NOW + 120_000)).toBeUndefined();
    // the newer one is picked up on the next lookup
    expect((await resolveIconOverride(TOKEN, issuerKey, fakeFetch([good, lost]), NOW + 120_000))?.icon).toBe(ICON_B);
  });

  test('a node that answers with a different tx than asked for is ignored', async () => {
    const tx = overrideTx({ ts: secs - 5 });
    const other = overrideTx({ ts: secs - 5, salt: 77 });
    const f = fakeFetch([tx], { swap: { [tx.id('hex')]: other.toHex() } });
    expect(await resolveIconOverride(TOKEN, issuerKey, f, NOW)).toBeNull();
    expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
  });

  test('WhatsOnChain lookups go through the shared throttle (at most two at once)', async () => {
    const txs = [1, 2, 3, 4, 5].map((n) => overrideTx({ ts: secs - n, icon: ICON_B, salt: n }));
    let active = 0;
    let peak = 0;
    const inner = fakeFetch(txs);
    const f = (async (url: string, init?: unknown) => {
      const woc = url.includes('whatsonchain');
      if (woc) peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
      } finally {
        if (woc) active--;
      }
    }) as unknown as typeof fetch;
    await resolveIconOverride(TOKEN, issuerKey, f, NOW);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('icon override: the icon file itself is checked', () => {
  test('a non-image or oversized newest icon is skipped for the next valid one', async () => {
    const newer = overrideTx({ ts: secs - 5, icon: ICON_B, salt: 1 });
    const older = overrideTx({ ts: secs - 500, icon: ICON_A, salt: 2 });
    for (const bad of [
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      () =>
        new Response(new Uint8Array(10), {
          headers: { 'content-type': 'image/png', 'content-length': String(MAX_ICON_BYTES + 1) },
        }),
      () => new Response(new Uint8Array(MAX_ICON_BYTES + 10), { headers: { 'content-type': 'image/png' } }),
    ]) {
      clearOverrideCache();
      const icon = (url: string) => (url.endsWith(ICON_B) ? bad() : png());
      const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([newer, older], { icon }), NOW);
      expect(o?.icon).toBe(ICON_A);
    }
  });

  test('when the icon cannot be fetched, the deploy icon shows and nothing is cached', async () => {
    const tx = overrideTx({ ts: secs - 5 });
    const f = fakeFetch([tx], { icon: () => new Response('x', { status: 503 }) });
    expect(await resolveIconOverride(TOKEN, issuerKey, f, NOW)).toBeNull();
    expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
  });
});

describe('icon override: the cache', () => {
  const entry = (value: unknown, extra: object = {}) => JSON.stringify({ at: NOW, value, ...extra });
  const good = { tokenId: TOKEN, icon: ICON_A, ts: 5, txid: 'ee'.repeat(32), identityKey: issuerKey };
  const key = () => [...store.keys()][0];

  test('is keyed by issuer key: another issuer does not see it', async () => {
    await resolveIconOverride(TOKEN, issuerKey, fakeFetch([overrideTx({ ts: secs - 5 })]), NOW);
    expect(cachedOverride(TOKEN, issuerKey, NOW)?.icon).toBe(ICON_A);
    expect(cachedOverride(TOKEN, stranger.toPublicKey().toString(), NOW)).toBeUndefined();
  });

  test('malformed stored entries are ignored', async () => {
    await resolveIconOverride(TOKEN, issuerKey, fakeFetch([overrideTx({ ts: secs - 5 })]), NOW);
    const k = key();
    const bad: string[] = [
      entry({ ...good, icon: 'javascript:alert(1)' }),
      entry({ ...good, icon: ICON_A.toUpperCase() }),
      entry({ ...good, tokenId: OTHER_TOKEN }),
      entry({ ...good, identityKey: stranger.toPublicKey().toString() }),
      entry({ ...good, ts: -1 }),
      entry({ ...good, ts: '5' }),
      entry({ ...good, ts: 1.5 }),
      entry({ ...good, txid: 'zz' }),
      entry('nope'),
      entry(good, { ttl: 99_999_999 }),
      JSON.stringify({ value: good }),
      '{not json',
      'null',
    ];
    for (const raw of bad) {
      clearOverrideCache(); // drops memory; put the raw text back as the only copy
      store.set(k, raw);
      expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
    }
    store.set(k, entry(good));
    expect(cachedOverride(TOKEN, issuerKey, NOW)?.icon).toBe(ICON_A);
  });

  test('a listener hears about a new answer, so an open screen can refresh', async () => {
    const heard: string[] = [];
    const off = onOverrideChange((id) => heard.push(id));
    await resolveIconOverride(TOKEN, issuerKey, fakeFetch([overrideTx({ ts: secs - 5 })]), NOW);
    expect(heard).toEqual([TOKEN]);
    off();
    await resolveIconOverride(OTHER_TOKEN, issuerKey, fakeFetch([]), NOW);
    expect(heard).toEqual([TOKEN]);
  });
});

describe('icon override: official art always wins', () => {
  test('a pinned token never gets an override, and nothing is fetched', async () => {
    expect(hasPinnedArt(PNEE_TOKEN_ID)).toBe(true);
    expect(hasPinnedArt(TOKEN)).toBe(false);
    const f = fakeFetch([]);
    expect(await resolveIconOverride(PNEE_TOKEN_ID, issuerKey, f, NOW)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('icon override: publishing from the wallet (real applyAip path)', () => {
  /** A BRC-100-shaped mock: derives keys and signs like the real wallet; createAction builds and returns the tx as BEEF. */
  function mockWallet(opts: { wrongTx?: boolean; noTx?: boolean } = {}) {
    const kd = new KeyDeriver(issuer);
    const made: Transaction[] = [];
    const wallet = {
      getPublicKey: async (a: {
        identityKey?: boolean;
        protocolID: [0 | 1 | 2, string];
        keyID: string;
        counterparty?: string;
        forSelf?: boolean;
      }) => ({
        publicKey: a.identityKey
          ? issuer.toPublicKey().toString()
          : kd.derivePublicKey(a.protocolID, a.keyID, a.counterparty ?? 'self', a.forSelf).toString(),
      }),
      createSignature: async (a: {
        protocolID: [0 | 1 | 2, string];
        keyID: string;
        counterparty?: string;
        hashToDirectlySign: number[];
      }) => ({
        signature: ECDSA.sign(
          new BigNumber(a.hashToDirectlySign),
          kd.derivePrivateKey(a.protocolID, a.keyID, a.counterparty ?? 'self'),
          true,
        ).toDER() as number[],
      }),
      createAction: async (a: { outputs: { lockingScript: string; satoshis: number }[] }) => {
        const tx = new Transaction();
        for (const o of a.outputs)
          tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
        tx.addOutput({ lockingScript: new P2PKH().lock(issuer.toPublicKey().toAddress()), satoshis: 321 });
        made.push(tx);
        const shown = opts.wrongTx ? overrideTx({ ts: 1, salt: 5 }) : tx;
        return { txid: tx.id('hex'), tx: opts.noTx ? undefined : shown.toAtomicBEEF(true) };
      },
    };
    return { ctx: { wallet } as unknown as OneSatContext, made };
  }

  test('publish → verified against the returned tx → cached at once, before any node has it', async () => {
    const { ctx, made } = mockWallet();
    const heard: string[] = [];
    onOverrideChange((id) => heard.push(id));
    const res = await publishIconOverride(ctx, TOKEN, ICON_B, NOW);
    expect(res.error).toBeUndefined();
    expect(res.txid).toBe(made[0].id('hex'));
    expect(res.override).toMatchObject({ tokenId: TOKEN, icon: ICON_B, ts: secs, identityKey: issuerKey });
    // the statement really is signed with the icon key, and a stranger-free reader accepts it
    expect(overridesInTx(made[0], TOKEN, issuerKey, secs)).toHaveLength(1);
    expect(iconSigningKey(issuerKey).toAddress()).toBe(
      overridesInTx(made[0], TOKEN, issuerKey, secs).length
        ? iconSigningPrivateKey(issuer).toPublicKey().toAddress()
        : '',
    );
    // cached and announced with no network at all
    expect(cachedOverride(TOKEN, issuerKey, NOW)?.icon).toBe(ICON_B);
    expect(heard).toContain(TOKEN);
    expect(calls).toEqual([]);
  });

  test('lag: the node and the index do not have the tx yet; the wallet still shows it, also after the cache expires', async () => {
    const { ctx } = mockWallet();
    await publishIconOverride(ctx, TOKEN, ICON_B, NOW);
    const lagging = fakeFetch([], { listed: [] }); // WOC 404s, index empty
    // inside the hour: straight from the cache
    expect((await resolveIconOverride(TOKEN, issuerKey, lagging, NOW + 60_000))?.icon).toBe(ICON_B);
    // after it: the lookup finds nothing and cannot fetch the tx, but does not drop what it verified
    const later = NOW + 2 * 3600_000;
    expect((await resolveIconOverride(TOKEN, issuerKey, lagging, later))?.icon).toBe(ICON_B);
  });

  test('a wallet that returns a different tx, or none, is not trusted: nothing is cached from it', async () => {
    for (const opts of [{ wrongTx: true }, { noTx: true }]) {
      clearOverrideCache();
      const { ctx } = mockWallet(opts);
      const res = await publishIconOverride(ctx, TOKEN, ICON_B, NOW);
      expect(res.txid).toBeTruthy();
      expect(res.override).toBeUndefined();
      expect(cachedOverride(TOKEN, issuerKey, NOW)).toBeUndefined();
    }
  });

  test('a bad image id is refused before anything is signed', async () => {
    const { ctx, made } = mockWallet();
    const res = await publishIconOverride(ctx, TOKEN, 'https://evil.example/x.png', NOW);
    expect(res.error).toBeTruthy();
    expect(made).toHaveLength(0);
  });
});
