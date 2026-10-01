import { P2PKH } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { withTimeout } from '../withTimeout';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';

/**
 * 1sat-stack only indexes a BSV-21 token while its overlay account is funded: each token has a
 * fee address (derived by the indexer from the token id, exposed as `status.fee_address` on
 * GET /1sat/bsv21/{id}) and every indexed token output costs `fee_per_output` (default 1000 sats).
 * `deployBsv21Mint` does NOT fund it, so a freshly deployed token never shows up in wallets /
 * rooms / Market that list BSV-21 through the indexer (phase-0 mainnet test,
 * docs/TICKETS-BURN-PHASE0.md §6: status.fee_address ~0.4 s after deploy, is_active ~0.75 s after
 * funding).
 *
 * Owner decision: the creator pays indexing at mint. Right after the deploy (same confirmation),
 * bWallet sends INDEX_FUND_SATS to the fee address. Later transfers pay their own per-output fee
 * (sendBsv21 adds it).
 */

/** Creator pre-fund at mint: the deploy output plus headroom (3 outputs at the default rate). */
export const INDEX_FUND_SATS = 3000;
export const DEFAULT_FEE_PER_OUTPUT = 1000;
/** Funding tx: one input, change, one P2PKH output (~230 B at ~100 sat/kB). */
export const INDEX_FUND_NETWORK_SATS = 30;
/** Total the confirm sheet adds for indexing. */
export const indexCostSats = (fund = INDEX_FUND_SATS) => fund + INDEX_FUND_NETWORK_SATS;

export type OverlayStatus = {
  feeAddress: string;
  feePerOutput: number;
  isActive: boolean;
  balance: number;
};

/** Pull the funding fields out of a 1sat-stack token details response (null = not known yet). */
export function parseOverlayStatus(details: unknown): OverlayStatus | null {
  const s = (details as { status?: Record<string, unknown> } | null | undefined)?.status;
  if (!s || typeof s.fee_address !== 'string' || !/^[13][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s.fee_address)) return null;
  const fpo = typeof s.fee_per_output === 'number' && s.fee_per_output > 0 ? s.fee_per_output : DEFAULT_FEE_PER_OUTPUT;
  return {
    feeAddress: s.fee_address,
    feePerOutput: fpo,
    isActive: s.is_active === true,
    balance: typeof s.balance === 'number' ? s.balance : 0,
  };
}

/** Does this token still need its indexing funded? Unknown status (not seen yet) = yes. */
export const needsIndexFunding = (s: OverlayStatus | null) => !s || !s.isActive || s.balance < s.feePerOutput;

/** Sats to send: at least the configured pre-fund, never less than one output's fee. */
export const fundAmount = (s: Pick<OverlayStatus, 'feePerOutput'>, fund = INDEX_FUND_SATS) =>
  Math.max(fund, s.feePerOutput);

const normId = (id: string) => id.replace('.', '_');

type Details = { getTokenDetails(id: string): Promise<unknown> };
const bsv21Client = (ctx: OneSatContext): Details | null =>
  ((ctx.services as unknown as { bsv21?: Details } | undefined)?.bsv21 ?? null) as Details | null;

const STATUS_TIMEOUT_MS = 8000;

/** Current overlay status for a token, or null if the indexer doesn't know it (yet) or doesn't answer. */
export async function overlayStatus(ctx: OneSatContext, tokenId: string): Promise<OverlayStatus | null> {
  const c = bsv21Client(ctx);
  if (!c) return null;
  const details = await withTimeout(c.getTokenDetails(normId(tokenId)), STATUS_TIMEOUT_MS, 'Indexer status').catch(
    () => null,
  );
  return parseOverlayStatus(details);
}

