import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANNEL_PROTOCOL_ID,
  CODE_PREFIX,
  PAYMENT_PROTOCOL_ID,
  randomBytes,
  toBase64,
} from '../../vendor/webrtpay/index';
import { guardReservedProtocols, reservedProtocolRefusal } from '../../services/reservedProtocols';
import { labelFor } from '../wallet/txHistory';
import { DIRECT_PAY_ENABLED } from '../storeBuild';
import { isDirectPayCode } from './code';
import {
  HISTORY_TEXT,
  MAX_DIRECT_SATS,
  payOverChannel,
  pendingStore,
  previewOffer,
  receiveHandlers,
  seenStore,
  stunServers,
  validSats,
} from './directPay';
import { makeTestWallet, memoryKV } from './testkit';
import { P2PKH, PublicKey } from '@bsv/sdk';

const idKey = async (w: { getPublicKey: (a: { identityKey: true }) => Promise<{ publicKey: string }> }) =>
  (await w.getPublicKey({ identityKey: true })).publicKey;

/** A token from payer to payee, built the way payOverChannel builds it. */
const tokenFor = async (payer: ReturnType<typeof makeTestWallet>, payee: string, sats: number) => {
  const derivationPrefix = toBase64(randomBytes(32));
  const derivationSuffix = toBase64(randomBytes(32));
  const { publicKey } = await payer.wallet.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payee,
  });
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex();
  const r = await payer.wallet.createAction({
    description: 'test',
    outputs: [{ satoshis: sats, lockingScript, outputDescription: 'x' }],
    options: { noSend: true },
  });
  return {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: r.tx as number[],
    amount: sats,
    outputIndex: 0,
  };
};

describe('phone to phone: codes and flag', () => {
  test('the Scan sheet prefix is the package prefix', () => {
    expect(CODE_PREFIX).toBe('webrtpay1:');
    expect(isDirectPayCode(`${CODE_PREFIX}abc`)).toBe(true);
    expect(isDirectPayCode(' WEBRTPAY1:abc')).toBe(true);
    expect(isDirectPayCode('bitcoin:1abc')).toBe(false);
    expect(isDirectPayCode(null)).toBe(false);
  });

  test('flag is off by default (no VITE_DIRECT_PAY in tests)', () => {
    expect(DIRECT_PAY_ENABLED).toBe(false);
  });

  test('nothing outside directPay/ imports the vendored package, and the Scan sheet loads the sheet lazily', () => {
    const root = join(import.meta.dir, '..', '..');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
      });
    const offenders = walk(root).filter(
      (f) =>
        !f.includes(`${join('mobile', 'directPay')}`) &&
        !f.includes(join('vendor', 'webrtpay')) &&
        // A static import (from '…') of the vendored package or the glue; the lazy import() is fine.
        /from\s+['"][^'"]*(vendor\/webrtpay|directPay\/directPay|directPay\/DirectPaySheet)['"]/.test(
          readFileSync(f, 'utf8'),
        ),
    );
    expect(offenders).toEqual([]);
    const scan = readFileSync(join(root, 'mobile', 'scan', 'ScanSheet.tsx'), 'utf8');
    expect(scan).toMatch(/DIRECT_PAY_ENABLED/);
    expect(scan).toContain("DIRECT_PAY_ENABLED ? lazy(() => import('../directPay/DirectPaySheet')) : null");
  });

  test('STUN list: default, custom, junk dropped', () => {
    expect(stunServers(undefined)).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    expect(stunServers('stun:a.example:3478, http://x, ')).toEqual([{ urls: ['stun:a.example:3478'] }]);
    expect(stunServers('nope')).toEqual([]);
  });

  test('amount bounds', () => {
    expect(validSats(1)).toBe(true);
    expect(validSats(MAX_DIRECT_SATS)).toBe(true);
    for (const v of [0, -1, 1.5, MAX_DIRECT_SATS + 1, NaN, '5']) expect(validSats(v)).toBe(false);
  });

  test('History labels both sides "phone to phone"', () => {
    expect(labelFor('in', { description: `${HISTORY_TEXT} from 02abcd…ef01` })).toBe('phone to phone');
    expect(labelFor('out', { description: `${HISTORY_TEXT} payment to 02abcd…ef01` })).toBe('phone to phone');
  });

  test('a garbage or answer-shaped code is refused with a user message', () => {
    expect(() => previewOffer('webrtpay1:AAAA')).toThrow(/phone-to-phone|code/i);
  });
});

