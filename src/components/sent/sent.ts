/**
 * "Sent!" confirmation (owner, 6 Oct 2026): after a payment is broadcast, a full-screen moment with a
 * gold check, the amount (dollars first), the recipient, a WhatsOnChain link and a coin chime.
 *
 * Pure logic + a tiny app-wide store. Send paths call `celebrateSend(result, details)` with the raw
 * broadcast result; the screen appears ONLY when the result carries a txid and no error.
 */
import { fmtSats, fmtUsd, satsToUsd } from '../../mobile/money/money';

export type SentAmount =
  | { kind: 'bsv'; sats: number }
  | { kind: 'mnee'; amount: number }
  | { kind: 'token'; display: string; ticker: string }
  | { kind: 'nft'; count: number; name?: string };

export type SentDetails = {
  amount: SentAmount;
  /** Names, paymails, $handles or addresses, as the user entered / saw them. */
  recipients: string[];
  /** USD per BSV (0 = unknown). */
  rate?: number;
  /** Optional heading override ("Tipped!", "Paid!"). */
  title?: string;
};

export type SentInfo = SentDetails & { txid: string };

const TXID = /^[0-9a-f]{64}$/i;

/** The Sent! screen data for a broadcast result, or null when it is not a confirmed success. */
export const sentFromResult = (
  res: { txid?: string | null; error?: unknown } | string | null | undefined,
  details: SentDetails,
): SentInfo | null => {
  if (!res) return null;
  const txid = typeof res === 'string' ? res : res.txid;
  if (typeof res !== 'string' && res.error) return null;
  if (typeof txid !== 'string' || !TXID.test(txid)) return null;
  return { ...details, txid: txid.toLowerCase() };
};

const trimNum = (n: number, max: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: max });

/** Big line (dollars when known) and the small line under it (sats / token amount). */
export const formatSentAmount = (a: SentAmount, rate = 0): { primary: string; secondary: string } => {
  switch (a.kind) {
    case 'bsv': {
      const usd = satsToUsd(a.sats, rate);
      return usd === null
        ? { primary: fmtSats(a.sats), secondary: `${trimNum(a.sats / 1e8, 8)} BSV` }
        : { primary: fmtUsd(usd), secondary: fmtSats(a.sats) };
    }
    case 'mnee':
      return { primary: fmtUsd(a.amount), secondary: `${trimNum(a.amount, 5)} MNEE` };
    case 'token':
      return { primary: `${a.display} ${a.ticker}`.trim(), secondary: '' };
    case 'nft':
      return a.count === 1
        ? { primary: a.name?.trim() || '1 NFT', secondary: a.name?.trim() ? '1 NFT' : '' }
        : { primary: `${a.count} NFTs`, secondary: '' };
  }
};

const ADDRESS = /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** "1AbCdE…WxYz" for an address; names/paymails as-is (middle-trimmed when very long). */
export const shortRecipient = (r: string): string => {
  const s = r.trim();
  if (ADDRESS.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  if (s.length > 28) return `${s.slice(0, 16)}…${s.slice(-8)}`;
  return s;
};

/** One recipient: its short form. Several: "alice@x.com +2 more". None: ''. */
export const formatRecipients = (list: string[]): string => {
  const uniq = [...new Set(list.map((r) => r.trim()).filter(Boolean))];
  if (!uniq.length) return '';
  const first = shortRecipient(uniq[0]);
  return uniq.length === 1 ? first : `${first} +${uniq.length - 1} more`;
};

export const txUrl = (txid: string) => `https://whatsonchain.com/tx/${txid}`;

// ── app-wide store ─────────────────────────────────────────────────────────

let current: SentInfo | null = null;
const listeners = new Set<(s: SentInfo | null) => void>();

export const getSent = () => current;

export const setSent = (s: SentInfo | null) => {
  current = s;
  listeners.forEach((fn) => fn(s));
};

export const onSent = (fn: (s: SentInfo | null) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Show the Sent! screen if `res` is a confirmed broadcast. Returns whether it showed. */
export const celebrateSend = (res: Parameters<typeof sentFromResult>[0], details: SentDetails): boolean => {
  const info = sentFromResult(res, details);
  if (info) setSent(info);
  return !!info;
};