/** Poll until the indexer exposes the fee address (it learns the token from the deploy BEEF). */
export async function waitForOverlayStatus(
  ctx: OneSatContext,
  tokenId: string,
  { timeoutMs = 20_000, intervalMs = 500 } = {},
): Promise<OverlayStatus | null> {
  const t0 = Date.now();
  for (;;) {
    const s = await overlayStatus(ctx, tokenId);
    if (s) return s;
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── local record (so "Finish setting up $X" knows what's pending) ──

const KEY = (tokenId: string) => `bwallet.indexFund.${normId(tokenId)}`;
export type FundRecord = { txid: string; sats: number; at: number };
/** Label on every indexing payment; the startup self-heal (indexFundHeal.ts) finds ours by it. */
export const INDEX_FUND_LABEL = 'bsv21-index-fund';
export const getFundRecord = (tokenId: string): FundRecord | null => {
  try {
    const v = localStorage.getItem(KEY(tokenId));
    return v ? (JSON.parse(v) as FundRecord) : null;
  } catch {
    return null;
  }
};
const setFundRecord = (tokenId: string, r: FundRecord) => {
  try {
    localStorage.setItem(KEY(tokenId), JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
};

/**
 * Pay the token's overlay fee address from the wallet (a normal createAction: P2PKH output,
 * wallet funds + change). Run only after the user confirmed the cost. Returns the funding txid.
 *
 * Broadcast now, not "delayed": with wallet-toolbox's default (acceptDelayedBroadcast: true) the
 * signed tx is parked as `sending` for the toolbox Monitor, which bWallet only runs once at wallet
 * start. The payment then sat unbroadcast with its inputs spent locally, and the next launch
 * broadcast it while holding every storage lock, so GET_BALANCE (and the Wallet balance spinner)
 * waited on it. Every other bWallet createAction already sends immediately.
 */
export async function fundIndexing(
  ctx: OneSatContext,
  tokenId: string,
  ticker: string,
  opts: { fund?: number; status?: OverlayStatus | null; timeoutMs?: number } = {},
): Promise<{ txid: string; sats: number; feeAddress: string }> {
  const status = opts.status ?? (await waitForOverlayStatus(ctx, tokenId, { timeoutMs: opts.timeoutMs }));
  if (!status) throw new Error(`The indexer hasn't seen $${ticker} yet. Try "Finish setting up" again in a minute.`);
  const sats = fundAmount(status, opts.fund);
  const description = indexFundDescription(ticker);
  let res: { txid?: string };
  try {
    res = await ctx.wallet.createAction({
      description,
      outputs: [
        {
          lockingScript: new P2PKH().lock(status.feeAddress).toHex(),
          satoshis: sats,
          outputDescription: 'Token indexing fee (1sat overlay)',
        },
      ],
      labels: [INDEX_FUND_LABEL],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    });
  } catch (e) {
    // A broadcast without a final verdict comes back as an error (over the CWI bridge, just a
    // message), yet the tx may be on the network. If the wallet holds it as sent, record it so
    // the card never offers to pay twice; otherwise the toolbox already released its inputs.
    const sent = await withTimeout(
      ctx.wallet.listActions({ labels: [INDEX_FUND_LABEL], limit: 50 }),
      STATUS_TIMEOUT_MS,
      'listActions',
    )
      .then((r) => pickSentIndexFund(r.actions, description))
      .catch(() => null);
    if (sent) {
      setFundRecord(tokenId, { txid: sent, sats, at: Date.now() });
      return { txid: sent, sats, feeAddress: status.feeAddress };
    }
    throw e;
  }
  if (!res.txid) throw new Error('Indexing payment was not sent');
  setFundRecord(tokenId, { txid: res.txid, sats, at: Date.now() });
  return { txid: res.txid, sats, feeAddress: status.feeAddress };
}

export const indexFundDescription = (ticker: string) => `Index $${ticker} (1sat overlay)`.slice(0, 50);

/** Statuses of a payment that was handed to the network (or may have been): never pay again. */
const SENT = new Set(['sending', 'unproven', 'completed']);

/** Newest of our indexing payments for this token that is (possibly) on the network, else null. */
export function pickSentIndexFund(
  actions: { txid?: string; status?: string; description?: string; labels?: string[] }[],
  description: string,
): string | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.description === description && a.status && SENT.has(a.status) && a.txid) return a.txid;
  }
  return null;
}

// ── tokens this device minted (own tokens: personal $NAME, tickets, any mint) ──

const OWN_KEY = 'bwallet.ownTokens';
export type OwnToken = { tokenId: string; ticker: string };
export const OWN_TOKENS_EVENT = 'bwallet-own-tokens';

/** Merge `t` into `list` (by normalised id, newest first). */
export const withOwnToken = (list: OwnToken[], t: OwnToken): OwnToken[] => [
  t,
  ...list.filter((x) => normId(x.tokenId) !== normId(t.tokenId)),
];

export const listOwnTokens = (): OwnToken[] => {
  try {
    const v = JSON.parse(localStorage.getItem(OWN_KEY) ?? '[]') as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is OwnToken => !!x && typeof x.tokenId === 'string' && typeof x.ticker === 'string')
      : [];
  } catch {
    return [];
  }
};

export const rememberOwnToken = (t: OwnToken) => {
  try {
    localStorage.setItem(OWN_KEY, JSON.stringify(withOwnToken(listOwnTokens(), t)));
    window.dispatchEvent(new Event(OWN_TOKENS_EVENT));
  } catch {
    /* storage unavailable / no window in tests */
  }
};

/**
 * After a deploy: fund indexing, but never fail the mint because of it (the token exists and is
 * in the wallet either way); the error is returned so the UI can offer "Finish setting up".
 */
export async function fundAfterDeploy(
  ctx: OneSatContext,
  tokenId: string,
  ticker: string,
): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  rememberOwnToken({ tokenId, ticker });
  try {
    const r = await fundIndexing(ctx, tokenId, ticker);
    return { ok: true, txid: r.txid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Favourite-token list with `id` added (front), deduped. The Wallet tab lists only favourites. */
export const withFavorite = (list: string[] | undefined, id: string): string[] => {
  const n = normId(id);
  return [n, ...(list ?? []).filter((x) => normId(x) !== n)];
};

/** Show the user's freshly minted token on the Wallet tab right away (its balance is local). */
export async function showOnWallet(storage: ChromeStorageService, tokenId: string): Promise<void> {
  const { account } = storage.getCurrentAccountObject();
  if (!account) return;
  const favoriteTokens = withFavorite(account.settings?.favoriteTokens, tokenId);
  const key: keyof ChromeStorageObject = 'accounts';
  const update: Partial<ChromeStorageObject['accounts']> = {
    [account.addresses.identityAddress]: { ...account, settings: { ...account.settings, favoriteTokens } },
  };
  await storage.updateNested(key, update).catch(() => undefined);
}
