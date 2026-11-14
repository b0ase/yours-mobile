// Exchange › Contracts catalogue: a paid listing must be signed by its author (owner, 14 Nov 2026, b-Aware row 115;
// the wallet side is src/mobile/contracts/contractNft.ts). These drive the real publish route (api/contracts.js)
// with the chain and the database answered in memory; every key is a throwaway made here.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { LockingScript, OP, P2PKH, PrivateKey, ProtoWallet, Transaction, Utils } from '@bsv/sdk';
import K from '../lib/strategyKeys.js';
import C from '../lib/contracts.js';
import api from '../api/contracts.js';

// ---- the signature, written out from the spec (not the module under test) ----
const sorted = (v) =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
const bytesToSign = (env) => {
  const { authorSig: _s, ...rest } = env;
  return Utils.toArray(JSON.stringify(sorted(rest)), 'utf8');
};
const person = (n) => {
  const priv = new PrivateKey(n);
  return { wallet: new ProtoWallet(priv), key: priv.toPublicKey().toString(), address: priv.toAddress() };
};
const ann = person(11);
const mallory = person(12);
/** The wallet's own publish: the author's key and handle, then the signature over the rest. */
const signAs = async (who, env, over = {}) => {
  const unsigned = { ...env, author: { ...env.author, identityKey: who.key, handle: 'ann@bwallet.space', ...over } };
  const { signature } = await who.wallet.createSignature({
    data: bytesToSign(unsigned),
    protocolID: [2, 'bwallet contract'],
    keyID: '1',
    counterparty: 'anyone',
  });
  return { ...unsigned, authorSig: Utils.toHex(signature) };
};
const listing = (who, priceUsd = 5, over = {}) => ({
  format: 'bwalletx.contract-nft/1',
  contract: { format: 'bwalletx.contract/1', name: 'NDA', version: '1', network: 'mainnet', summary: 's' },
  description: 'A plain NDA',
  author: { name: 'Ann Lawyer', address: who.address },
  sale: { priceUsd, copies: 10, payTo: who.address },
  ...over,
});

// ---- the chain and the catalogue table, in memory ----
const txs = new Map();
let table = [];
let clock = 0;
const queries = [];
const fakeDb = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname !== '/rest/v1/bwallet_contracts') throw new Error(`unexpected fetch ${u.pathname}`);
  if (init.method === 'POST') {
    const row = JSON.parse(init.body);
    if (table.some((r) => r.origin === row.origin)) return new Response('{}', { status: 409 });
    table.push({ ...row, created_at: new Date(1_800_000_000_000 + clock++).toISOString() });
    return new Response('', { status: 201 });
  }
  const name = u.searchParams.get('envelope->contract->>name');
  queries.push(name);
  const out = table
    .filter((r) => !name || name === `eq.${r.envelope.contract.name}`)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return new Response(JSON.stringify(out), { status: 200 });
};
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let saved;
beforeAll(() => {
  saved = { chain: { ...K.chain }, fetch: globalThis.fetch, env: ENV_KEYS.map((k) => process.env[k]) };
  K.chain.tx = async (txid) => txs.get(txid) ?? null;
  K.chain.spent = async () => false;
  K.chain.origin = async () => null;
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
  globalThis.fetch = fakeDb;
});
afterAll(() => {
  Object.assign(K.chain, saved.chain);
  globalThis.fetch = saved.fetch;
  ENV_KEYS.forEach((k, i) => {
    if (saved.env[i] === undefined) delete process.env[k];
    else process.env[k] = saved.env[i];
  });
});
beforeEach(() => {
  table = [];
  queries.length = 0;
});

const inscribed = (body, to) => {
  const data = Utils.toArray(body, 'utf8');
  return new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_IF },
    { op: 3, data: Utils.toArray('ord', 'utf8') },
    { op: OP.OP_1 },
    { op: C.CONTRACT_TYPE.length, data: Utils.toArray(C.CONTRACT_TYPE, 'utf8') },
    { op: OP.OP_0 },
    { op: OP.OP_PUSHDATA2, data },
    { op: OP.OP_ENDIF },
    ...new P2PKH().lock(to).chunks,
  ]);
};
let ip = 0;
/** Mint `env` to a fresh key and publish it the way the wallet does: [status, body]. */
const publish = async (env) => {
  const minter = PrivateKey.fromRandom();
  const tx = new Transaction();
  tx.addOutput({ lockingScript: inscribed(JSON.stringify(env), minter.toAddress()), satoshis: 1 });
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 2 });
  const txid = tx.id('hex');
  txs.set(txid, tx);
  const outpoint = `${txid}_0`;
  const message = K.proofMessage('publish', outpoint, Date.now());
  const body = {
    action: 'publish',
    outpoint,
    message,
    pubkey_hex: minter.toPublicKey().toString(),
    signature: Utils.toHex(minter.sign(Utils.toArray(message, 'utf8')).toDER()),
  };
  const res = {
    statusCode: 0,
    out: null,
    setHeader() {},
    end(s) {
      this.out = s ? JSON.parse(s) : null;
    },
  };
  await api({ method: 'POST', url: '/api/contracts', headers: { 'x-forwarded-for': `10.0.0.${ip++}` }, body }, res);
  return [res.statusCode, res.out];
};

