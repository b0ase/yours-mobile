import { Certificate, Hash, MasterCertificate, Utils, type ProtoWallet, type WalletInterface } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession, saveSession, type Http } from '../chat/api';
import { walletSigner } from '../chat/signer';
import {
  EXTRA_TRUSTED_CERTIFIERS,
  KYC_CERT_TYPE,
  KYC_REQUEST_PROTOCOL,
  ROOT_KEYS_URL,
  SELF_CERT_PROTOCOL,
  SHARE_EVENT_PROTOCOL,
  SIGN_KEY_ID,
} from './config';
import {
  bestKyc,
  investorExpiry,
  kycRequestMessage,
  parseKycFields,
  selfCertSignMessage,
  shareEventMessage,
  type InvestorCert,
  type InvestorStatement,
  type KycSummary,
} from './kyc';

/**
 * Verified identity — wallet + network side.
 *
 * Import: sign a request with the identity key → bit-sign issues a BRC-52 certificate →
 * check it here (type, subject, certifier is bit-sign's published key, signature verifies,
 * fields decrypt) → store it with acquireCertificate('direct'). Nothing is stored that does
 * not pass all of those.
 */

const CERTIFIERS_KEY = 'bwallet.kyc.certifiers';
const SUMMARY_KEY = (identityKey: string) => `bwallet.kyc.summary.${identityKey}`;
const INVESTOR_KEY = (identityKey: string) => `bwallet.kyc.investor.${identityKey}`;
const AUDIT_KEY = (identityKey: string) => `bwallet.kyc.audit.${identityKey}`;
const listeners = new Set<() => void>();

export const onKycChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

