import { MAX_PER_MINUTE, WINDOW_MS, type Approval } from '../settings/oneClick';
import { loadPrefs, type Prefs } from '../settings/prefs';
import { currentFx, formatFiat } from '../../utils/displayCurrency';

/**
 * One-tap pay for the indexing fee of the user's OWN tokens (personal $NAME, tickets, any token
 * minted here). Same guard semantics as one-click pay (src/mobile/settings/oneClick.ts): approve only
 * when the setting is on, the amount is a positive whole number of sats, its USD value (at a known,
 * positive BSV/USD rate) is strictly under the threshold, it is under the hard sats cap, and the
 * per-minute count / total stays under the runaway limits. Anything else uses the confirm sheet.
 * Not for any other payment.
 */
export const INDEX_AUTOPAY_MAX_SATS = 10_000;

export type IndexDecision =
  | { ok: true; usd: number }
  | { ok: false; reason: 'off' | 'amount' | 'no-rate' | 'over-limit' | 'rate' };

export const satsToUsd = (sats: number, usdPerBsv: number) => (sats / 100_000_000) * usdPerBsv;

export const decideIndexAutoPay = (
  sats: number,
  usdPerBsv: number,
  prefs: Pick<Prefs, 'indexAutoPayUsd'>,
  history: readonly Approval[],
  now: number,
): IndexDecision => {
  if (!(prefs.indexAutoPayUsd > 0)) return { ok: false, reason: 'off' };
  if (!Number.isSafeInteger(sats) || sats < 1) return { ok: false, reason: 'amount' };
  if (!Number.isFinite(usdPerBsv) || usdPerBsv <= 0) return { ok: false, reason: 'no-rate' };
  const usd = satsToUsd(sats, usdPerBsv);
  if (sats > INDEX_AUTOPAY_MAX_SATS || usd >= prefs.indexAutoPayUsd) return { ok: false, reason: 'over-limit' };
  const recent = history.filter((h) => now - h.at < WINDOW_MS && h.at <= now);
  if (recent.length >= MAX_PER_MINUTE) return { ok: false, reason: 'rate' };
  if (recent.reduce((t, h) => t + h.sats, 0) + sats > MAX_PER_MINUTE * INDEX_AUTOPAY_MAX_SATS)
    return { ok: false, reason: 'rate' };
  return { ok: true, usd };
};

export const createIndexAutoPayGuard = (getPrefs: () => Pick<Prefs, 'indexAutoPayUsd'> = loadPrefs) => {
  let history: Approval[] = [];
  return {
    /** Checks and, if allowed, records atomically. Call right before paying. */
    take(sats: number, usdPerBsv: number, now = Date.now()): IndexDecision {
      const d = decideIndexAutoPay(sats, usdPerBsv, getPrefs(), history, now);
      if (d.ok) history = [...history.filter((h) => now - h.at < WINDOW_MS), { at: now, sats }];
      return d;
    },
    peek(sats: number, usdPerBsv: number, now = Date.now()): IndexDecision {
      return decideIndexAutoPay(sats, usdPerBsv, getPrefs(), history, now);
    },
  };
};

export const indexAutoPay = createIndexAutoPayGuard();

/** "$0.0006" for tiny amounts, "$0.12" otherwise. */
export const formatSmallUsd = (usd: number) => formatFiat(usd, currentFx(), { small: true });