describe('contract catalogue: paid listings are signed by their author', () => {
  test('a genuine signed paid listing is listed', async () => {
    const [status, out] = await publish(await signAs(ann, listing(ann)));
    expect(status).toBe(200);
    expect(out.ok).toBe(true);
    expect(table).toHaveLength(1);
    expect(table[0].envelope.author.identityKey).toBe(ann.key);
  });

  test('an unsigned paid listing is refused', async () => {
    expect((await publish(listing(ann)))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test('a bad signature is refused', async () => {
    const env = await signAs(ann, listing(ann));
    const last = (parseInt(env.authorSig.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
    expect((await publish({ ...env, authorSig: env.authorSig.slice(0, -2) + last }))[0]).toBe(400);
    expect((await publish({ ...env, authorSig: 'ab'.repeat(35) }))[0]).toBe(400);
    expect((await publish({ ...env, authorSig: 'not hex' }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test('a field changed after signing is refused (price, copies, payee, text)', async () => {
    const env = await signAs(ann, listing(ann));
    expect((await publish({ ...env, sale: { ...env.sale, priceUsd: 50 } }))[0]).toBe(400);
    expect((await publish({ ...env, sale: { ...env.sale, copies: 1000 } }))[0]).toBe(400);
    expect((await publish({ ...env, description: 'A different NDA' }))[0]).toBe(400);
    // Redirecting the money needs both the payee and the author's address changed: the signature covers both.
    const to = mallory.address;
    expect(
      (await publish({ ...env, author: { ...env.author, address: to }, sale: { ...env.sale, payTo: to } }))[0],
    ).toBe(400);
    expect((await publish({ ...env, author: { ...env.author, handle: 'mallory@bwallet.space' } }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test("the wrong key is refused: another key's signature, or another author's key claimed", async () => {
    // Mallory signs but claims Ann's key.
    const claimsAnn = await signAs(mallory, listing(ann), { identityKey: ann.key });
    expect((await publish(claimsAnn))[0]).toBe(400);
    // Ann's genuine signature with the key swapped for Mallory's.
    const env = await signAs(ann, listing(ann));
    expect((await publish({ ...env, author: { ...env.author, identityKey: mallory.key } }))[0]).toBe(400);
    expect(table).toHaveLength(0);
  });

  test("a signed paid listing that pays anyone but the author's address is refused", async () => {
    const env = await signAs(ann, listing(ann, 5, { sale: { priceUsd: 5, copies: 10, payTo: mallory.address } }));
    const [status, out] = await publish(env);
    expect(status).toBe(400);
    expect(out.error).toContain('author’s address');
    expect(table).toHaveLength(0);
  });

  test('a malformed identity key is refused', async () => {
    const upper = ann.key.toUpperCase();
    const uncompressed = new PrivateKey(11).toPublicKey().encode(false, 'hex');
    for (const bad of [upper, uncompressed, `04${ann.key.slice(2)}`, ann.key.slice(0, 64), 42]) {
      // Signed over the bad claim by Ann's real key: only the key's shape is wrong.
      const unsigned = { ...listing(ann), author: { ...listing(ann).author, identityKey: bad } };
      const { signature } = await ann.wallet.createSignature({
        data: bytesToSign(unsigned),
        protocolID: [2, 'bwallet contract'],
        keyID: '1',
        counterparty: 'anyone',
      });
      expect((await publish({ ...unsigned, authorSig: Utils.toHex(signature) }))[0]).toBe(400);
    }
    expect(table).toHaveLength(0);
  });

  test('a clone under another key is refused; the earliest listing stays', async () => {
    expect((await publish(await signAs(ann, listing(ann))))[0]).toBe(200);
    // Same contract and description, Mallory's own key, address and payee: a valid signed listing on its own.
    const clone = await signAs(mallory, listing(mallory));
    const [status, out] = await publish(clone);
    expect(status).toBe(409);
    expect(out.error).toContain('another author');
    expect(table).toHaveLength(1);
    expect(table[0].envelope.author.identityKey).toBe(ann.key);
    // The lookup asked only for listings of this contract's name (as PostgREST reads the encoded query).
    expect(queries).toContain('eq.NDA');
    // Key order in the descriptor doesn't hide a clone.
    const reordered = await signAs(
      mallory,
      listing(mallory, 5, {
        contract: { summary: 's', network: 'mainnet', version: '1', name: 'NDA', format: 'bwalletx.contract/1' },
      }),
    );
    expect((await publish(reordered))[0]).toBe(409);
    // Ann listing it again, and Mallory listing a different contract, are fine.
    expect((await publish(await signAs(ann, listing(ann, 7))))[0]).toBe(200);
    expect((await publish(await signAs(mallory, listing(mallory, 5, { description: 'Mallory’s NDA' }))))[0]).toBe(200);
  });

  test('an unsigned free clone under another address is refused', async () => {
    expect((await publish(listing(ann, 0)))[0]).toBe(200);
    expect((await publish(listing(mallory, 0)))[0]).toBe(409);
    expect(table).toHaveLength(1);
  });

  test('a free unsigned listing is still listed, as before', async () => {
    const [status, out] = await publish(listing(ann, 0));
    expect(status).toBe(200);
    expect(out.ok).toBe(true);
    expect(table[0].envelope.authorSig).toBeUndefined();
  });

  test('a free listing from the wallet (signed) is listed', async () => {
    expect((await publish(await signAs(ann, listing(ann, 0))))[0]).toBe(200);
  });
});
