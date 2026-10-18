import { describe, expect, test } from 'bun:test';
import { MasterCertificate, PrivateKey, ProtoWallet } from '@bsv/sdk';
import { KYC_CERT_TYPE } from './config';
import {
  bestKyc,
  investorExpiry,
  investorValid,
  kycRequestMessage,
  parseKycFields,
  purchaseBlocked,
  selfCertSignMessage,
  shareEventMessage,
  shareGate,
  statementsFromServer,
  type InvestorCert,
  type KycSummary,
} from './kyc';
import { checkIssuedCertificate, rootKeysFrom } from './kycWallet';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const meta = { serialNumber: 'S', certifier: '02' + 'a'.repeat(64) };
const fields = (over: Record<string, string> = {}) => ({
  verified: 'true',
  over18: 'true',
  country: 'gb',
  level: '4',
  issuedAt: iso(NOW - DAY),
  expiresAt: iso(NOW + 300 * DAY),
  ...over,
});
const kyc = (over: Record<string, string> = {}) => parseKycFields(fields(over), meta) as KycSummary;
const KEY = '03' + 'b'.repeat(64);
const investor = (over: Partial<InvestorCert> = {}): InvestorCert => ({
  category: 'hnw',
  identityKey: KEY,
  statementSha256: 'h',
  signedAt: iso(NOW - DAY),
  expiresAt: investorExpiry(iso(NOW - DAY)),
  signature: 'sig',
  synced: true,
  placeholderText: false,
  ...over,
});

describe('certificate parsing', () => {
  test('a valid certificate parses, country upper-cased', () => {
    const k = kyc();
    expect(k.verified).toBe(true);
    expect(k.country).toBe('GB');
    expect(k.level).toBe(4);
  });
  test('verified must be exactly "true"', () => {
    expect(parseKycFields(fields({ verified: 'yes' }), meta)).toBeNull();
    expect(parseKycFields(null, meta)).toBeNull();
  });
  test('unparseable dates are not a certificate', () => {
    expect(parseKycFields(fields({ expiresAt: 'soon' }), meta)).toBeNull();
  });
  test('unknown over18 and bad country degrade safely', () => {
    const k = kyc({ over18: 'maybe', country: 'Narnia' });
    expect(k.over18).toBe('unknown');
    expect(k.country).toBe('');
  });
});

describe('expiry', () => {
  test('an expired certificate is not picked', () => {
    expect(bestKyc([kyc({ expiresAt: iso(NOW - 1) })], NOW)).toBeNull();
  });
  test('newest valid wins', () => {
    const a = kyc({ expiresAt: iso(NOW + 10 * DAY) });
    const b = kyc({ expiresAt: iso(NOW + 200 * DAY) });
    expect(bestKyc([a, null, b], NOW)).toBe(b);
  });
  test('investor certification lasts 12 months', () => {
    expect(investorExpiry('2026-01-15T00:00:00.000Z')).toBe('2027-01-15T00:00:00.000Z');
    expect(investorValid(investor({ expiresAt: iso(NOW - 1) }), KEY, NOW)).toBe(false);
  });
  test('investor cert is bound to the identity key and to real (non-placeholder) text', () => {
    expect(investorValid(investor(), KEY, NOW)).toBe(true);
    expect(investorValid(investor(), '02' + 'c'.repeat(64), NOW)).toBe(false);
    expect(investorValid(investor({ placeholderText: true }), KEY, NOW)).toBe(false);
  });
});

describe('share gating', () => {
  test('step 1: not verified → locked', () => {
    expect(shareGate(null, investor(), KEY, NOW).state).toBe('need-kyc');
    expect(shareGate(kyc({ expiresAt: iso(NOW - 1) }), investor(), KEY, NOW).state).toBe('need-kyc');
  });
  test('step 2: verified but not self-certified → still locked', () => {
    expect(shareGate(kyc(), null, KEY, NOW).state).toBe('need-investor');
    expect(shareGate(kyc(), investor({ expiresAt: iso(NOW - 1) }), KEY, NOW).state).toBe('need-investor');
  });
  test('both → offers visible, register interest allowed', () => {
    const g = shareGate(kyc(), investor(), KEY, NOW);
    expect(g.state === 'qualified' && g.canRegister).toBe(true);
  });
  test('country rule disables register-interest only; default list is empty', () => {
    const g = shareGate(kyc({ country: 'US' }), investor(), KEY, NOW, ['US']);
    expect(g.state).toBe('qualified');
    expect(g.state === 'qualified' && g.canRegister).toBe(false);
    expect(g.state === 'qualified' && g.blockedReason).toContain('Not available in your country yet');
    expect(purchaseBlocked('US')).toBe(false);
    const free = shareGate(kyc({ country: 'US' }), investor(), KEY, NOW);
    expect(free.state === 'qualified' && free.canRegister).toBe(true);
  });
});

