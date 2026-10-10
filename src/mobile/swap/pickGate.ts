/**
 * Why "Get deposit address" is (or isn't) available on Swap › Pick. Pure, so the gating is unit-tested
 * (pickGate.test.ts). Every blocked state carries a reason shown under the button.
 */
export type AddressState = 'loading' | 'ok' | 'error';
export type PickEstimate = { toAmount: number | null; minAmount: number; belowMin?: boolean } | null;

export type PickGateInput = {
  amount: number | null;
  typed: string;
  addressState: AddressState;
  est: PickEstimate;
  estError: string;
  estLoading: boolean;
  busy: boolean;
  ticker: string;
  fmt?: (n: number) => string;
};

export type PickGate = { ok: true; reason: null } | { ok: false; reason: string; retryAddress?: boolean };

export const pickGate = (g: PickGateInput): PickGate => {
  const fmt = g.fmt ?? ((n: number) => String(n));
  const t = g.ticker.toUpperCase();
  if (g.busy) return { ok: false, reason: 'Creating your swap…' };
  if (!g.typed.trim()) return { ok: false, reason: 'Enter an amount' };
  if (g.amount === null) return { ok: false, reason: 'Enter a valid amount, like 0.5' };
  if (g.addressState === 'loading') return { ok: false, reason: 'Getting your BSV address…' };
  if (g.addressState === 'error')
    return { ok: false, reason: 'Couldn’t get your BSV address — try again', retryAddress: true };
  if (g.estError) return { ok: false, reason: `Couldn’t get a quote: ${g.estError}` };
  if (g.estLoading || !g.est) return { ok: false, reason: 'Getting a quote…' };
  if (g.est.belowMin || (g.est.minAmount > 0 && g.amount < g.est.minAmount))
    return { ok: false, reason: `Minimum is ${fmt(g.est.minAmount)} ${t}` };
  if (g.est.toAmount === null) return { ok: false, reason: 'No quote for this amount — try a different amount' };
  return { ok: true, reason: null };
};
