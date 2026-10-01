import { INVESTOR_CERT_VALID_MONTHS, PURCHASE_BLOCKED_COUNTRIES } from './config';

/**
 * Verified identity + investor qualification: the pure part (no wallet, no network, no clock —
 * `nowMs` is passed in), so the gating states are unit-tested.
 */

/** What bit-sign's certificate says, decrypted. No name, no date of birth, no document data. */
export interface KycSummary {
  verified: boolean;
  over18: 'true' | 'false' | 'unknown';
  /** ISO-3166 alpha-2, '' when not known. */
  country: string;
  level: number;
  issuedAt: string;
  expiresAt: string;
  serialNumber: string;
  certifier: string;
}

/** Parse decrypted certificate fields. Null when they are not a usable KYC certificate. */
export const parseKycFields = (
  fields: Record<string, string> | null | undefined,
  meta: { serialNumber: string; certifier: string },
): KycSummary | null => {
  if (!fields || fields.verified !== 'true') return null;
  if (!Number.isFinite(Date.parse(fields.expiresAt ?? '')) || !Number.isFinite(Date.parse(fields.issuedAt ?? ''))) {
    return null;
  }
  const over18 = fields.over18 === 'true' || fields.over18 === 'false' ? fields.over18 : 'unknown';
  const country = /^[A-Za-z]{2}$/.test(fields.country ?? '') ? fields.country.toUpperCase() : '';
  const level = Number(fields.level);
  return {
    verified: true,
    over18,
    country,
    level: Number.isFinite(level) ? level : 0,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    serialNumber: meta.serialNumber,
    certifier: meta.certifier,
  };
};

export const kycValid = (k: KycSummary | null | undefined, nowMs: number): k is KycSummary =>
  !!k && k.verified && Date.parse(k.expiresAt) > nowMs;

/** The newest still-valid certificate of several. */
export const bestKyc = (all: (KycSummary | null)[], nowMs: number): KycSummary | null =>
  all
    .filter((k): k is KycSummary => kycValid(k, nowMs))
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0] ?? null;

// ── Investor self-certification ──

/** UK Financial Promotion Order categories offered here (keys match bit-sign's cert_type). */
export type InvestorCategory = 'hnw' | 'sophisticated' | 'self-cert-sophisticated';

export interface InvestorStatement {
  category: InvestorCategory;
  article: string;
  label: string;
  /** The exact text signed. */
  statement: string;
  /** True when this is the wallet's built-in placeholder rather than bit-sign's current text. */
  placeholder: boolean;
}

/**
 * Placeholders shown only when bit-sign's own statements cannot be fetched. NOT the statutory
 * wording — every one is marked [LEGAL REVIEW] and must be replaced by counsel-approved text.
 */
export const PLACEHOLDER_STATEMENTS: InvestorStatement[] = [
  {
    category: 'hnw',
    article: 'FPO art. 48',
    label: 'Certified high net worth individual',
    statement:
      '[LEGAL REVIEW] Placeholder for the FPO art. 48 high net worth statement (income / net asset thresholds as currently in force). Replace with counsel-approved wording.',
    placeholder: true,
  },
  {
    category: 'sophisticated',
    article: 'FPO art. 50',
    label: 'Certified sophisticated investor',
    statement:
      '[LEGAL REVIEW] Placeholder for the FPO art. 50 certified sophisticated investor statement (certificate from an authorised person). Replace with counsel-approved wording.',
    placeholder: true,
  },
  {
    category: 'self-cert-sophisticated',
    article: 'FPO art. 50A',
    label: 'Self-certified sophisticated investor',
    statement:
      '[LEGAL REVIEW] Placeholder for the FPO art. 50A self-certified sophisticated investor statement. Replace with counsel-approved wording.',
    placeholder: true,
  },
];

const ARTICLE: Record<InvestorCategory, string> = {
  hnw: 'FPO art. 48',
  sophisticated: 'FPO art. 50',
  'self-cert-sophisticated': 'FPO art. 50A',
};