const readJson = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') as T | null;
  } catch {
    return null;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

export const identityKeyOf = async (ctx: OneSatContext) =>
  (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey;

/** Certifier keys this wallet trusts: bit-sign's published ones (cached) + the config list. */
export const trustedCertifiers = (): string[] => [
  ...new Set([...(readJson<string[]>(CERTIFIERS_KEY) ?? []), ...EXTRA_TRUSTED_CERTIFIERS]),
];

/** Pure: bit-sign's current certifier key from /.well-known/bit-sign-root-keys.json (retired keys are not trusted for new imports). */
export const rootKeysFrom = (doc: unknown): string[] => {
  const k = (doc as { current?: { pubkey?: unknown } | null } | null)?.current?.pubkey;
  return typeof k === 'string' && /^0[23][0-9a-fA-F]{64}$/.test(k) ? [k] : [];
};

const refreshCertifiers = async (http: Http): Promise<string[]> => {
  const res = await http({ method: 'GET', url: ROOT_KEYS_URL, headers: { Accept: 'application/json' } });
  const keys = res.status === 200 ? rootKeysFrom(res.data) : [];
  if (keys.length) writeJson(CERTIFIERS_KEY, keys);
  return trustedCertifiers();
};

export const kycClient = () => new BchatClient(defaultHttp(isNative), loadSession());

/** A signed-in bChat/bit-sign client (signs in with the wallet's key if needed). */
export const signedInClient = async (ctx: OneSatContext, client = kycClient()) => {
  if (!client.current) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
};

const signHex = async (ctx: OneSatContext, message: string, protocolID: [2, string]) => {
  const { signature } = await ctx.wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return Utils.toHex(signature);
};

/** What bit-sign returns; validated by checkIssuedCertificate before it touches the wallet. */
export interface IssuedCertificate {
  type: string;
  serialNumber: string;
  subject: string;
  certifier: string;
  revocationOutpoint: string;
  signature: string;
  fields: Record<string, string>;
  keyringForSubject: Record<string, string>;
}

/** Pure-ish structural + signature check. Throws a user-readable reason. */
export const checkIssuedCertificate = async (
  raw: unknown,
  expect: { identityKey: string; certifiers: string[] },
): Promise<IssuedCertificate> => {
  const c = raw as Partial<IssuedCertificate> | null;
  if (!c || typeof c !== 'object') throw new Error('bit-sign returned no certificate.');
  for (const k of ['type', 'serialNumber', 'subject', 'certifier', 'revocationOutpoint', 'signature'] as const) {
    if (typeof c[k] !== 'string' || !c[k]) throw new Error(`Certificate is missing ${k}.`);
  }
  if (!c.fields || typeof c.fields !== 'object' || !c.keyringForSubject || typeof c.keyringForSubject !== 'object') {
    throw new Error('Certificate has no fields.');
  }
  if (c.type !== KYC_CERT_TYPE) throw new Error('Not a bit-sign KYC certificate.');
  if (c.subject !== expect.identityKey) throw new Error('Certificate is for a different identity key.');
  if (!expect.certifiers.includes(c.certifier as string)) throw new Error('Certificate is not signed by bit-sign.');
  const ok = await new Certificate(
    c.type,
    c.serialNumber as string,
    c.subject,
    c.certifier as string,
    c.revocationOutpoint as string,
    c.fields,
    c.signature,
  )
    .verify()
    .catch(() => false);
  if (!ok) throw new Error('Certificate signature does not verify.');
  return c as IssuedCertificate;
};

const decrypt = (wallet: WalletInterface, keyring: Record<string, string>, fields: Record<string, string>, certifier: string) =>
  // MasterCertificate only calls wallet.decrypt, which WalletInterface provides.
  MasterCertificate.decryptFields(wallet as unknown as ProtoWallet, keyring, fields, certifier);

/** "Import my certificate": request, verify, decrypt, store. Returns the summary. */
export const importKycCertificate = async (ctx: OneSatContext): Promise<KycSummary> => {
  const http = defaultHttp(isNative);
  const client = await signedInClient(ctx);
  const handle = client.handle as string;
  const identityKey = await identityKeyOf(ctx);
  const certifiers = await refreshCertifiers(http);
  if (!certifiers.length) throw new Error("Couldn't load bit-sign's certifier key. Check your connection.");

  const timestamp = new Date().toISOString();
  const signature = await signHex(ctx, kycRequestMessage(handle, identityKey, timestamp), KYC_REQUEST_PROTOCOL);
  const raw = await client.kycWalletCert({ identity_key: identityKey, timestamp, signature });
  const cert = await checkIssuedCertificate(raw, { identityKey, certifiers });

  const plain = await decrypt(ctx.wallet, cert.keyringForSubject, cert.fields, cert.certifier);
  const summary = parseKycFields(plain, cert);
  if (!summary) throw new Error('Certificate fields are not a valid verification.');

  await ctx.wallet.acquireCertificate({
    type: cert.type,
    certifier: cert.certifier,
    acquisitionProtocol: 'direct',
    fields: cert.fields,
    serialNumber: cert.serialNumber,
    revocationOutpoint: cert.revocationOutpoint,
    signature: cert.signature,
    keyringRevealer: 'certifier',
    keyringForSubject: cert.keyringForSubject,
  });
  writeJson(SUMMARY_KEY(identityKey), summary);
  appendAudit(identityKey, { kind: 'kyc-import', at: new Date().toISOString(), detail: summary.serialNumber });
  emit();
  return summary;
};

/**
 * Reads the wallet's certificates from bit-sign's certifier key(s) and returns the newest
 * valid verification, or null. The wallet's certificate store is the source of truth; the
 * cached summary only saves a decrypt for a certificate still present.
 */
export const readKyc = async (ctx: OneSatContext, nowMs = Date.now()): Promise<KycSummary | null> => {
  const certifiers = trustedCertifiers();
  if (!certifiers.length) return null;
  const identityKey = await identityKeyOf(ctx);
  const cached = readJson<KycSummary>(SUMMARY_KEY(identityKey));
  const { certificates } = await ctx.wallet.listCertificates({ certifiers, types: [KYC_CERT_TYPE], limit: 20 });
  const all = await Promise.all(
    certificates.map(async (c) => {
      if (cached && cached.serialNumber === c.serialNumber && cached.certifier === c.certifier) return cached;
      if (!c.keyring) return null;
      try {
        return parseKycFields(await decrypt(ctx.wallet, c.keyring, c.fields, c.certifier), c);
      } catch {
        return null;
      }
    }),
  );
  const best = bestKyc(all, nowMs);
  if (best && best.serialNumber !== cached?.serialNumber) writeJson(SUMMARY_KEY(identityKey), best);
  return best;
};

/** True when the wallet holds a valid, unexpired bit-sign KYC certificate. */
export const isKycVerified = async (ctx: OneSatContext, nowMs = Date.now()) => !!(await readKyc(ctx, nowMs));

/** Cached summary, for synchronous UI (the ✓ in the top bar). */
export const cachedKyc = (identityKey: string): KycSummary | null => readJson<KycSummary>(SUMMARY_KEY(identityKey));

// ── Investor self-certification ──

export const loadInvestorCert = (identityKey: string) => readJson<InvestorCert>(INVESTOR_KEY(identityKey));

const sha256Hex = (s: string) => Utils.toHex(Hash.sha256(s, 'utf8'));

/** Sign a statement with the identity key, store it locally, and send it to bit-sign. */
export const signInvestorStatement = async (ctx: OneSatContext, st: InvestorStatement): Promise<InvestorCert> => {
  const client = await signedInClient(ctx);
  const identityKey = await identityKeyOf(ctx);
  const signedAt = new Date().toISOString();
  const statementSha256 = sha256Hex(st.statement);
  const signature = await signHex(
    ctx,
    selfCertSignMessage({
      handle: client.handle as string,
      identityKey,
      certType: st.category,
      statementHash: statementSha256,
      timestamp: signedAt,
    }),
    SELF_CERT_PROTOCOL,
  );
  const cert: InvestorCert = {
    category: st.category,
    identityKey,
    statementSha256,
    signedAt,
    expiresAt: investorExpiry(signedAt),
    signature,
    synced: false,
    placeholderText: st.placeholder,
  };
  if (!st.placeholder) {
    try {
      await client.investorSelfCertWallet({
        cert_type: st.category,
        statement_sha256: statementSha256,
        identity_key: identityKey,
        timestamp: signedAt,
        signature,
      });
      cert.synced = true;
    } catch (e) {
      console.warn('[kyc] self-cert not recorded by bit-sign:', e);
    }
  }
  writeJson(INVESTOR_KEY(identityKey), cert);
  appendAudit(identityKey, { kind: 'qualification', at: signedAt, detail: st.category, synced: cert.synced });
  if (cert.synced) void recordShareEvent(ctx, 'qualification', []).catch(() => undefined);
  emit();
  return cert;
};

// ── Per-user audit trail (local copy; bit-sign keeps the authoritative one) ──

export interface AuditEntry {
  kind: 'kyc-import' | 'qualification' | 'view' | 'interest';
  at: string;
  detail?: string;
  synced?: boolean;
}

const AUDIT_MAX = 500;
export const loadAudit = (identityKey: string) => readJson<AuditEntry[]>(AUDIT_KEY(identityKey)) ?? [];
const appendAudit = (identityKey: string, e: AuditEntry) =>
  writeJson(AUDIT_KEY(identityKey), [...loadAudit(identityKey), e].slice(-AUDIT_MAX));

/**
 * Record a view / qualification / register-interest with bit-sign, signed by the identity key,
 * and in the local audit trail. 'interest' throws if bit-sign doesn't record it (the user must
 * know their interest wasn't registered); the others are best-effort.
 */
export const recordShareEvent = async (
  ctx: OneSatContext,
  kind: 'view' | 'interest' | 'qualification',
  offerIds: string[],
): Promise<void> => {
  const identityKey = await identityKeyOf(ctx);
  const at = new Date().toISOString();
  let synced = false;
  try {
    const client = await signedInClient(ctx);
    const signature = await signHex(
      ctx,
      shareEventMessage({ handle: client.handle as string, identityKey, kind, offerIds, timestamp: at }),
      SHARE_EVENT_PROTOCOL,
    );
    await client.shareOfferEvent({ kind, offer_ids: offerIds, identity_key: identityKey, timestamp: at, signature });
    synced = true;
  } finally {
    if (kind !== 'qualification') appendAudit(identityKey, { kind, at, detail: offerIds.join(','), synced });
  }
};
