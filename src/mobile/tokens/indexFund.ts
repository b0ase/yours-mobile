import { HD, Hash, P2PKH, Utils } from '@bsv/sdk';
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
 * Owner decision (3 Oct 2026): minting no longer pays indexing. The creator sets up the token's
 * room later ("Set up $X's room", tokens/roomSetup.ts): one confirmed tx that tops the fee address
 * up to the indexer minimum, plus a bCorp setup fee output outside a store build. Later transfers
 * pay their own per-output fee (sendBsv21 adds it).
 *
 * Since 2 Oct 2026 the indexer keeps a token inactive until its balance reaches `min_funding`
 * (10,000,000 sats = 0.1 BSV); 3,000 sats no longer lists anything. Lower INDEX_FUND_SATS here if
 * 1Sat lowers min_funding.
 */

/** Default room-setup funding: the indexer's minimum balance for a listed token (min_funding). */
export const INDEX_FUND_SATS = 10_000_000;
export const DEFAULT_FEE_PER_OUTPUT = 1000;
/** Funding tx: one input, change, one P2PKH output (~230 B at ~100 sat/kB). */
export const INDEX_FUND_NETWORK_SATS = 30;
/** Indexing total for a confirm sheet (funding + its tx fee). */
export const indexCostSats = (fund = INDEX_FUND_SATS) => fund + INDEX_FUND_NETWORK_SATS;

export type OverlayStatus = {
  feeAddress: string;
  feePerOutput: number;
  isActive: boolean;
  balance: number;
  /**
   * Balance the indexer wants before it lists the token (`min_funding`, 10,000,000 sats = 0.1 BSV
   * when this was added on 2 Oct 2026; earlier a few thousand sats activated a token). 0 = not sent.
   */
  minFunding: number;
  /** Total ever paid to the fee address (`credits`); activation needs credits ≥ min_funding. 0 when not given. */
  credits?: number;
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
    minFunding: typeof s.min_funding === 'number' && s.min_funding > 0 ? s.min_funding : 0,
    ...(typeof s.credits === 'number' && s.credits > 0 ? { credits: s.credits } : {}),
  };
}

// ── Fee address derived locally (b-open-io/1sat-stack pkg/bsv21/fee.go GenerateFeeAddress) ──

/**
 * The indexer's public HD key for token fee addresses (1sat-stack fee.go: "matches 1sat-indexer and
 * bsv21-overlay-1sat-sync"; GorillaPool's ordinals API reports the same address as `fundAddress`).
 */
export const FEE_ADDRESS_XPUB =
  'xpub661MyMwAqRbcF221R74MPqdipLsgUevAAX4hZP2rywyEeShpbe3v2r9ciAvSGT6FB22TEmFLdUyeEDJL4ekG8s9H5WXbzDQPr6eW1zEYYy9';

const TOKEN_ID_RE = /^([0-9a-f]{64})[_.](\d{1,10})$/i;

/**
 * A token's indexer fee address, computed here from its id: sha256(txid bytes in hex order ‖ vout as
 * 4 bytes big-endian) → path m/21/(u32be(h[0..4])>>1)/(u32be(h[24..28])>>1) under FEE_ADDRESS_XPUB.
 * It depends on the deploy txid, so it only exists after the deploy is signed: the deposit can never
 * ride in the deploy transaction itself. null for a malformed id.
 */
