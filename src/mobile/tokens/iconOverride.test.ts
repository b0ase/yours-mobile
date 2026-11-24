import { beforeEach, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { issuerSigningPrivateKey, signIssueWithKey } from '../issuer/issuer';
import { REGISTRY, WOC_TX_HEX } from '../issuer/issuerVerify';
import {
  clearOverrideCache,
  iconOverrideScript,
  newestOverride,
  overridesInTx,
  pickIcon,
  resolveIconOverride,
} from './iconOverride';

const TOKEN = `${'ab'.repeat(32)}_0`;
const ICON_A = `${'a1'.repeat(32)}_0`;
const ICON_B = `${'b2'.repeat(32)}_0`;
const DEPLOY_ICON = 'https://ordfs.example/deploy-icon';
const NOW = 1_800_000_000_000;
const secs = NOW / 1000;

const issuer = PrivateKey.fromRandom();
const issuerKey = issuer.toPublicKey().toString();
const stranger = PrivateKey.fromRandom();

/** A tx carrying one override statement. `signer` signs; `claim` is the identity_key it states. */
function overrideTx(o: {
  icon?: string;
  ts: number;
  signer?: PrivateKey;
  claim?: string;
  tokenId?: string;
  salt?: number;
}) {
  const unsigned = iconOverrideScript({
    tokenId: o.tokenId ?? TOKEN,
    icon: o.icon ?? ICON_A,
    ts: o.ts,
    identityKey: o.claim ?? issuerKey,
  });
  const signed = signIssueWithKey(unsigned, issuerSigningPrivateKey(o.signer ?? issuer));
  const tx = new Transaction();
  tx.addOutput({ lockingScript: signed, satoshis: 0 });
  // Different change amounts give each tx its own txid.
  tx.addOutput({ lockingScript: new P2PKH().lock(issuer.toPublicKey().toAddress()), satoshis: 500 + (o.salt ?? 0) });
  return tx;
}

/** A fetch that serves a txid list from the registry and tx hex from the indexer. */
function fakeFetch(txs: Transaction[], listed = txs.map((t) => t.id('hex'))) {
  const byId = new Map(txs.map((t) => [t.id('hex'), t.toHex()]));
  return (async (url: string) => {
    if (url === `${REGISTRY}/${TOKEN}/icon`) return new Response(JSON.stringify({ txids: listed }));
    for (const [id, hex] of byId) if (url === WOC_TX_HEX(id)) return new Response(hex);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

// Other test files leave their own localStorage shims on globalThis; start each test from a clean one.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  clearOverrideCache();
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
    const tx = overrideTx({ ts: secs, tokenId: `${'cd'.repeat(32)}_0` });
    expect(overridesInTx(tx, TOKEN, issuerKey, secs)).toEqual([]);
  });

  test('a ts far in the future is ignored; a tampered field breaks the signature', () => {
    expect(overridesInTx(overrideTx({ ts: secs + 3 * 86400 }), TOKEN, issuerKey, secs)).toEqual([]);
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

  test('no override: the deploy icon is used', async () => {
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([]), NOW);
    expect(o).toBeNull();
    expect(pickIcon(DEPLOY_ICON, o)).toBe(DEPLOY_ICON);
  });

  test('a lookup failure shows the deploy icon and is not cached', async () => {
    const down = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await resolveIconOverride(TOKEN, issuerKey, down, NOW)).toBeNull();
    const tx = overrideTx({ ts: secs - 5 });
    expect((await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx]), NOW + 1))?.icon).toBe(ICON_A);
  });

  test('a just-published override shows at once from its own txid, even if the index has not caught up', async () => {
    const tx = overrideTx({ ts: secs - 1 });
    const o = await resolveIconOverride(TOKEN, issuerKey, fakeFetch([tx], []), NOW, [tx.id('hex')]);
    expect(o?.icon).toBe(ICON_A);
  });
});
