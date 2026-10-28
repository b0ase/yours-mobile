import { Hash, KeyDeriver, PrivateKey, Random, Signature, Utils, type WalletInterface } from '@bsv/sdk';
import { canonical } from '../storeReceipt/receipt';

/**
 * Pay statements (owner, 28 Oct 2026: "wage payments workers can reconcile"; brief HWPE §1, §5).
 *
 * A payer (an employer or platform, from its business account) signs a statement for one worker and one pay period:
 * gross, each deduction with its basis, net, and a note. It travels as an encrypted bMail part with the net payment
 * as the letter's postage (wages/api.ts), so the statement never goes on chain. The worker's wallet keeps it.
 *
 * Signing: canonical JSON (keys sorted, storeReceipt/receipt.ts) of everything except `keyID` and `sig`, signed with
 * the identity key under the wallet-only protocol [2,'bwalletx pay statement'] to 'anyone', so anyone holding the
 * statement can check it and no outside app can get one signed in the user's name. A dispute is signed the same way.
 *
 * Money is integer US cents (no floats). A correction is a new statement with `replaces` = the original's id; the
 * original is never changed.
 */
export const PAY_PROTOCOL: [2, string] = [2, 'bwalletx pay statement'];
export const STATEMENT_TYPE = 'bwalletx-pay-statement' as const;
export const DISPUTE_TYPE = 'bwalletx-pay-dispute' as const;
export const MAX_DEDUCTIONS = 20;
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f]{32}$/;

export type Deduction = { label: string; cents: number; basis: string };

export type StatementBody = {
  type: typeof STATEMENT_TYPE;
  v: 1;
  id: string;
  /** Payer's identity key (signs the statement). */
  payer: string;
  payerName: string;
  /** Worker's identity key and the paymail the payer used. */
  worker: string;
  workerPaymail: string;
  /** Pay period, inclusive, YYYY-MM-DD. */
  period: { start: string; end: string };
  currency: 'USD';
  grossCents: number;
  deductions: Deduction[];
  netCents: number;
  /** The net in sats at `usdPerBsv` (what the payment carries). */
  netSats: number;
  usdPerBsv: number;
  note: string;
  issuedAt: string;
  /** Correction: the id of the statement this one corrects. */
  replaces?: string;
};
export type PayStatement = StatementBody & { keyID: string; sig: string };

export type DisputeBody = {
  type: typeof DISPUTE_TYPE;
  v: 1;
  id: string;
  statementId: string;
  /** Which line: 'gross', 'net' or 'deduction:<index>'. */
  line: string;
  /** Amount in dispute, cents. */
  cents: number;
  reason: string;
  /** Worker's identity key (signs the dispute). */
  worker: string;
  issuedAt: string;
};
export type PayDispute = DisputeBody & { keyID: string; sig: string };

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

const newId = () => Utils.toHex(Random(16));
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const str = (s: unknown, max: number) => typeof s === 'string' && s.length <= max;

/** sha256 hex of the signed bytes (the statement's fingerprint; the only thing that could ever be published). */
export const statementHash = (s: PayStatement | StatementBody): string => {
  const { keyID: _k, sig: _s, ...body } = s as PayStatement;
  return Utils.toHex(Hash.sha256(Utils.toArray(canonical(body), 'utf8')));
};

const signBody = async (wallet: Signer, body: object) => {
  const keyID = Utils.toBase64(Random(32));
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(canonical(body), 'utf8'),
    protocolID: PAY_PROTOCOL,
    keyID,
    counterparty: 'anyone',
  });
  return { keyID, sig: Utils.toHex(signature) };
};

const verifyBody = (signer: string, doc: { keyID: string; sig: string }): boolean => {
  try {
    const { keyID, sig, ...body } = doc;
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(PAY_PROTOCOL, keyID, signer, false);
    return pub.verify(Utils.toArray(canonical(body), 'utf8'), Signature.fromDER(sig, 'hex'));
  } catch {
    return false;
  }
};

export type StatementInput = {
  payerName: string;
  worker: string;
  workerPaymail: string;
  period: { start: string; end: string };
  grossCents: number;
  deductions: Deduction[];
  note: string;
  usdPerBsv: number;
  replaces?: string;
};

/** Plain-English problems with a draft statement; empty when it can be signed. */
export const statementProblems = (s: Omit<StatementBody, 'type' | 'v' | 'id' | 'payer' | 'issuedAt'>): string[] => {
  const out: string[] = [];
  if (!KEY_RE.test(s.worker)) out.push('Find the worker first.');
  if (!DAY_RE.test(s.period.start) || !DAY_RE.test(s.period.end)) out.push('Give the pay period start and end.');
  else if (s.period.end < s.period.start) out.push('The pay period ends before it starts.');
  if (!isInt(s.grossCents) || s.grossCents <= 0) out.push('Gross pay must be more than zero.');
  if (s.deductions.length > MAX_DEDUCTIONS) out.push(`At most ${MAX_DEDUCTIONS} deductions.`);
  for (const d of s.deductions) {
    if (!d.label.trim()) out.push('Every deduction needs a label.');
    if (!isInt(d.cents) || d.cents < 0) out.push(`"${d.label}" needs an amount of zero or more.`);
    if (!d.basis.trim()) out.push(`Say how "${d.label || 'the deduction'}" was worked out.`);
  }
  const sum = s.deductions.reduce((a, d) => a + (isInt(d.cents) ? d.cents : 0), 0);
  if (isInt(s.grossCents) && s.netCents !== s.grossCents - sum) out.push('Net must be gross minus deductions.');
  if (s.netCents <= 0) out.push('Net pay must be more than zero.');
  if (!(s.usdPerBsv > 0) || !isInt(s.netSats) || s.netSats <= 0) out.push('No BSV price yet. Try again in a moment.');
  return out;
};

