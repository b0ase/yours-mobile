// Partnership shares, the wallet side of the agreement (owner, 18 Oct 2026: "the core idea behind bWalletX's tokens
// and chatrooms"). Path: token → rooms → PARTNERSHIP SHARES → company → private placements → IPO.
//
// bit-sign (src/lib/partnership.ts) generates the agreement, stores each version and counts signatures; the wallet
// never takes the server's word for what it is signing. It regenerates the agreement from the partners and rule
// in the draft and refuses to sign unless the text and its sha256 match exactly.
//
// Pure: no network, no keys. Tests: partnership.test.ts.
import { Hash, Utils } from '@bsv/sdk';
import type { MessageCharge } from '../../chat/roomSpend';
import { RULE_WARNING, signaturesNeeded, type TransferRule } from './partnerLock';

export const TOTAL_BPS = 10_000;
export const MAX_PARTNERS = 20;

export type Partner = { handle: string; name: string; shareBps: number };

// ── split maths ──────────────────────────────────────────────────────────────

/** "27.5" or "27.5%" → 2750 basis points. Null when it is not a percentage with at most two decimals. */
export function pctToBps(s: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(s);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps > 0 && bps <= TOTAL_BPS ? bps : null;
}

export const bpsToPct = (bps: number) => `${(bps / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;

export const normHandle = (h: string) => h.trim().replace(/^[$@]/, '').toLowerCase();

/** Same checks as bit-sign decideAgreement, so the wallet says no before the server does. Null = fine. */
export function splitProblem(partners: Partner[], rule: TransferRule): string | null {
  if (partners.length < 2) return 'A partnership needs at least two partners.';
  if (partners.length > MAX_PARTNERS) return `At most ${MAX_PARTNERS} partners.`;
  const seen = new Set<string>();
  for (const p of partners) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.handle)) return 'Name each partner by $handle.';
    if (seen.has(p.handle)) return `$${p.handle} is listed twice.`;
    seen.add(p.handle);
    if (!p.name.trim() || p.name.length > 120) return `Give $${p.handle}’s full name.`;
    if (!Number.isInteger(p.shareBps) || p.shareBps <= 0) return 'Each partner needs a share above 0%.';
  }
  const total = partners.reduce((t, p) => t + p.shareBps, 0);
  if (total !== TOTAL_BPS) return `Shares must add up to exactly 100% (now ${bpsToPct(total)}).`;
  if (rule.kind === 'majority') {
    const min = Math.floor(partners.length / 2) + 1;
    if (!Number.isInteger(rule.m) || rule.m < min || rule.m > partners.length)
      return `Majority means at least ${min} of ${partners.length}.`;
  }
  return null;
}

/**
 * Largest-remainder apportionment: splits `total` (whole units) by weight, exact sum, ties to the earlier entry.
 * Used for basis points, sats and token amounts alike.
 */
export function apportion(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n) throw new Error('Nothing negative to split');
  const sum = weights.reduce((t, w) => t + w, 0n);
  if (sum <= 0n || weights.some((w) => w < 0n)) throw new Error('Weights must be positive');
  const out = weights.map((w) => (total * w) / sum);
  const rem = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - out.reduce((t, x) => t + x, 0n);
  for (const { i } of rem.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))) {
    if (left <= 0n) break;
    out[i] += 1n;
    left -= 1n;
  }
  return out;
}

/**
 * Admit a partner for `newBps`: everyone else is diluted pro rata (30/30/40 + 10% → 27/27/36/10).
 * Exact to the basis point; the result always sums to 100%.
 */
export function admitPartner(current: Partner[], joiner: Omit<Partner, 'shareBps'>, newBps: number): Partner[] {
  const h = normHandle(joiner.handle);
  if (current.some((p) => p.handle === h)) throw new Error(`$${h} is already a partner`);
  if (!Number.isInteger(newBps) || newBps <= 0 || newBps >= TOTAL_BPS)
    throw new Error('The new partner needs a share between 0% and 100%');
  const kept = apportion(
    BigInt(TOTAL_BPS - newBps),
    current.map((p) => BigInt(p.shareBps)),
  );
  return [
    ...current.map((p, i) => ({ ...p, shareBps: Number(kept[i]) })),
    { handle: h, name: joiner.name.trim(), shareBps: newBps },
  ];
}

/** Token amounts per partner for a fixed supply (the locked holdings after a split or admission). */
export const holdingsFor = (supply: bigint, partners: Partner[]) =>
  apportion(
    supply,
    partners.map((p) => BigInt(p.shareBps)),
  ).map((amt, i) => ({ handle: partners[i].handle, amt }));

/**
 * Every sale splits itself: one incoming payment becomes one output per partner, by share. Exact sum; a partner
 * whose slice rounds to 0 sats gets no output. Paid straight to each partner's own wallet: no pooled address,
 * nobody holds the money in between.
 */
export function splitPayment(totalSats: number, partners: Partner[]): { handle: string; sats: number }[] {
  if (!Number.isSafeInteger(totalSats) || totalSats <= 0) throw new Error('Enter an amount above 0');
  return apportion(
    BigInt(totalSats),
    partners.map((p) => BigInt(p.shareBps)),
  )
    .map((v, i) => ({ handle: partners[i].handle, sats: Number(v) }))
    .filter((p) => p.sats > 0);
}

/** The split as Paid Spaces-style charges (one sats output per partner address). */
export const splitCharges = (
  totalSats: number,
  partners: Partner[],
  addressOf: Record<string, string>,
): MessageCharge[] =>
  splitPayment(totalSats, partners).map((p) => {
    const to = addressOf[p.handle];
    if (!to) throw new Error(`No receiving address for $${p.handle}`);
    return { unit: 'sats', amount: String(p.sats), to };
  });

// ── the agreement ────────────────────────────────────────────────────────────
// KEEP IN STEP with bit-sign src/lib/partnership.ts (DRAFT_LINE, PARTNERS_NOTICE, agreementText, signMessage).
// The wallet regenerates the text and refuses to sign when a single byte differs.

export const DRAFT_LINE = 'Drafted by b for the partners to read and agree; take advice for bigger stakes.';
export const PARTNERS_NOTICE =
  'You’re now partners: profits are shared and each of you is personally liable until you incorporate.';

export type AgreementInput = {
  roomName: string;
  ticker: string;
  version: number;
  date: string;
  partners: Partner[];
  rule: TransferRule;
  supersedes?: number;
};

export function agreementText(i: AgreementInput): string {
  const need = signaturesNeeded(i.rule, i.partners.length);
  const rule =
    i.rule.kind === 'unanimous'
      ? 'every partner must agree'
      : `at least ${need} of the ${i.partners.length} partners must agree`;
  return [
    `PARTNERSHIP AGREEMENT — ${i.roomName} ($${i.ticker})`,
    `Version ${i.version}${i.supersedes ? `, replacing version ${i.supersedes}` : ''} · ${i.date}`,
    DRAFT_LINE,
    '',
    '1. Who the partners are',
    ...i.partners.map((p) => `   ${p.name} ($${p.handle}) — ${bpsToPct(p.shareBps)} of the partnership shares`),
    '',
    '2. What this means',
    `   ${PARTNERS_NOTICE}`,
    '   We carry on this project together with a view to profit. This is a partnership, not a company: there is no',
    '   limited liability. Each of us is taxed on our own share of the profits.',
    '',
    '3. Partnership shares and the token',
    `   Our partnership shares are held as $${i.ticker} tokens in our own wallets, locked so that moving them needs`,
    `   our agreement: ${rule}. Nobody, including bit-sign or bWalletX, holds our keys.`,
    `   ${RULE_WARNING[i.rule.kind]}`,
    '',
    '4. Profits',
    '   Profits the partnership pays out are split between us in proportion to our partnership shares,',
    '   automatically, at the time of each payout.',
    '',
    '5. Admitting or removing a partner',
    `   A new partner may be admitted, or a partner removed, only by a new version of this agreement agreed under`,
    `   the same rule (${rule}) and then signed by every partner named in the new version.`,
    '',
    '6. Incorporation',
    '   If we incorporate a company, each partnership share converts one-for-one into a share in that company,',
    '   recorded on its register of members, and this agreement ends for the future.',
    '',
    '7. Not an offer',
    '   Partnership shares are not offered to the public and are not a promise of any return.',
    '',
    '8. Signatures',
    '   Each partner signs this exact text with their wallet. The agreement takes effect when all have signed.',
  ].join('\n');
}

export const sha256Hex = (text: string) => Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')));

/** What a partner signs (identity key, protocol 'bshares partner', keyID `${roomId}:v${version}`). */
export const signMessage = (o: { roomId: string; version: number; sha256: string; handle: string; at: string }) =>
  `Partnership shares · room ${o.roomId} · version ${o.version}\nI, $${o.handle}, sign the partnership agreement sha256 ${o.sha256}.\n${o.at}`;
export const signKeyId = (roomId: string, version: number) => `${roomId}:v${version}`;

export type AgreementVersion = {
  id: string;
  version: number;
  status: string;
  partners: Partner[];
  rule: TransferRule;
  signaturesToTransfer: number;
  agreementText: string;
  agreementSha256: string;
  signed: string[];
};

/**
 * Checks a draft before the wallet signs it: the text regenerates exactly from the draft's own partners and rule
 * (room name, ticker, version and date read from its header) and hashes to the recorded sha256. Null = safe to
 * sign; otherwise the reason, and the Sign button stays off.
 */
export function agreementProblem(
  v: Pick<AgreementVersion, 'version' | 'partners' | 'rule' | 'agreementText' | 'agreementSha256'>,
): string | null {
  const [l1 = '', l2 = ''] = v.agreementText.split('\n');
  const h1 = /^PARTNERSHIP AGREEMENT — (.+) \(\$([^)]+)\)$/.exec(l1);
  const h2 = /^Version (\d+)(?:, replacing version (\d+))? · (\d{4}-\d{2}-\d{2})$/.exec(l2);
  if (!h1 || !h2) return 'This agreement is not in the standard form.';
  if (Number(h2[1]) !== v.version) return 'The version in the text does not match the draft.';
  const again = agreementText({
    roomName: h1[1],
    ticker: h1[2],
    version: v.version,
    date: h2[3],
    partners: v.partners,
    rule: v.rule,
    supersedes: h2[2] ? Number(h2[2]) : undefined,
  });
  if (again !== v.agreementText) return 'The text differs from the standard agreement for these partners.';
  if (sha256Hex(v.agreementText) !== v.agreementSha256.toLowerCase()) return 'The recorded fingerprint does not match.';
  return null;
}