describe('phone to phone: reserved protocol (audit C1)', () => {
  test('outside apps cannot use the channel, signaling or relay keys; the wallet itself can', async () => {
    for (const name of ['webrtpay channel', 'webrtpay signaling', 'webrtpay relay'])
      for (const m of ['createSignature', 'getPublicKey', 'encrypt', 'decrypt', 'createHmac'])
        expect(reservedProtocolRefusal(m, { protocolID: [2, name], keyID: 'k' })).toMatch(/reserved/);
    expect(CHANNEL_PROTOCOL_ID).toEqual([2, 'webrtpay channel']);

    const reached: string[] = [];
    const manager = {
      createSignature: async (_a: unknown, o?: string) => void reached.push(String(o)),
      ensureProtocolPermission: async () => true,
    };
    const guarded = guardReservedProtocols(manager, 'admin-id');
    await expect(
      guarded.createSignature({ protocolID: CHANNEL_PROTOCOL_ID, keyID: 'k', data: [1] }, 'evil.example'),
    ).rejects.toThrow(/reserved/);
    await guarded.createSignature({ protocolID: CHANNEL_PROTOCOL_ID, keyID: 'k', data: [1] }, 'admin-id');
    expect(reached).toEqual(['admin-id']);
  });

  test('BRC-29 payment keys stay shared (outside payers derive them), but never for raw-hash signing', () => {
    expect(reservedProtocolRefusal('getPublicKey', { protocolID: PAYMENT_PROTOCOL_ID, keyID: 'a b' })).toBeNull();
    expect(
      reservedProtocolRefusal('createSignature', { protocolID: PAYMENT_PROTOCOL_ID, hashToDirectlySign: [1] }),
    ).not.toBeNull();
  });
});

describe('phone to phone: payee validates before internalizing', () => {
  test('a valid payment is internalized once, labelled for History; a re-delivery is not internalized again', async () => {
    const payer = makeTestWallet();
    const payee = makeTestWallet();
    const sender = await idKey(payer.wallet);
    const token = await tokenFor(payer, await idKey(payee.wallet), 1234);
    const got: unknown[] = [];
    const h = receiveHandlers({ wallet: payee.wallet, seen: seenStore(memoryKV()), onReceived: (r) => got.push(r) });
    const ctx = { txid: '' };
    expect(await h.onPayment({ sender, token, messageId: 'm1' } as never, ctx)).toBe('accepted');
    expect(await h.onPayment({ sender, token, messageId: 'm2' } as never, ctx)).toBe('accepted');
    expect(payee.calls.internalize).toHaveLength(1);
    expect(payee.calls.internalize[0].description).toStartWith(`${HISTORY_TEXT} from `);
    expect(payee.calls.internalize[0].outputs[0].protocol).toBe('wallet payment');
    expect(got).toMatchObject([
      { sats: 1234, duplicate: false },
      { sats: 1234, duplicate: true },
    ]);
  });

  test('a token whose amount does not match its output is refused and nothing is stored', async () => {
    const payer = makeTestWallet();
    const payee = makeTestWallet();
    const token = { ...(await tokenFor(payer, await idKey(payee.wallet), 1000)), amount: 5000 };
    const h = receiveHandlers({ wallet: payee.wallet, seen: seenStore(memoryKV()), onReceived: () => undefined });
    const r = await h.onPayment({ sender: await idKey(payer.wallet), token, messageId: 'm' } as never, { txid: '' });
    expect(r).toMatchObject({ status: 'rejected' });
    expect(payee.calls.internalize).toHaveLength(0);
  });

  test('a payment to someone else (or claiming another sender) is refused', async () => {
    const payer = makeTestWallet();
    const payee = makeTestWallet();
    const stranger = makeTestWallet();
    const token = await tokenFor(payer, await idKey(stranger.wallet), 1000);
    const h = receiveHandlers({ wallet: payee.wallet, seen: seenStore(memoryKV()), onReceived: () => undefined });
    const r = await h.onPayment({ sender: await idKey(payer.wallet), token, messageId: 'm' } as never, { txid: '' });
    expect(r).toMatchObject({ status: 'rejected' });
    expect(payee.calls.internalize).toHaveLength(0);
  });
});

