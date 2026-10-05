import { describe, expect, test } from 'bun:test';
import { BigNumber, BSM, PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import { baseDerivations, findKeyFor, signBsmWith } from './issuerKey';
import { parseLookup, parseSpend, spendLabel, toRawAmount, type Derivation } from './tokenRooms';

const wallet = new ProtoWallet(PrivateKey.fromRandom());
const deploy: Derivation = {
  protocolID: [0, 'onesat'],
  keyID: 'bsv21-deploy-ACME-0011223344556677',
  counterparty: 'self',
};

const addressOf = async (d: Derivation) =>
  PublicKey.fromString(
    (
      await wallet.getPublicKey({
        protocolID: d.protocolID,
        keyID: d.keyID,
        counterparty: d.counterparty,
        forSelf: true,
      })
    ).publicKey,
  ).toAddress();

/** What bit-sign's claim route checks: the compact signature recovers to the issuer address. */
const recoversTo = (message: string, b64: string, address: string) => {
  const msg = Utils.toArray(message, 'utf8');
  const sig = Signature.fromCompact(b64, 'base64');
  const hash = new BigNumber(BSM.magicHash(msg));
  for (let r = 0; r < 4; r++) {
    try {
      const pub = sig.RecoverPublicKey(r, hash);
      if (pub.toAddress() === address && BSM.verify(msg, sig, pub)) return true;
    } catch {
      /* next */
    }
  }
  return false;
};

describe('issuer key', () => {
  test('finds the derivation that controls the deploy address', async () => {
    const addr = await addressOf(deploy);
    const found = await findKeyFor(wallet, addr, [...baseDerivations(), deploy]);
    expect(found?.keyID).toBe(deploy.keyID);
  });

  test('no match → null (token minted from another wallet: no claim offered)', async () => {
    const other = PrivateKey.fromRandom().toAddress();
    expect(await findKeyFor(wallet, other, [...baseDerivations(), deploy])).toBeNull();
    expect(await findKeyFor(wallet, '', [deploy])).toBeNull();
  });

  test('signs a compact BSM signature that recovers to the issuer address', async () => {
    const addr = await addressOf(deploy);
    const message = 'bitcoinchat.online room admin: bsv21:aa_0: $alice: 1790000000';
    const sig = await signBsmWith(wallet, deploy, message);
    expect(recoversTo(message, sig, addr)).toBe(true);
    expect(recoversTo(message + 'x', sig, addr)).toBe(false);
  });
});

describe('room rules parsing', () => {
  test('spend rule', () => {
    expect(parseSpend({ amountRaw: '500', per: 'message', to: 'burn' })).toEqual({
      amountRaw: '500',
      per: 'message',
      to: 'burn',
    });
    expect(parseSpend({ amountRaw: '0', per: 'message', to: 'burn' })).toBeNull();
    expect(parseSpend({ amountRaw: '1', per: 'week', to: 'burn' })).toBeNull();
    expect(spendLabel({ amountRaw: '500', per: 'hour', to: 'issuer' }, 'ACME', 2)).toBe(
      'Spend 5 $ACME per hour, to the issuer',
    );
    expect(spendLabel(null, 'ACME', 0)).toBe('No spend to chat');
  });

  test('whole → raw', () => {
    expect(toRawAmount('1.5', 2)).toBe('150');
    expect(toRawAmount('1.555', 2)).toBeNull();
    expect(toRawAmount('0', 0)).toBeNull();
    expect(toRawAmount('3', 0)).toBe('3');
  });

  test('lookup carries issuer + spend', () => {
    const l = parseLookup({
      key: 'bsv21:' + 'a'.repeat(64) + '_0',
      room: { ticker: 'ACME', name: 'x', members: 2 },
      spend: { amountRaw: '1', per: 'day', to: 'burn' },
      issuer: { address: '1abc', handle: 'alice', claimed: true },
      you_are_issuer: true,
    });
    expect(l?.youAreIssuer).toBe(true);
    expect(l?.issuer?.handle).toBe('alice');
    expect(l?.spend?.per).toBe('day');
  });
});