/** bit-sign's GET /api/bitsign/investor-self-cert `options`, narrowed to our three categories. */
export const statementsFromServer = (
  options: { value?: unknown; label?: unknown; statement?: unknown }[] | null | undefined,
): InvestorStatement[] => {
  const out: InvestorStatement[] = [];
  for (const o of options ?? []) {
    const v = o.value as InvestorCategory;
    if (!(v in ARTICLE) || typeof o.statement !== 'string' || !o.statement) continue;
    out.push({
      category: v,
      article: ARTICLE[v],
      label: typeof o.label === 'string' ? o.label : v,
      statement: o.statement,
      placeholder: false,
    });
  }
  return out;
};

export interface InvestorCert {
  category: InvestorCategory;
  identityKey: string;
  statementSha256: string;
  signedAt: string;
  expiresAt: string;
  /** Hex DER signature by the identity key. */
  signature: string;
  /** Whether bit-sign accepted it. */
  synced: boolean;
  placeholderText: boolean;
}

export const addMonths = (iso: string, months: number) => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
};

export const investorExpiry = (signedAt: string) => addMonths(signedAt, INVESTOR_CERT_VALID_MONTHS);

export const investorValid = (c: InvestorCert | null | undefined, identityKey: string, nowMs: number) =>
  // A statement signed over placeholder text is not a qualification.
  !!c && c.identityKey === identityKey && !c.placeholderText && Date.parse(c.expiresAt) > nowMs;

/** Message signed for a self-certification — identical to bit-sign's selfCertSignMessage. */
export const selfCertSignMessage = (a: {
  handle: string;
  identityKey: string;
  certType: string;
  statementHash: string;
  timestamp: string;
}) =>
  `bit-sign investor self-certification\nhandle:${a.handle}\nidentity_key:${a.identityKey}` +
  `\ncert_type:${a.certType}\nstatement_sha256:${a.statementHash}\ntimestamp:${a.timestamp}`;

/** Message signed to ask for a KYC certificate — identical to bit-sign's kycRequestMessage. */
export const kycRequestMessage = (handle: string, identityKey: string, timestamp: string) =>
  `bit-sign wallet KYC certificate\nhandle:${handle}\nidentity_key:${identityKey}\ntimestamp:${timestamp}`;

// ── Gating ──

export type ShareGate =
  /** Step 1 of 2: verify identity. Nothing about any offer is shown. */
  | { state: 'need-kyc' }
  /** Step 2 of 2: self-certify. Still locked. */
  | { state: 'need-investor'; kyc: KycSummary }
  /** Both done: offers visible; `canRegister` false only when the country rule applies. */
  | { state: 'qualified'; kyc: KycSummary; canRegister: boolean; blockedReason?: string };

export const purchaseBlocked = (country: string, blocked: string[] = PURCHASE_BLOCKED_COUNTRIES) =>
  !!country && blocked.map((c) => c.toUpperCase()).includes(country.toUpperCase());

/**
 * Viewing the share offers needs BOTH a valid KYC certificate and a current investor
 * self-certification. The country rule only ever disables "Register interest".
 */
export const shareGate = (
  kyc: KycSummary | null,
  investor: InvestorCert | null,
  identityKey: string,
  nowMs: number,
  blocked: string[] = PURCHASE_BLOCKED_COUNTRIES,
): ShareGate => {
  if (!kycValid(kyc, nowMs)) return { state: 'need-kyc' };
  if (!investorValid(investor, identityKey, nowMs)) return { state: 'need-investor', kyc };
  if (purchaseBlocked(kyc.country, blocked)) {
    return {
      state: 'qualified',
      kyc,
      canRegister: false,
      blockedReason:
        'Not available in your country yet. Offers are only made where the issuer can lawfully make them; you can still read the offers.',
    };
  }
  return { state: 'qualified', kyc, canRegister: true };
};

/** Message signed for a share-offer event — identical to bit-sign's shareEventMessage. */
export const shareEventMessage = (a: {
  handle: string;
  identityKey: string;
  kind: string;
  offerIds: string[];
  timestamp: string;
}) =>
  `bit-sign share offer event\nhandle:${a.handle}\nidentity_key:${a.identityKey}` +
  `\nkind:${a.kind}\noffers:${a.offerIds.join(',')}\ntimestamp:${a.timestamp}`;

// ── Share offers ──

export type ShareSection = 'bcorp' | 'bapps' | 'other';

