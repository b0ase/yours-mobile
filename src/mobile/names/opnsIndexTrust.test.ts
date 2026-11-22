import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, PushDrop, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { IDENTITY_FIELD, P1SAT_PROTOCOL, PROFILE_FIELD, opnsRegisterKeyId } from '@1sat/types';
import { encodeProfile } from '@1sat/utils';
import { destinationFor, opnsTrustLabel, parseRecipient, resolveRecipient, UNBOUND_NAME, type Fetch } from './names';
import { resolveCallee, verifyCaller } from '../calls/peer';

/**
 * b-Aware cluster opns-indexer (rows 213, 71, 77, 251, 313, 336, 367, 388): an OpNS name's payee came from ONE
 * GorillaPool answer, and the card said "Verified on chain" whenever that answer carried an opns.idKey string.
 * Now the owner output is checked on WhatsOnChain (exists, 1 sat, pays the owner, unspent) and against the
 * 1sat-stack name index (the outpoint's inscription origin is the name's registered origin). The key counts as
 * "Verified on chain" only when the owner output carries the identity binding its key signed.
 */

const NAME = 'satchmo';
const ORIGIN = `${'a'.repeat(64)}_2`;
const PREV = `${'b'.repeat(64)}.0`;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const GP = `https://ordinals.gorillapool.io/api/opns/${NAME}`;
const ONESAT_ORIGIN = `https://api.1sat.app/1sat/opns/origin/${NAME}`;

const ownerKey = PrivateKey.fromRandom();
const OWNER = ownerKey.toAddress();
const ATTACKER = PrivateKey.fromRandom().toAddress();
const idPriv = PrivateKey.fromRandom();
const ID_KEY = idPriv.toPublicKey().toString();

/** A one-input tx whose output 0 is `lock` (1 sat unless given). */
const ownerTx = (lock: import('@bsv/sdk').LockingScript, sats = 1) => {
  const tx = new Transaction();
  const [txid, vout] = PREV.split('.');
  tx.addInput({ sourceTXID: txid, sourceOutputIndex: Number(vout), unlockingScript: new UnlockingScript() });
  tx.addOutput({ lockingScript: lock, satoshis: sats });
  return tx;
};

/** The registerOpns identity binding: a PushDrop signed by `signer`, naming `identity` as the key. */
const boundLock = async (signer: PrivateKey, identity: string) => {
  const fields = [
    Utils.toArray(IDENTITY_FIELD, 'utf8'),
    Utils.toArray(identity, 'hex'),
    Utils.toArray(PROFILE_FIELD, 'utf8'),
    encodeProfile({ domain: '1sat.name' }),
  ];
  return new PushDrop(new ProtoWallet(signer)).lock(
    fields,
    P1SAT_PROTOCOL as never,
    opnsRegisterKeyId(PREV),
    'anyone',
    true,
    true,
  );
};

type Route = unknown | number | { text: string };

