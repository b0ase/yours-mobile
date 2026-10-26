import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  BSM,
  Certificate,
  KeyDeriver,
  MasterCertificate,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Signature,
  SignedMessage,
  Utils,
  type WalletCertificate,
} from '@bsv/sdk';
import { KYC_CERT_TYPE } from './config';
import * as payout from './payoutProof';
import {
  isP2pkhAddress,
  payoutAddressMessage,
  payoutProofFile,
  publicCertificate,
  signPayoutAddress,
  storedKycCertificate,
} from './payoutProof';

// ── Replica of bwalletx-admin server/kyc.js (addressProofMessage, verifyCert, verifyAddressProof). Keep in lockstep. ──
const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;
const PAYOUT_PROTOCOL: [2, string] = [2, 'bwalletx payout proof'];
const adminMessage = (address: string, date: string) => `bwalletx b-aware payout address ${address} ${date}`;
const adminVerifyCert = async (
  c: Record<string, string> & { fields?: Record<string, string> },
  identityKey: string,
  certifiers: string[],
) => {
  for (const k of ['type', 'serialNumber', 'subject', 'certifier', 'revocationOutpoint', 'signature'])
    if (typeof c[k] !== 'string' || !c[k]) return `malformed ${k}`;
  if (!c.fields || typeof c.fields !== 'object') return 'malformed fields';
  if (c.type !== KYC_CERT_TYPE) return 'wrong type';
  if (!PUBKEY_RE.test(identityKey)) return 'no identity key';
  if (c.subject.toLowerCase() !== identityKey.toLowerCase()) return 'subject mismatch';
  if (!certifiers.includes(c.certifier.toLowerCase())) return 'certifier not trusted';
  const ok = await new Certificate(
    c.type,
    c.serialNumber,
    c.subject,
    c.certifier,
    c.revocationOutpoint,
    c.fields,
    c.signature,
  )
    .verify()
    .catch(() => false);
  return ok ? 'ok' : 'bad signature';
};
const adminVerifyAddressProof = (p: Record<string, unknown>, address: string, identityKey: string) => {
  const date = String(p.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return 'bad date';
  const msg = Utils.toArray(adminMessage(String(address || '').trim(), date), 'utf8');
  const sig = String(p.signature || '').trim();
  const scheme = String(p.scheme || 'bsm').toLowerCase();
  if (scheme === 'bsm') {
    try {
      return BSM.verify(msg, Signature.fromCompact(sig, 'base64'), PublicKey.fromString(identityKey))
        ? 'ok'
        : 'bad sig';
    } catch {
      return 'bad sig';
    }
  }
  if (scheme !== 'brc77' && scheme !== 'bwx-payout') return 'bad scheme';
  try {
    const bytes = /^[0-9a-f]+$/i.test(sig) ? Utils.toArray(sig, 'hex') : Utils.toArray(sig, 'base64');
    const signer = Utils.toHex(bytes.slice(4, 37));
    if (signer.toLowerCase() !== identityKey.toLowerCase()) return 'bad sig';
    if (scheme === 'brc77') return SignedMessage.verify(msg, bytes) ? 'ok' : 'bad sig';
    if (bytes[37] !== 0) return 'bad sig';
    const keyID = Utils.toBase64(bytes.slice(38, 70));
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(PAYOUT_PROTOCOL, keyID, signer, false);
    return pub.verify(msg, Signature.fromDER(bytes.slice(70))) ? 'ok' : 'bad sig';
  } catch {
    return 'bad sig';
  }
};

const identity = PrivateKey.fromRandom();
const wallet = new ProtoWallet(identity);
const certifierKey = PrivateKey.fromRandom();
const certifier = certifierKey.toPublicKey().toString();
const ADDRESS = PrivateKey.fromRandom().toPublicKey().toAddress();
const DATE = '2026-10-26';

const issue = async (subject: string) => {
  const m = await MasterCertificate.issueCertificateForSubject(
    new ProtoWallet(certifierKey),
    subject,
    { verified: 'true', over18: 'true', country: 'gb', level: '4' },
    KYC_CERT_TYPE,
    async () => '0'.repeat(64) + '.0',
  );
  // What listCertificates returns: the public cert plus the subject's keyring and more.
  return {
    type: m.type,
    serialNumber: m.serialNumber,
    subject: m.subject,
    certifier: m.certifier,
    revocationOutpoint: m.revocationOutpoint,
    signature: m.signature,
    fields: m.fields,
    keyring: m.masterKeyring,
    keyringForSubject: m.masterKeyring,
    verifier: certifier,
  };
};

describe('b-Aware payout proof', () => {
  test('message format is exact', () => {
    expect(payoutAddressMessage(ADDRESS, DATE)).toBe(`bwalletx b-aware payout address ${ADDRESS} ${DATE}`);
    expect(payoutAddressMessage(ADDRESS, DATE)).toBe(adminMessage(ADDRESS, DATE));
  });

  test('nothing but a P2PKH address and a YYYY-MM-DD date can be signed', async () => {
    for (const bad of ['hello', `${ADDRESS} extra`, ADDRESS + '\n', '', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'])
      expect(() => payoutAddressMessage(bad, DATE)).toThrow();
    for (const bad of ['26-10-2026', '2026-13-45', '2026-10-26 x', ''])
      expect(() => payoutAddressMessage(ADDRESS, bad)).toThrow();
    await expect(signPayoutAddress(wallet, 'sign this for me', DATE)).rejects.toThrow();
    expect(isP2pkhAddress(ADDRESS)).toBe(true);
  });

  test('module exposes no free-form signing path', () => {
    expect(Object.keys(payout).sort()).toEqual(
      [
        'PAYOUT_PROOF_PROTOCOL',
        'PAYOUT_PROOF_SCHEME',
        'isOwnAddress',
        'isP2pkhAddress',
        'payoutAddressMessage',
        'payoutProofFile',
        'payoutProofFileName',
        'proofDate',
        'publicCertificate',
        'signPayoutAddress',
        'storedKycCertificate',
        'walletReceiveAddress',
      ].sort(),
    );
    // signPayoutAddress takes (wallet, address, date): no message argument.
    expect(signPayoutAddress.length).toBe(3);
    const src = readFileSync(new URL('./payoutProof.ts', import.meta.url), 'utf8');
    expect(src.match(/createSignature\(/g)?.length).toBe(1);
    expect(src).toContain('const message = payoutAddressMessage(address, date);');
  });

  test('signature verifies with the admin kyc.js logic, and only for that address and date', async () => {
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(identity.toPublicKey().toString());
    const proof = await signPayoutAddress(wallet, ADDRESS, DATE);
    expect(proof.scheme).toBe('bwx-payout');
    // Not a BRC-77 message-signing signature: an app's BRC-77 signature can never pass as a payout proof.
    expect(
      SignedMessage.verify(
        Utils.toArray(payoutAddressMessage(ADDRESS, DATE), 'utf8'),
        Utils.toArray(proof.signature, 'hex'),
      ),
    ).toBe(false);
    expect(adminVerifyAddressProof(proof, ADDRESS, publicKey)).toBe('ok');
    // The JSON round trip the admin console does.
    expect(adminVerifyAddressProof(JSON.parse(JSON.stringify(proof)), ADDRESS, publicKey)).toBe('ok');
    const other = PrivateKey.fromRandom().toPublicKey();
    expect(adminVerifyAddressProof(proof, other.toAddress(), publicKey)).toBe('bad sig');
    expect(adminVerifyAddressProof({ ...proof, date: '2026-10-27' }, ADDRESS, publicKey)).toBe('bad sig');
    expect(adminVerifyAddressProof(proof, ADDRESS, other.toString())).toBe('bad sig');
  });

  test('admin kyc.js itself accepts the file (when the admin repo is next to this one)', async () => {
    let kyc: {
      verifyCert: (c: string, k: string, certs: string[]) => Promise<{ ok: boolean }>;
      verifyAddressProof: (p: string, a: string, k: string) => { ok: boolean };
    };
    try {
      kyc = require('/Volumes/2026/Projects/bwalletx-admin/server/kyc.js');
    } catch {
      return; // not on this machine (CI): the replica above covers it
    }
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    const raw = await issue(publicKey);
    const file = payoutProofFile(publicCertificate(raw), await signPayoutAddress(wallet, ADDRESS, DATE));
    expect((await kyc.verifyCert(JSON.stringify(file.certificate), publicKey, [certifier.toLowerCase()])).ok).toBe(
      true,
    );
    expect(kyc.verifyAddressProof(JSON.stringify(file.proof), ADDRESS, publicKey).ok).toBe(true);
  });

  test('export has the public certificate only (no keyring), and it verifies', async () => {
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    const raw = await issue(publicKey);
    const fakeWallet = {
      listCertificates: async () => ({ totalCertificates: 1, certificates: [raw as unknown as WalletCertificate] }),
    };
    const cert = await storedKycCertificate(fakeWallet, [certifier]);
    expect(cert).not.toBeNull();
    const file = payoutProofFile(cert!, await signPayoutAddress(wallet, ADDRESS, DATE));
    const json = JSON.stringify(file);
    expect(Object.keys(file)).toEqual(['certificate', 'proof']);
    expect(Object.keys(file.certificate).sort()).toEqual(
      ['certifier', 'fields', 'revocationOutpoint', 'serialNumber', 'signature', 'subject', 'type'].sort(),
    );
    expect(Object.keys(file.proof).sort()).toEqual(['address', 'date', 'scheme', 'signature']);
    expect(json).not.toMatch(/keyring|verifier|privateKey|wif|seed|mnemonic/i);
    for (const v of Object.values(raw.keyring)) expect(json).not.toContain(v);
    expect(json).not.toContain(identity.toHex());
    expect(json).not.toContain(identity.toWif());
    expect(await adminVerifyCert(JSON.parse(json).certificate, publicKey, [certifier.toLowerCase()])).toBe('ok');
    expect(adminVerifyAddressProof(JSON.parse(json).proof, ADDRESS, publicKey)).toBe('ok');
  });

  test('no certificate stored → null', async () => {
    const empty = { listCertificates: async () => ({ totalCertificates: 0, certificates: [] }) };
    expect(await storedKycCertificate(empty, [certifier])).toBeNull();
    expect(await storedKycCertificate(empty, [])).toBeNull();
  });
});