describe('investor statements', () => {
  test('server options narrowed to art. 48 / 50 / 50A', () => {
    const s = statementsFromServer([
      { value: 'hnw', label: 'HNW', statement: 'text' },
      { value: 'restricted', label: 'R', statement: 'text' },
      { value: 'sophisticated', label: 'S', statement: '' },
    ]);
    expect(s.map((x) => [x.category, x.article])).toEqual([['hnw', 'FPO art. 48']]);
  });
});

describe('lockstep messages with bit-sign', () => {
  test('KYC request and self-cert messages', () => {
    expect(kycRequestMessage('alice', KEY, 'T')).toBe(
      `bit-sign wallet KYC certificate\nhandle:alice\nidentity_key:${KEY}\ntimestamp:T`,
    );
    expect(
      selfCertSignMessage({ handle: 'a', identityKey: 'k', certType: 'hnw', statementHash: 'h', timestamp: 't' }),
    ).toBe(
      'bit-sign investor self-certification\nhandle:a\nidentity_key:k\ncert_type:hnw\nstatement_sha256:h\ntimestamp:t',
    );
  });
});

describe('issued certificate checks', () => {
  const certifierKey = PrivateKey.fromRandom();
  const certifier = certifierKey.toPublicKey().toString();
  const subjectWallet = new ProtoWallet(PrivateKey.fromRandom());

  const issue = async (subject: string, type = KYC_CERT_TYPE) => {
    const m = await MasterCertificate.issueCertificateForSubject(
      new ProtoWallet(certifierKey),
      subject,
      fields(),
      type,
      async () => '0'.repeat(64) + '.0',
    );
    return {
      type: m.type,
      serialNumber: m.serialNumber,
      subject: m.subject,
      certifier: m.certifier,
      revocationOutpoint: m.revocationOutpoint,
      signature: m.signature,
      fields: m.fields,
      keyringForSubject: m.masterKeyring,
    };
  };

  test('a genuine certificate passes and its fields decrypt for the subject', async () => {
    const { publicKey } = await subjectWallet.getPublicKey({ identityKey: true });
    const c = await checkIssuedCertificate(await issue(publicKey), { identityKey: publicKey, certifiers: [certifier] });
    const plain = await MasterCertificate.decryptFields(subjectWallet, c.keyringForSubject, c.fields, c.certifier);
    expect(parseKycFields(plain, c)?.country).toBe('GB');
  });
  test('wrong subject, untrusted certifier, wrong type and tampering are refused', async () => {
    const { publicKey } = await subjectWallet.getPublicKey({ identityKey: true });
    const good = await issue(publicKey);
    await expect(checkIssuedCertificate(good, { identityKey: KEY, certifiers: [certifier] })).rejects.toThrow(
      'different identity key',
    );
    await expect(
      checkIssuedCertificate(good, { identityKey: publicKey, certifiers: ['02' + 'd'.repeat(64)] }),
    ).rejects.toThrow('not signed by bit-sign');
    await expect(
      checkIssuedCertificate(await issue(publicKey, 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='), {
        identityKey: publicKey,
        certifiers: [certifier],
      }),
    ).rejects.toThrow('Not a bit-sign KYC');
    const tampered = { ...good, fields: { ...good.fields, country: good.fields.verified } };
    await expect(checkIssuedCertificate(tampered, { identityKey: publicKey, certifiers: [certifier] })).rejects.toThrow(
      'does not verify',
    );
  });
  test('root keys: only the current key is trusted', () => {
    expect(rootKeysFrom({ current: { pubkey: certifier }, previous: [{ pubkey: KEY }] })).toEqual([certifier]);
    expect(rootKeysFrom({ current: null })).toEqual([]);
  });
});

describe('share offers', () => {
  test('share event message is in lockstep with bit-sign', () => {
    expect(
      shareEventMessage({ handle: 'a', identityKey: 'k', kind: 'interest', offerIds: ['x', 'y'], timestamp: 't' }),
    ).toBe('bit-sign share offer event\nhandle:a\nidentity_key:k\nkind:interest\noffers:x,y\ntimestamp:t');
  });
});
