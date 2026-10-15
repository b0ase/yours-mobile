import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import {
  addressOf,
  claimPlan,
  inviteLink,
  inviteOutputs,
  inviteSats,
  loadStoredInvites,
  MIN_INVITE_SATS,
  newInviteKey,
  parseHandles,
  parseXInviteLink,
  saveStoredInvites,
  type StoredInvite,
} from './xInvites';

const TOKEN = '8353949b27e8e16025702ce2b5d9b1ac2dad56d725eb2a38761974a857d98804_0';
const TXID = 'ab'.repeat(32);
const BASE = 'https://www.bchatx.com/i/x/AbC123';

describe('one-time keys and links', () => {
  test('every invite gets a fresh key', () => {
    const keys = Array.from({ length: 20 }, () => newInviteKey().toWif());
    expect(new Set(keys).size).toBe(20);
  });

  test('the key is only in the fragment', () => {
    const k = newInviteKey();
    const wif = k.toWif();
    const link = inviteLink(BASE, wif, TXID);
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe(BASE);
    expect(u.search).toBe('');
    expect(link.indexOf(wif)).toBeGreaterThan(link.indexOf('#'));
    expect(`${u.origin}${u.pathname}${u.search}`).not.toContain(wif);
    // A server-provided base with its own fragment can't move the key out of it.
    expect(inviteLink(`${BASE}#x`, wif, TXID).split('#').length).toBe(2);
  });

  test('a link round-trips; deep link form too; bad keys and hosts are refused', () => {
    const wif = newInviteKey().toWif();
    expect(parseXInviteLink(inviteLink(BASE, wif, TXID))).toEqual({ code: 'AbC123', wif, txid: TXID });
    expect(parseXInviteLink(`bwalletx://xinvite/AbC123#k=${wif}`)).toEqual({ code: 'AbC123', wif, txid: null });
    expect(parseXInviteLink(`${BASE}#k=notakey`)).toBeNull();
    expect(parseXInviteLink(`https://evil.example/i/x/AbC123#k=${wif}`)).toBeNull();
    expect(parseXInviteLink(`${BASE}?k=${wif}`)).toBeNull();
    expect(parseXInviteLink('https://www.bchatx.com/i/AbC123')).toBeNull();
  });

  test('handles: chips from a pasted list', () => {
    expect(
      parseHandles('@Alice, bob\n@alice https://x.com/Carol_9 x.com/dave?s=1 bad-handle! toolonghandle12345'),
    ).toEqual(['alice', 'bob', 'carol_9', 'dave']);
  });

  test('sats per invite cover the sweep and the overlay fee', () => {
    expect(inviteSats(undefined)).toBe(MIN_INVITE_SATS);
    expect(inviteSats(1000)).toBe(1500);
  });
});

describe('the funding transaction', () => {
  const keys = [newInviteKey(), newInviteKey(), newInviteKey()];
  const addrs = keys.map(addressOf);
  const outs = inviteOutputs(TOKEN, BigInt(1), addrs, 1200);

  test('N × (1 gate token + sats), in order', () => {
    expect(outs.length).toBe(6);
    addrs.forEach((a, i) => {
      const tok = outs[2 * i];
      const sats = outs[2 * i + 1];
      expect(tok.satoshis).toBe(1);
      const p2pkh = new P2PKH().lock(a).toHex();
      expect(tok.lockingScript.endsWith(p2pkh)).toBe(true);
      expect(Utils.toUTF8(Utils.toArray(tok.lockingScript, 'hex'))).toContain(
        `{"p":"bsv-20","op":"transfer","id":"${TOKEN}","amt":"1"}`,
      );
      expect(sats.lockingScript).toBe(p2pkh);
      expect(sats.satoshis).toBe(1200);
    });
  });

  test('refuses zero amounts and bad sats', () => {
    expect(() => inviteOutputs(TOKEN, BigInt(0), addrs, 1000)).toThrow();
    expect(() => inviteOutputs(TOKEN, BigInt(1), addrs, 0)).toThrow();
  });

  test('claim finds exactly its own token and sats in the funding tx', () => {
    const tx = new Transaction();
    for (const o of outs) tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
    // Someone else's change.
    tx.addOutput({ lockingScript: new P2PKH().lock(addressOf(PrivateKey.fromRandom())), satoshis: 5000 });
    const plan = claimPlan(tx, addrs[1]);
    const id = tx.id('hex');
    expect(plan.sats).toEqual([{ outpoint: `${id}_3`, satoshis: 1200, lockingScript: outs[3].lockingScript }]);
    expect(plan.tokens).toEqual([
      { outpoint: `${id}_2`, satoshis: 1, lockingScript: outs[2].lockingScript, tokenId: TOKEN, amount: '1' },
    ]);
    expect(claimPlan(tx, addressOf(PrivateKey.fromRandom()))).toEqual({ sats: [], tokens: [] });
  });
});

describe('links on this device', () => {
  // A stand-in for wallet.encrypt / decrypt: reversible, and never the plaintext.
  const wallet = {
    encrypt: async ({ plaintext }: { plaintext: number[] }) => ({ ciphertext: plaintext.map((b) => b ^ 0x5a) }),
    decrypt: async ({ ciphertext }: { ciphertext: number[] }) => ({ plaintext: ciphertext.map((b) => b ^ 0x5a) }),
  } as never;
  const mem = new Map<string, string>();
  const store = {
    secureGet: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    secureSet: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
  };

  test('saved encrypted, read back intact', async () => {
    const wif = newInviteKey().toWif();
    const inv: StoredInvite = {
      code: 'c1',
      x_handle: 'alice',
      funded_address: '1abc',
      wif,
      txid: TXID,
      url: inviteLink(BASE, wif, TXID),
      created_at: '2026-10-15T00:00:00Z',
    };
    await saveStoredInvites(wallet, '$SCAMMERSCARTEL', [inv], store);
    const raw = [...mem.values()].join('');
    expect(raw).not.toContain(wif);
    expect(await loadStoredInvites(wallet, 'scammerscartel', store)).toEqual([inv]);
  });
});