export function deriveFeeAddress(tokenId: string): string | null {
  const m = TOKEN_ID_RE.exec(tokenId.trim());
  if (!m) return null;
  const vout = Number(m[2]);
  if (!Number.isSafeInteger(vout) || vout > 0xffffffff) return null;
  const h = Hash.sha256([
    ...Utils.toArray(m[1].toLowerCase(), 'hex'),
    (vout >>> 24) & 255,
    (vout >>> 16) & 255,
    (vout >>> 8) & 255,
    vout & 255,
  ]);
  const u32 = (o: number) => ((h[o] << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) >>> 0;
  return HD.fromString(FEE_ADDRESS_XPUB)
    .derive(`m/21/${u32(0) >>> 1}/${u32(24) >>> 1}`)
    .pubKey.toAddress();
}

// ── Launch indexing deposit ──

/** The indexer's own funding headroom: GET /bsv21/{id}/fund adds this many outputs past what activates. */
export const FUNDING_HEADROOM_OUTPUTS = 10;
/**
 * Outputs a launch deposit must cover at the least: the deploy, a vesting lock (lock + change), and the
 * creator's first 100 transfers (recipient + token change each) plus room for a few airdrops ≈ 250.
 * Today the indexer's min_funding (10,000,000 sats ≈ 10,000 outputs) is far above this, so it decides
 * the deposit; this floor only matters if 1Sat lowers min_funding.
 */
export const LAUNCH_INDEX_OUTPUTS = 250;

/**
 * Sats a new coin's indexing deposit pays: what activates it (min_funding minus anything already paid)
 * plus the indexer's 10-output headroom, and never less than LAUNCH_INDEX_OUTPUTS outputs. Before the
 * indexer has seen the token (always the case on the review sheet): the published defaults, so a fresh
 * token = 10,000,000 + 10 × 1,000 = 10,010,000 sats, the same figure the indexer's /fund route quotes.
 */
export function launchDepositSats(
  s?: Partial<Pick<OverlayStatus, 'feePerOutput' | 'minFunding' | 'credits'>> | null,
): number {
  const fpo = s?.feePerOutput && s.feePerOutput > 0 ? s.feePerOutput : DEFAULT_FEE_PER_OUTPUT;
  const min = s?.minFunding && s.minFunding > 0 ? s.minFunding : INDEX_FUND_SATS;
  const activate = Math.max(0, min - Math.max(0, s?.credits ?? 0));
  return Math.max(activate + FUNDING_HEADROOM_OUTPUTS * fpo, LAUNCH_INDEX_OUTPUTS * fpo);
}

/** Issuer "Top up indexing" on an active token: 1,000 more indexed outputs (1,000,000 sats at 1,000 per output). */
export const TOP_UP_OUTPUTS = 1000;
/** What a top-up pays: the activating deposit when the token is inactive, else TOP_UP_OUTPUTS outputs. */
export const topUpSats = (s: OverlayStatus): number =>
  needsIndexFunding(s) ? launchDepositSats(s) : TOP_UP_OUTPUTS * s.feePerOutput;

/** "$1.80 · 10,010,000 sats" (just the sats when the BSV price is unknown). */
export const depositValue = (sats: number, fmt: (sats: number) => string): string => {
  const m = fmt(sats);
  return /sats/.test(m) ? m : `${m} · ${sats.toLocaleString('en-US')} sats`;
};

/** Indexed outputs the fund still pays for (a transfer is about 2: recipient + token change). */
export const outputsLeft = (s: Pick<OverlayStatus, 'balance' | 'feePerOutput'>): number =>
  s.feePerOutput > 0 ? Math.max(0, Math.floor(s.balance / s.feePerOutput)) : 0;

/** Does this token still need its indexing funded? Unknown status (not seen yet) = yes. */
export const needsIndexFunding = (s: OverlayStatus | null) => !s || !s.isActive || s.balance < s.feePerOutput;

/**
 * Token detail "Index $X" button (any holder, not just the issuer): 'needs' when the indexer knows
 * the token and it is inactive or can't pay one more output; 'indexed' when it is active and funded;
 * 'unknown' when the indexer didn't answer (offer nothing, never ask for money on a guess).
 */
export const holderIndexState = (s: OverlayStatus | null | undefined): 'needs' | 'indexed' | 'unknown' =>
  !s ? 'unknown' : needsIndexFunding(s) ? 'needs' : 'indexed';

/**
 * Sats to send. When the indexer states a minimum: exactly what brings the balance up to it (a
 * fresh mint: the whole minimum). Otherwise the configured funding. Never less than one output's fee.
 */
export const fundAmount = (
  s: Pick<OverlayStatus, 'feePerOutput'> & Partial<Pick<OverlayStatus, 'balance' | 'minFunding'>>,
  fund = INDEX_FUND_SATS,
) => Math.max(s.feePerOutput, s.minFunding ? s.minFunding - Math.max(0, s.balance ?? 0) : fund);

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

// ── local record (so "Set up $X's room" knows what's pending) ──

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
  opts: {
    fund?: number;
    /** Pay exactly this (what the user approved), instead of the computed amount. */
    sats?: number;
    status?: OverlayStatus | null;
    /**
     * When the indexer hasn't reported the token in time, pay the locally derived fee address
     * (deriveFeeAddress) instead of failing. The overlay credits it when it next checks the address.
     */
    allowDerived?: boolean;
    timeoutMs?: number;
    /** Extra outputs in the SAME tx (the bCorp room setup fee): all paid together or not at all. */
    extraOutputs?: { address: string; satoshis: number; outputDescription: string }[];
  } = {},
): Promise<{ txid: string; sats: number; feeAddress: string }> {
  const derived = deriveFeeAddress(tokenId);
  let status = opts.status ?? (await waitForOverlayStatus(ctx, tokenId, { timeoutMs: opts.timeoutMs }));
  if (!status && opts.allowDerived && derived)
    status = { feeAddress: derived, feePerOutput: DEFAULT_FEE_PER_OUTPUT, isActive: false, balance: 0, minFunding: 0 };
  if (!status) throw new Error(`The indexer hasn't seen $${ticker} yet. Try setting up its room again in a minute.`);
  // Never pay an address the token's id doesn't lead to (a wrong or tampered indexer answer).
  if (opts.allowDerived && derived && status.feeAddress !== derived)
    throw new Error(`The indexer gave $${ticker} a fee address that doesn't match its id. Nothing was sent.`);
  const sats = opts.sats && opts.sats > 0 ? Math.floor(opts.sats) : fundAmount(status, opts.fund);
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
        ...(opts.extraOutputs ?? [])
          .filter((o) => o.address && o.satoshis > 0)
          .map((o) => ({
            lockingScript: new P2PKH().lock(o.address).toHex(),
            satoshis: o.satoshis,
            outputDescription: o.outputDescription,
          })),
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