/** A share offer. Pre-launch: no price is held or shown anywhere. */
export interface ShareOffer {
  /** Slug, sent to bit-sign when registering interest. */
  id: string;
  section: ShareSection;
  name: string;
  /** e.g. "Class W — bWallet" (placeholder). */
  className: string;
  icon?: string;
  /** What the share class tracks. */
  tracks: string;
  /** Total shares in the class, as display text. */
  classSize: string;
  issuerName: string;
  /** '' = placeholder, shown as "company no. to be confirmed". */
  issuerCompanyNumber: string;
  /** KYB-verified issuer. Third-party offers without it are not shown. */
  issuerVerified: boolean;
  /** Issuer's offer document; absent = placeholder. */
  offerUrl?: string;
  status: 'pre-launch' | 'open' | 'closed';
  /** Held via a nominee: the nominee is on the register, the token is the beneficial claim. */
  nominee: boolean;
  /** Transfers locked (e.g. transfer restrictions) until `lockedUntil`. */
  transferLocked: boolean;
  /** ISO date; '' = to be confirmed. */
  lockedUntil: string;
}

const SECTIONS: ShareSection[] = ['bcorp', 'bapps', 'other'];
const STATUSES = ['pre-launch', 'open', 'closed'];
export const isOfferId = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

/** Validate offers from config; drops malformed rows and unverified third-party issuers. */
export const parseShareOffers = (raw: unknown): ShareOffer[] => {
  const rows = Array.isArray(raw) ? raw : (raw as { offers?: unknown[] } | null)?.offers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const o = r as Partial<ShareOffer>;
    if (!o || !SECTIONS.includes(o.section as ShareSection) || !isOfferId(o.id)) return [];
    if (typeof o.name !== 'string' || !o.name) return [];
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const offer: ShareOffer = {
      id: o.id,
      section: o.section as ShareSection,
      name: o.name,
      className: str(o.className),
      icon: str(o.icon) || undefined,
      tracks: str(o.tracks),
      classSize: str(o.classSize),
      issuerName: str(o.issuerName),
      issuerCompanyNumber: str(o.issuerCompanyNumber),
      issuerVerified: o.issuerVerified === true,
      offerUrl: typeof o.offerUrl === 'string' && /^https:\/\//.test(o.offerUrl) ? o.offerUrl : undefined,
      status: STATUSES.includes(o.status as string) ? (o.status as ShareOffer['status']) : 'pre-launch',
      nominee: o.nominee === true,
      // Fail closed: locked unless the config says otherwise.
      transferLocked: o.transferLocked !== false,
      lockedUntil: Number.isFinite(Date.parse(str(o.lockedUntil))) ? str(o.lockedUntil) : '',
    };
    if (offer.section === 'other' && !offer.issuerVerified) return [];
    return [offer];
  });
};

export const BCORP_ISSUER = 'The Bitcoin Corporation Ltd';

/** Placeholder class size for an alphabet share class (org convention: 1B units). [LEGAL REVIEW] */
export const ALPHABET_CLASS_SIZE = '1,000,000,000 (placeholder)';

/**
 * One bCorp alphabet-share offer per bApp. Class letters are placeholders: the letter after the
 * "b", numbered on collision (bMovies → M, bMusic → M2 …).
 */
export const bappOffers = (apps: { name: string; verb: string; icon?: string }[]): ShareOffer[] => {
  const used = new Map<string, number>();
  return apps.map((a) => {
    const letter = (a.name.slice(1, 2) || a.name.slice(0, 1)).toUpperCase();
    const n = (used.get(letter) ?? 0) + 1;
    used.set(letter, n);
    return {
      id: `bapp-${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      section: 'bapps',
      name: a.name,
      className: `Class ${letter}${n > 1 ? n : ''} — ${a.name}`,
      icon: a.icon,
      tracks: `Tracks ${a.name}: ${a.verb.charAt(0).toLowerCase()}${a.verb.slice(1)}.`,
      classSize: ALPHABET_CLASS_SIZE,
      issuerName: BCORP_ISSUER,
      issuerCompanyNumber: '',
      issuerVerified: true,
      status: 'pre-launch',
      // Nominee model (docs/TOKENS-AND-SHARES-HANDOFF.md §5); lock date to be confirmed.
      nominee: true,
      transferLocked: true,
      lockedUntil: '',
    };
  });
};