export const centsToSats = (cents: number, usdPerBsv: number): number =>
  usdPerBsv > 0 ? Math.round((cents / 100 / usdPerBsv) * 1e8) : 0;

export const signStatement = async (wallet: Signer, input: StatementInput, nowMs = Date.now()) => {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const deductions = input.deductions.map((d) => ({ label: d.label.trim(), cents: d.cents, basis: d.basis.trim() }));
  const netCents = input.grossCents - deductions.reduce((a, d) => a + d.cents, 0);
  const body: StatementBody = {
    type: STATEMENT_TYPE,
    v: 1,
    id: newId(),
    payer: publicKey.toLowerCase(),
    payerName: input.payerName.trim().slice(0, 80),
    worker: input.worker.toLowerCase(),
    workerPaymail: input.workerPaymail.trim().slice(0, 120),
    period: { ...input.period },
    currency: 'USD',
    grossCents: input.grossCents,
    deductions,
    netCents,
    netSats: centsToSats(netCents, input.usdPerBsv),
    usdPerBsv: input.usdPerBsv,
    note: input.note.trim().slice(0, 1000),
    issuedAt: new Date(nowMs).toISOString(),
    ...(input.replaces ? { replaces: input.replaces } : {}),
  };
  const problems = statementProblems(body);
  if (problems.length) throw new Error(problems[0]);
  return { ...body, ...(await signBody(wallet, body)) } as PayStatement;
};

export const parseStatement = (raw: unknown): PayStatement | null => {
  const s = raw as PayStatement;
  if (!s || typeof s !== 'object' || s.type !== STATEMENT_TYPE || s.v !== 1) return null;
  if (!ID_RE.test(String(s.id)) || !KEY_RE.test(String(s.payer)) || !KEY_RE.test(String(s.worker))) return null;
  if (!s.period || !DAY_RE.test(String(s.period.start)) || !DAY_RE.test(String(s.period.end))) return null;
  if (!Array.isArray(s.deductions) || s.deductions.length > MAX_DEDUCTIONS) return null;
  if (!s.deductions.every((d) => str(d?.label, 80) && isInt(d.cents) && str(d.basis, 300))) return null;
  if (![s.grossCents, s.netCents, s.netSats].every(isInt) || typeof s.usdPerBsv !== 'number') return null;
  if (!str(s.note, 1000) || !str(s.payerName, 80) || !str(s.workerPaymail, 120) || !str(s.issuedAt, 40)) return null;
  if (s.replaces !== undefined && !ID_RE.test(String(s.replaces))) return null;
  if (typeof s.keyID !== 'string' || typeof s.sig !== 'string') return null;
  return s;
};

/** Signed by the payer it names, and the sums add up. */
export const verifyStatement = (s: PayStatement): boolean =>
  verifyBody(s.payer, s) && statementProblems(s).length === 0;

export const signDispute = async (
  wallet: Signer,
  input: { statementId: string; line: string; cents: number; reason: string },
  nowMs = Date.now(),
): Promise<PayDispute> => {
  if (!input.reason.trim()) throw new Error('Say what is wrong with this line.');
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const body: DisputeBody = {
    type: DISPUTE_TYPE,
    v: 1,
    id: newId(),
    statementId: input.statementId,
    line: input.line,
    cents: Math.max(0, Math.round(input.cents)),
    reason: input.reason.trim().slice(0, 1000),
    worker: publicKey.toLowerCase(),
    issuedAt: new Date(nowMs).toISOString(),
  };
  return { ...body, ...(await signBody(wallet, body)) };
};

export const parseDispute = (raw: unknown): PayDispute | null => {
  const d = raw as PayDispute;
  if (!d || typeof d !== 'object' || d.type !== DISPUTE_TYPE || d.v !== 1) return null;
  if (!ID_RE.test(String(d.id)) || !ID_RE.test(String(d.statementId)) || !KEY_RE.test(String(d.worker))) return null;
  if (!/^(gross|net|deduction:\d{1,2})$/.test(String(d.line)) || !isInt(d.cents) || d.cents < 0) return null;
  if (!str(d.reason, 1000) || !str(d.issuedAt, 40) || typeof d.keyID !== 'string' || typeof d.sig !== 'string')
    return null;
  return d;
};

export const verifyDispute = (d: PayDispute): boolean => verifyBody(d.worker, d);

/** The bMail part: `wage` in the sealed letter. */
export type WagePart = { kind: 'statement'; statement: PayStatement } | { kind: 'dispute'; dispute: PayDispute };

export const parseWagePart = (raw: unknown): WagePart | null => {
  const p = raw as { kind?: unknown; statement?: unknown; dispute?: unknown };
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'statement') {
    const statement = parseStatement(p.statement);
    return statement ? { kind: 'statement', statement } : null;
  }
  if (p.kind === 'dispute') {
    const dispute = parseDispute(p.dispute);
    return dispute ? { kind: 'dispute', dispute } : null;
  }
  return null;
};

/** The disputed line's amount on a statement (cents), or null when the line does not exist. */
export const lineCents = (s: StatementBody, line: string): number | null => {
  if (line === 'gross') return s.grossCents;
  if (line === 'net') return s.netCents;
  const m = /^deduction:(\d+)$/.exec(line);
  return m && s.deductions[Number(m[1])] ? s.deductions[Number(m[1])].cents : null;
};

export const lineLabel = (s: StatementBody, line: string): string => {
  if (line === 'gross') return 'Gross pay';
  if (line === 'net') return 'Net pay';
  const m = /^deduction:(\d+)$/.exec(line);
  return (m && s.deductions[Number(m[1])]?.label) || line;
};
