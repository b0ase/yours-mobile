/**
 * Swap into BSV (owner-approved design, 10 Oct 2026): another coin → BSV in this wallet, run by ChangeNOW through
 * bit-sign's proxy (/api/bitsign/swaps/*, the API key never reaches the app). bWalletX only: SWAP_ENABLED in
 * storeBuild.ts keeps it out of the store edition.
 *
 * Pure parts (stages, storage reducers, polling rules) are unit-tested in swapApi.test.ts with a fake Http.
 */
import { BCHAT_ORIGIN, defaultHttp, type Http } from '../chat/api';
import { Capacitor } from '@capacitor/core';

export type SwapCoin = { ticker: string; network: string; label: string; name?: string; image?: string | null; hasExtraId?: boolean };
export type SwapNotice = { provider: string; text: string; links: { label: string; url: string }[] };
export type SwapStage = 'waiting' | 'deposit_seen' | 'swapping' | 'sending' | 'done' | 'failed' | 'refunded' | 'expired' | 'on_hold';

/** The popular chips, used before the server list arrives (same order as the server's POPULAR). */
export const POPULAR_COINS: SwapCoin[] = [
  { ticker: 'btc', network: 'btc', label: 'BTC' },
  { ticker: 'eth', network: 'eth', label: 'ETH' },
  { ticker: 'usdt', network: 'trx', label: 'USDT · Tron' },
  { ticker: 'usdt', network: 'eth', label: 'USDT · Ethereum' },
  { ticker: 'sol', network: 'sol', label: 'SOL' },
  { ticker: 'usdc', network: 'eth', label: 'USDC' },
  { ticker: 'ltc', network: 'ltc', label: 'LTC' },
  { ticker: 'doge', network: 'doge', label: 'DOGE' },
];

export const FALLBACK_NOTICE: SwapNotice = {
  provider: 'ChangeNOW',
  text: 'Swaps are run by ChangeNOW, not bWalletX. ChangeNOW may pause a swap for AML/KYC checks. Rates are estimates until your deposit arrives.',
  links: [{ label: 'ChangeNOW terms of use', url: 'https://changenow.io/terms-of-use' }],
};

/** A swap this wallet started, kept on the device so Track survives a restart. */
export type SwapRecord = {
  id: string;
  createdAt: number;
  from: string;
  network: string;
  label: string;
  amount: number;
  toAmount: number | null;
  payinAddress: string;
  payinExtraId: string | null;
  address: string;
  stage: SwapStage;
  payoutTxid: string | null;
  validUntil: string | null;
  notified?: boolean;
};

export const FINAL: ReadonlySet<SwapStage> = new Set(['done', 'failed', 'refunded', 'expired']);
export const POLL_MS = 20_000;

/** The four Track steps; index of the step reached for a stage (-1 = not started). */
export const STEPS = ['Deposit seen', 'Swapping', 'Sending BSV', 'In your wallet'] as const;
export const stepIndex = (s: SwapStage): number =>
  s === 'deposit_seen' ? 0 : s === 'swapping' || s === 'on_hold' ? 1 : s === 'sending' ? 2 : s === 'done' ? 3 : -1;

// ── Storage (pure reducers + a thin localStorage wrapper) ──
const KEY = 'bwx.swaps';
const MAX = 30;

export const upsertSwap = (list: SwapRecord[], r: SwapRecord): SwapRecord[] =>
  [r, ...list.filter((x) => x.id !== r.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX);
export const activeSwaps = (list: SwapRecord[]) => list.filter((s) => !FINAL.has(s.stage));

export const loadSwaps = (): SwapRecord[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? (v as SwapRecord[]) : [];
  } catch {
    return [];
  }
};
export const saveSwap = (r: SwapRecord) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(upsertSwap(loadSwaps(), r)));
    window.dispatchEvent(new Event('bwx-swaps'));
  } catch {
    /* storage full / unavailable */
  }
};