describe('phone to phone: payer order of operations', () => {
  const setup = async () => {
    const payer = makeTestWallet();
    const payee = makeTestWallet();
    const peer = { isOpen: true, peerIdentityKey: await idKey(payee.wallet) };
    const pending = pendingStore(memoryKV());
    return { payer, payee, peer, pending };
  };

  test('a channel that closed before broadcast aborts: nothing broadcast, nothing kept', async () => {
    const { payer, peer, pending } = await setup();
    peer.isOpen = false;
    const client = { sendPayment: async () => ({ t: 'payment.ack', id: 'x', status: 'accepted' }) as const };
    await expect(payOverChannel({ client, wallet: payer.wallet, peer, sats: 500, pending })).rejects.toThrow(
      /Nothing was sent/,
    );
    expect(payer.calls.broadcast).toEqual([]);
    expect(payer.calls.aborted).toHaveLength(1);
    expect(pending.get(peer.peerIdentityKey)).toBeNull();
  });

  test('accepted: broadcast once, token delivered, nothing kept', async () => {
    const { payer, peer, pending } = await setup();
    const sent: unknown[] = [];
    const client = {
      sendPayment: async (_p: unknown, t: unknown) => {
        sent.push(t);
        return { t: 'payment.ack', id: 'x', status: 'accepted' } as const;
      },
    };
    const r = await payOverChannel({ client, wallet: payer.wallet, peer, sats: 500, pending });
    expect(r).toMatchObject({ k: 'paid', sats: 500, ack: 'accepted' });
    expect(payer.calls.broadcast).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(payer.calls.created[0].description).toStartWith(`${HISTORY_TEXT} payment to `);
    expect(payer.calls.created[0].options?.noSend).toBe(true);
    expect(pending.get(peer.peerIdentityKey)).toBeNull();
  });

  test('no ack after broadcast: token kept, and the next session re-delivers it without spending again', async () => {
    const { payer, peer, pending } = await setup();
    const failing = {
      sendPayment: async () => {
        throw new Error('channel dropped');
      },
    };
    const r1 = await payOverChannel({ client: failing, wallet: payer.wallet, peer, sats: 700, pending });
    expect(r1).toMatchObject({ k: 'undelivered', sats: 700 });
    expect(pending.get(peer.peerIdentityKey)?.amount).toBe(700);

    const ok = { sendPayment: async () => ({ t: 'payment.ack', id: 'y', status: 'accepted' }) as const };
    const created = payer.calls.created.length;
    const r2 = await payOverChannel({ client: ok, wallet: payer.wallet, peer, sats: 999, pending });
    expect(r2).toMatchObject({ k: 'redelivered', sats: 700 });
    if (r1.k === 'undelivered' && r2.k === 'redelivered') expect(r2.txid).toBe(r1.txid);
    expect(payer.calls.created.length).toBe(created);
    expect(pending.get(peer.peerIdentityKey)).toBeNull();
  });

  test('refuses amounts outside the prototype bounds before touching the wallet', async () => {
    const { payer, peer, pending } = await setup();
    const client = { sendPayment: async () => ({ t: 'payment.ack', id: 'x', status: 'accepted' }) as const };
    await expect(
      payOverChannel({ client, wallet: payer.wallet, peer, sats: MAX_DIRECT_SATS + 1, pending }),
    ).rejects.toThrow();
    expect(payer.calls.created).toHaveLength(0);
  });
});