/** Route table: exact url → JSON body, a status number, or { text }. Unknown urls answer 404. */
const mock = (routes: Record<string, Route>): Fetch => {
  return async (url) => {
    const body = url in routes ? routes[url] : 404;
    if (body === 'down') throw new Error('offline');
    if (typeof body === 'number') return new Response('{}', { status: body });
    if (body && typeof body === 'object' && 'text' in (body as object))
      return new Response((body as { text: string }).text, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
};

/** Every source agreeing on a name held at output 0 of `tx` by `owner`. Override any url to make one disagree. */
const world = (tx: Transaction, owner: string, idKey?: string, over: Record<string, Route> = {}) => {
  const txid = tx.id('hex');
  return mock({
    [GP]: { outpoint: `${txid}_0`, origin: ORIGIN, owner, map: idKey ? { 'opns.idKey': idKey } : null },
    [`${WOC}/tx/${txid}/hex`]: { text: tx.toHex() },
    [`${WOC}/tx/${txid}/0/spent`]: 404,
    [ONESAT_ORIGIN]: { name: NAME, outpoint: ORIGIN.replace('_', '.') },
    [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: {
      outpoint: `${txid}.0`,
      origin: ORIGIN.replace('_', '.'),
      contentType: 'application/op-ns',
      sequence: 0,
    },
    ...over,
  });
};

const resolve = (f: Fetch) => resolveRecipient(f, parseRecipient(NAME));

describe('OpNS payee: one index answer is not enough', () => {
  test('owner output carries a binding its key signed, every source agrees: "Verified on chain"', async () => {
    const lock = await boundLock(idPriv, ID_KEY);
    const tx = ownerTx(lock);
    const owner = PushDrop.decode(lock).lockingPublicKey.toAddress();
    const r = await resolve(world(tx, owner, ID_KEY));
    expect(destinationFor(r, 'bsv')).toEqual({ ok: true, to: owner });
    expect(r.pubkey).toBe(ID_KEY);
    expect(opnsTrustLabel(r)).toEqual({ verified: true, text: expect.stringContaining('Verified on chain') });
  });

  test('a chain binding never makes a name payable that the index calls unbound', async () => {
    const tx = ownerTx(await boundLock(idPriv, ID_KEY));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    const r = await resolve(world(tx, owner));
    expect(r.pubkey).toBeUndefined();
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: UNBOUND_NAME });
  });

  test('an index-only opns.idKey (no signed binding on chain) shows the weaker label, never "Verified on chain"', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const r = await resolve(world(tx, OWNER, ID_KEY));
    expect(destinationFor(r, 'bsv')).toEqual({ ok: true, to: OWNER });
    const label = opnsTrustLabel(r);
    expect(label?.verified).toBe(false);
    expect(label?.text).toContain('From the OpNS name list');
    expect(label?.text).not.toContain('Verified on chain');
  });

  test('a single lying index (owner is not who the output pays) is refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    await expect(resolve(world(tx, ATTACKER, ID_KEY))).rejects.toThrow(/doesn't match/);
  });

  test("a lying index pointing at someone else's coin (not this name's inscription) is refused", async () => {
    const tx = ownerTx(new P2PKH().lock(ATTACKER));
    const txid = tx.id('hex');
    const f = world(tx, ATTACKER, ID_KEY, {
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: {
        outpoint: `${txid}.0`,
        origin: `${'d'.repeat(64)}.0`,
        contentType: 'application/op-ns',
      },
    });
    await expect(resolve(f)).rejects.toThrow(/doesn't match/);
  });

  test('the two name indexes give different origins: refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const f = world(tx, OWNER, ID_KEY, { [ONESAT_ORIGIN]: { name: NAME, outpoint: `${'e'.repeat(64)}.2` } });
    await expect(resolve(f)).rejects.toThrow(/doesn't match/);
  });

  test('a spent owner output (index behind, or lying) is refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const txid = tx.id('hex');
    const f = world(tx, OWNER, ID_KEY, { [`${WOC}/tx/${txid}/0/spent`]: { txid: 'c'.repeat(64), vin: 0 } });
    await expect(resolve(f)).rejects.toThrow(/moved/);
  });

  test('an owner output that is not a 1-sat ordinal is refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER), 5000);
    await expect(resolve(world(tx, OWNER, ID_KEY))).rejects.toThrow(/doesn't match/);
  });

  test('the chain binding names a different key than the index: refused', async () => {
    const other = PrivateKey.fromRandom();
    const tx = ownerTx(await boundLock(other, other.toPublicKey().toString()));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    await expect(resolve(world(tx, owner, ID_KEY))).rejects.toThrow(/doesn't match/);
  });

  test('a forged binding (identity field not signed by that key) is never shown as bound, and is not paid', async () => {
    const forger = PrivateKey.fromRandom();
    const tx = ownerTx(await boundLock(forger, ID_KEY));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    const r = await resolve(world(tx, owner, ID_KEY));
    expect(opnsTrustLabel(r)).toBeUndefined();
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: UNBOUND_NAME });
  });

  test('WhatsOnChain unreachable: the weaker label, never "Verified on chain"', async () => {
    const lock = await boundLock(idPriv, ID_KEY);
    const tx = ownerTx(lock);
    const owner = PushDrop.decode(lock).lockingPublicKey.toAddress();
    const txid = tx.id('hex');
    const f = world(tx, owner, ID_KEY, { [`${WOC}/tx/${txid}/hex`]: 'down', [`${WOC}/tx/${txid}/0/spent`]: 500 });
    const r = await resolve(f);
    expect(opnsTrustLabel(r)).toEqual({ verified: false, text: expect.stringContaining('From the OpNS name list') });
  });

  test('the 1sat name index unreachable: the weaker label', async () => {
    const lock = await boundLock(idPriv, ID_KEY);
    const tx = ownerTx(lock);
    const owner = PushDrop.decode(lock).lockingPublicKey.toAddress();
    const r = await resolve(world(tx, owner, ID_KEY, { [ONESAT_ORIGIN]: 503 }));
    expect(opnsTrustLabel(r)?.verified).toBe(false);
  });

  test("a lying index pointing at the attacker's plain coin (ORDFS: no inscription there) is refused", async () => {
    // Live ORDFS answer for a non-inscription outpoint: 200, no origin, empty content type (checked 22 Nov 2026).
    const tx = ownerTx(new P2PKH().lock(ATTACKER));
    const txid = tx.id('hex');
    const f = world(tx, ATTACKER, ID_KEY, {
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: {
        contentLength: 0,
        contentType: '',
        outpoint: `${txid}.0`,
        sequence: 0,
      },
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('a plain coin is refused even when the 1sat name index is unreachable', async () => {
    const tx = ownerTx(new P2PKH().lock(ATTACKER));
    const txid = tx.id('hex');
    const f = world(tx, ATTACKER, ID_KEY, {
      [ONESAT_ORIGIN]: 503,
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: { contentLength: 0, contentType: '', sequence: 0 },
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('the coin holds an inscription with the right origin but it is not an OpNS name: refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const txid = tx.id('hex');
    const f = world(tx, OWNER, ID_KEY, {
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: {
        outpoint: `${txid}.0`,
        origin: ORIGIN.replace('_', '.'),
        contentType: 'text/plain',
      },
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('the index leaves out the outpoint: refused, not paid on its word', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const f = world(tx, OWNER, ID_KEY, { [GP]: { origin: ORIGIN, owner: OWNER, map: { 'opns.idKey': ID_KEY } } });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('the index sends a malformed outpoint: refused', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const f = world(tx, OWNER, ID_KEY, {
      [GP]: { outpoint: 'not-an-outpoint', origin: ORIGIN, owner: OWNER, map: { 'opns.idKey': ID_KEY } },
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('a made-up outpoint no source has heard of (all answer "not found") is refused', async () => {
    // Live answers for a fabricated txid (22 Nov 2026): ORDFS 404 "not found in BEEF", WoC hex 404, WoC spent 400.
    const fake = 'f'.repeat(64);
    const f = mock({
      [GP]: { outpoint: `${fake}_0`, origin: ORIGIN, owner: ATTACKER, map: { 'opns.idKey': ID_KEY } },
      [ONESAT_ORIGIN]: { name: NAME, outpoint: ORIGIN.replace('_', '.') },
      [`${WOC}/tx/${fake}/hex`]: 404,
      [`${WOC}/tx/${fake}/0/spent`]: 400,
      [`https://api.1sat.app/1sat/ordfs/metadata/${fake}_0:-2`]: 404,
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test("WhatsOnChain says the coin's transaction does not exist: refused, even if ORDFS is down", async () => {
    const tx = ownerTx(await boundLock(idPriv, ID_KEY));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    const txid = tx.id('hex');
    const f = world(tx, owner, ID_KEY, {
      [`${WOC}/tx/${txid}/hex`]: 404,
      [`${WOC}/tx/${txid}/0/spent`]: 'down',
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: 'down',
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('WhatsOnChain spent check says the transaction is unknown (400): refused', async () => {
    const tx = ownerTx(await boundLock(idPriv, ID_KEY));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    const txid = tx.id('hex');
    const f = world(tx, owner, ID_KEY, {
      [`${WOC}/tx/${txid}/hex`]: 503,
      [`${WOC}/tx/${txid}/0/spent`]: 400,
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: 'down',
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('ORDFS says the coin does not exist (404): refused', async () => {
    const tx = ownerTx(await boundLock(idPriv, ID_KEY));
    const owner = PushDrop.decode(tx.outputs[0].lockingScript).lockingPublicKey.toAddress();
    const txid = tx.id('hex');
    const f = world(tx, owner, ID_KEY, {
      [`${WOC}/tx/${txid}/hex`]: 'down',
      [`${WOC}/tx/${txid}/0/spent`]: 'down',
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: 404,
    });
    await expect(resolve(f)).rejects.toThrow(/Not paying/);
  });

  test('rate limits and server errors are only "can\'t reach": the weaker label, still payable', async () => {
    const lock = await boundLock(idPriv, ID_KEY);
    const tx = ownerTx(lock);
    const owner = PushDrop.decode(lock).lockingPublicKey.toAddress();
    const txid = tx.id('hex');
    const f = world(tx, owner, ID_KEY, {
      [`${WOC}/tx/${txid}/hex`]: 429,
      [`${WOC}/tx/${txid}/0/spent`]: 502,
      [`https://api.1sat.app/1sat/ordfs/metadata/${txid}_0:-2`]: 429,
    });
    const r = await resolve(f);
    expect(destinationFor(r, 'bsv')).toEqual({ ok: true, to: owner });
    expect(opnsTrustLabel(r)?.verified).toBe(false);
  });

  test('an unbound name stays unpayable even when every source agrees', async () => {
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const r = await resolve(world(tx, OWNER));
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: UNBOUND_NAME });
  });
});

describe('OpNS key used to act (call, verify a caller): only a binding checked on chain and signed by its key', () => {
  test('a chain-checked, key-signed binding can be called and verifies the caller', async () => {
    const lock = await boundLock(idPriv, ID_KEY);
    const tx = ownerTx(lock);
    const owner = PushDrop.decode(lock).lockingPublicKey.toAddress();
    const f = world(tx, owner, ID_KEY);
    expect(await resolveCallee(f, NAME)).toEqual({ key: ID_KEY.toLowerCase(), label: NAME, verified: true });
    expect(await verifyCaller(f, ID_KEY.toLowerCase(), NAME)).toMatchObject({ label: NAME, verified: true });
  });

  test('⚠ every source agrees on the coin but the idKey is only the index string: no call, caller not verified', async () => {
    const attacker = PrivateKey.fromRandom().toPublicKey().toString();
    const tx = ownerTx(new P2PKH().lock(OWNER));
    const f = world(tx, OWNER, attacker);
    expect((await resolve(f)).opnsChecked).toBe('chain');
    await expect(resolveCallee(f, NAME)).rejects.toThrow(/not signed on chain/);
    expect((await verifyCaller(f, attacker, NAME)).verified).toBe(false);
  });
});