// ── Coin icons ──
/** Ticker label + optional network line for a coin tile ("USDT" / "Tron"); network shown only when the ticker lives on several chains. */
export const coinTileText = (c: Pick<SwapCoin, 'ticker' | 'network' | 'label'>): { ticker: string; network: string | null } => {
  const ticker = c.ticker.toUpperCase();
  const dot = c.label.indexOf(' · ');
  if (dot >= 0) return { ticker: c.label.slice(0, dot), network: c.label.slice(dot + 3) };
  return { ticker, network: c.ticker === c.network ? null : networkName(c) };
};
/** Only https icons from a known CDN are shown; anything else falls back to the letter circle. */
export const safeCoinImage = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};
/** Fill the built-in popular list with the server's images (matched on ticker + network); keeps local order and labels. */
export const withImages = (local: SwapCoin[], server: SwapCoin[]): SwapCoin[] => {
  const img = new Map(server.map((c) => [`${c.ticker}:${c.network}`, c.image]));
  return local.map((c) => (img.get(`${c.ticker}:${c.network}`) ? { ...c, image: img.get(`${c.ticker}:${c.network}`) } : c));
};

// ── Text helpers ──
export const fmtAmount = (n: number | null | undefined, max = 8) =>
  n === null || n === undefined || !Number.isFinite(n) ? '…' : Number(n.toFixed(max)).toString();
export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);
export const networkName = (c: Pick<SwapCoin, 'ticker' | 'network'>) => {
  const n: Record<string, string> = { btc: 'Bitcoin', eth: 'Ethereum', trx: 'Tron', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', bsc: 'BNB Smart Chain' };
  return n[c.network] ?? c.network.toUpperCase();
};

/** One-line text for a notice when a swap ends. */
export const landedText = (s: SwapRecord): { title: string; body: string } | null =>
  s.stage === 'done'
    ? { title: 'Swap finished', body: `${fmtAmount(s.toAmount)} BSV from your ${s.label} swap is in your wallet.` }
    : s.stage === 'refunded'
      ? { title: 'Swap refunded', body: `Your ${s.label} swap was refunded by ${FALLBACK_NOTICE.provider}.` }
      : s.stage === 'failed'
        ? { title: 'Swap needs attention', body: `Your ${s.label} swap didn't finish. Open it to see what to do.` }
        : null;

// ── API ──
export class SwapApi {
  constructor(
    private readonly http: Http = defaultHttp(Capacitor.isNativePlatform()),
    private readonly origin = BCHAT_ORIGIN,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.http({
      method,
      url: `${this.origin}/api/bitsign/swaps/${path}`,
      headers: {},
      body,
    });
    const data = (res.data ?? {}) as Record<string, unknown>;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(typeof data.error === 'string' ? data.error : 'Swaps are not available right now.');
    }
    return data as T;
  }

  currencies(q = '') {
    return this.call<{ currencies: SwapCoin[]; notice: SwapNotice }>('GET', `currencies${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }
  estimate(c: SwapCoin, amount: number) {
    const qs = `from=${encodeURIComponent(c.ticker)}&network=${encodeURIComponent(c.network)}&amount=${amount}`;
    return this.call<{ toAmount: number | null; minAmount: number; belowMin?: boolean; warning?: string | null; notice: SwapNotice }>(
      'GET',
      `estimate?${qs}`,
    );
  }
  create(c: SwapCoin, amount: number, address: string, refundAddress?: string, handle?: string) {
    return this.call<{
      id: string;
      payinAddress: string;
      payinExtraId: string | null;
      fromAmount: number;
      toAmount: number;
      notice: SwapNotice;
    }>('POST', 'create', { from: c.ticker, network: c.network, amount, address, refundAddress, handle });
  }
  status(id: string) {
    return this.call<{ stage: SwapStage; payoutTxid: string | null; amountTo: number | null; validUntil: string | null }>(
      'GET',
      `status?id=${encodeURIComponent(id)}`,
    );
  }
}

/** Apply a status reply to a record. */
export const applyStatus = (
  r: SwapRecord,
  s: { stage: SwapStage; payoutTxid: string | null; amountTo: number | null; validUntil: string | null },
): SwapRecord => ({
  ...r,
  stage: s.stage,
  payoutTxid: s.payoutTxid ?? r.payoutTxid,
  toAmount: s.amountTo ?? r.toAmount,
  validUntil: s.validUntil ?? r.validUntil,
});

/** Parse a typed amount ("0,01" too). */
export const parseTyped = (v: string): number | null => {
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};
