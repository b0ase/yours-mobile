/**
 * Store edition: a site may not buy, list or cancel a listing through the wallet (CTO + CEO, round A9, 16 Nov 2026).
 *
 * THE gate for every site entry point. initWallet.ts wraps it outermost on the one site wallet (the permissions
 * manager with every guard), and every site call reaches the wallet through that object: the in-app dApp browser and
 * bApp frames (mobile/dappBrowser.ts handleSiteCall → background createAction → walletForSiteRequest), deep links
 * (they only open a page in the dApp browser, mobile/browse/browseLink.ts), phone-paired sites and the extension's
 * content script. Only createAction is gated: a listing, purchase or cancel is a createAction, and nothing a site
 * asks for later (signAction, createSignature) can sign one without it.
 *
 * In a store build (SITE_MARKET_ACTIONS_ENABLED false) a site's createAction is refused with STORE_NAME_NOTE, before
 * any inner guard, sheet or permission module runs and before anything is signed, when:
 *  1. @1sat/permission-module classifies it as a purchase, a listing or a cancelled listing: its own enrichIntent
 *     (services/oneSatEnrich.ts) is run on the request, and its kind or any of its ordinal steps is one of those.
 *  2. Any output or spent input carries an OrdLock / OrdLockV2 script (the 1Sat marketplace lock), or an output has
 *     the listing tags ('ordlock', 'price:…'), whatever the module makes of it.
 *  3. It touches 1Sat assets and the module can't classify it (fails closed): it names a wallet-held asset by label,
 *     spends a coin from one of the wallet's asset baskets, the module throws or answers 'unknown', or an input it
 *     would need to read is not in the request's BEEF. "Touches 1Sat assets": an ordinal, BSV-20 / BSV-21 or
 *     inscription script on an output or a spent input, an output into the ordinal / token / OpNS baskets, or a
 *     "p <scheme>" label or basket (the ones that hand the action to the asset modules).
 * Everything else (a plain payment, the document seal's OP_RETURN, sign-in and message signing, which are not
 * createAction at all) goes on to the wallet exactly as before. bWalletX never wraps the wallet with this
 * (initWallet.ts), so its sites still get the module's purchase and listing sheets.
 */
import { Beef, Script, type WalletInterface } from '@bsv/sdk';
import { BSV20, BSV21, Inscription, OrdLock, OrdLockV2 } from '@1sat/templates';
import { ONESAT_ASSET_BASKETS, parseOneInputLabel } from '@1sat/types';
import { STORE_NAME_NOTE } from '../mobile/storeBuild';
import { canonicalOutpoint } from './canonicalOutpoint';
import { everyOutput } from './everyOutput';
import { enrichIntent } from './oneSatEnrich';

/** What a site is told: the same words as every other feature this edition leaves out. */
export const STORE_MARKET_REFUSAL = STORE_NAME_NOTE;

/** The module's intent kinds and ordinal steps that are buying or listing. */
export const MARKET_KINDS: readonly string[] = ['purchase', 'listing', 'cancel-listing'];
export const MARKET_STEPS: readonly string[] = ['purchase', 'list', 'cancel-listing'];

/** Output baskets that hold ordinals, tokens or names (the legacy 'p 1sat bsv21' token basket included). */
const ASSET_OUTPUT_BASKETS = new Set(['1sat', 'bsv21', 'bsv20', 'opns', 'p 1sat bsv21']);
/** Every basket the wallet keeps 1Sat assets in: a site spending a coin from one is an asset action. */
export const ASSET_INPUT_BASKETS: readonly string[] = [...ONESAT_ASSET_BASKETS, 'p 1sat bsv21'];

export type StoreMarketWhy = 'purchase' | 'listing' | 'cancel-listing' | 'ordlock' | 'held-asset' | 'unclassified';
export type StoreMarketVerdict = { refuse: false; kind: string } | { refuse: true; why: StoreMarketWhy };
export type StoreMarketDeps = {
  /** Canonical outpoints ('txid.vout') of every coin in the wallet's asset baskets. Throwing refuses (fails closed). */
  assetOutpoints: () => Promise<Set<string>>;
};

type Output = { lockingScript?: unknown; basket?: unknown; tags?: unknown; satoshis?: unknown };
type Input = { outpoint?: unknown };
type Args = { labels?: unknown; outputs?: unknown; inputs?: unknown; inputBEEF?: unknown };

type ScriptKind = 'ordlock' | 'asset' | 'plain' | 'unreadable';
/** What a locking script is, for this gate: the marketplace lock, a 1Sat asset, or anything else. */
export const scriptKind = (hex: unknown): ScriptKind => {
  if (hex === undefined || hex === '') return 'plain';
  if (typeof hex !== 'string') return 'unreadable';
  try {
    const s = Script.fromHex(hex);
    if (OrdLock.isOrdLock(s) || OrdLockV2.isOrdLockV2(s)) return 'ordlock';
    if (BSV21.decode(s) || BSV20.decode(s) || Inscription.decode(s)) return 'asset';
    return 'plain';
  } catch {
    return 'unreadable';
  }
};

const listingTag = (t: unknown) =>
  typeof t === 'string' && (t.trim().toLowerCase() === 'ordlock' || /^\s*price:/i.test(t));
const normBasket = (b: unknown) => (typeof b === 'string' ? b.trim().toLowerCase() : b);

/** The request as guardSiteTokens hands it on: baskets trimmed and lower-cased, the legacy token basket renamed. */
const normalized = (a: Args): Args => ({
  ...a,
  outputs: Array.isArray(a.outputs)
    ? a.outputs.map((o: Output) => {
        const b = normBasket(o?.basket);
        return {
          ...o,
          ...(typeof b === 'string' ? { basket: b === 'p 1sat bsv21' ? 'bsv21' : b } : {}),
          ...(Array.isArray(o?.tags) ? { tags: o.tags.map((t) => (typeof t === 'string' ? t.toLowerCase() : t)) } : {}),
        };
      })
    : a.outputs,
});

/** enrichIntent reads the wallet only for held-asset labels (refused before it runs) and to decrypt records. */
const NO_LOOKUPS = {
  listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
  decrypt: async () => {
    throw new Error('the store gate decrypts nothing');
  },
} as unknown as WalletInterface;

/** Pure apart from deps.assetOutpoints: should a store build refuse this site createAction, and why. */
export const storeMarketVerdict = async (args: unknown, deps: StoreMarketDeps): Promise<StoreMarketVerdict> => {
  if (!args || typeof args !== 'object') return { refuse: false, kind: 'none' };
  const a = args as Args;
  const refuse = (why: StoreMarketWhy): StoreMarketVerdict => ({ refuse: true, why });
  let touches = false;
  let unreadable = false;

  // Labels: a held asset named for a module to load, an outside coin for it to spend, or any module dispatch.
  const external: string[] = [];
  for (const l of Array.isArray(a.labels) ? a.labels : []) {
    if (typeof l !== 'string') continue;
    const parsed = parseOneInputLabel(l);
    if (parsed?.kind === 'id') return refuse('held-asset');
    if (parsed?.kind === 'outpoint') external.push(canonicalOutpoint(parsed.outpoint) ?? parsed.outpoint);
    if (l.startsWith('p ')) touches = true;
  }

  // Outputs: listing tags, the marketplace lock, asset scripts and asset baskets.
  for (const o of Array.isArray(a.outputs) ? (a.outputs as Output[]) : []) {
    if (Array.isArray(o?.tags) && o.tags.some(listingTag)) return refuse('ordlock');
    const kind = scriptKind(o?.lockingScript);
    if (kind === 'ordlock') return refuse('ordlock');
    if (kind === 'asset') touches = true;
    if (kind === 'unreadable') unreadable = true;
    const b = normBasket(o?.basket);
    if (typeof b === 'string' && (ASSET_OUTPUT_BASKETS.has(b) || b.startsWith('p '))) touches = true;
  }

  // Spent coins: read from the request's BEEF; anything not in it is a coin the wallet holds (or nothing at all).
  let beef: Beef | null = null;
  if (a.inputBEEF !== undefined && a.inputBEEF !== null)
    try {
      beef = Beef.fromBinary(Array.from(a.inputBEEF as ArrayLike<number>));
    } catch {
      beef = null;
    }
  const sourceKind = (op: string): ScriptKind | null => {
    const [txid, vout] = op.split('.');
    const out = beef?.findTxid(txid)?.tx?.outputs[Number(vout)];
    return out ? scriptKind(out.lockingScript.toHex()) : null;
  };
  const unread: string[] = [];
  const spent = (Array.isArray(a.inputs) ? (a.inputs as Input[]) : []).map((i) => canonicalOutpoint(i?.outpoint));
  for (const op of [...spent, ...external]) {
    if (op === null) {
      unreadable = true;
      continue;
    }
    const kind = sourceKind(op);
    if (kind === 'ordlock') return refuse('ordlock');
    if (kind === null) unread.push(op);
    else if (kind === 'asset') touches = true;
    else if (kind === 'unreadable') unreadable = true;
  }
  // A coin the module was told to spend from outside (purchase of a listing) must be in the BEEF to be read.
  if (external.some((op) => unread.includes(op))) return refuse('unclassified');
  if (unread.length) {
    let held: Set<string>;
    try {
      held = await deps.assetOutpoints();
    } catch {
      return refuse('unclassified');
    }
    if (unread.some((op) => held.has(op))) return refuse('held-asset');
  }

  // The module's own classification, of the request as sent and as the inner guards hand it on.
  const kinds: string[] = [];
  for (const variant of [a, normalized(a)]) {
    let intent: Awaited<ReturnType<typeof enrichIntent>>;
    try {
      intent = await enrichIntent(NO_LOOKUPS, variant as never);
    } catch {
      if (touches) return refuse('unclassified');
      continue;
    }
    if (MARKET_KINDS.includes(intent.kind)) return refuse(intent.kind as StoreMarketWhy);
    const step = intent.ordinalEdges.find((e) => MARKET_STEPS.includes(e.operation));
    if (step) return refuse(step.operation === 'list' ? 'listing' : (step.operation as StoreMarketWhy));
    kinds.push(intent.kind);
  }
  if (touches && (unreadable || unread.length > 0 || kinds.length === 0 || kinds.includes('unknown')))
    return refuse('unclassified');
  return { refuse: false, kind: kinds[0] ?? 'unknown' };
};

/** No wallet lookup: the page side has no wallet. Only a site coin missing from the BEEF needs one, and then the
 * wallet-side backstop (guardStoreMarketActions) looks it up. */
const NO_HELD_LOOKUP: StoreMarketDeps = { assetOutpoints: async () => new Set<string>() };

/**
 * THE store check, used by both callers so they can't disagree: why a store build refuses this site createAction, or
 * null. mobile/dappBrowser.ts handleSiteCall calls it with no deps BEFORE the device-owner prompt (Face ID), so a
 * store user is never asked for Face ID only to be refused (CTO, A9). guardStoreMarketActions (initWallet.ts) calls it
 * again with the wallet's asset-basket lookup as the backstop for every site entry point.
 */
export const storeMarketRefusal = async (
  args: unknown,
  deps: StoreMarketDeps = NO_HELD_LOOKUP,
): Promise<StoreMarketWhy | null> => {
  const verdict = await storeMarketVerdict(args, deps);
  return verdict.refuse ? verdict.why : null;
};

/** Every coin in the wallet's asset baskets, read page by page from the base wallet (a failure throws). */
export const walletAssetOutpoints =
  (wallet: Pick<WalletInterface, 'listOutputs'>) => async (): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const basket of ASSET_INPUT_BASKETS) {
      const rows = await everyOutput<{ outpoint?: string }>(
        wallet,
        (args) => wallet.listOutputs(args as never) as never,
        { basket },
        '',
      );
      for (const r of rows) {
        const op = canonicalOutpoint(r?.outpoint);
        if (op) out.add(op);
      }
    }
    return out;
  };

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap the site wallet (in place, like the other guards): a site's createAction goes through storeMarketRefusal first,
 * and a refusal throws STORE_MARKET_REFUSAL without calling into the wallet. The wallet's own calls pass straight on.
 */
export function guardStoreMarketActions<T extends object>(
  wallet: T,
  deps: StoreMarketDeps & { adminOriginator: string },
): T {
  const w = wallet as T & { createAction?: AnyFn };
  const create = w.createAction;
  if (typeof create !== 'function') return wallet;
  w.createAction = async (args: unknown, originator?: unknown) => {
    if (originator !== deps.adminOriginator) {
      const why = await storeMarketRefusal(args, deps);
      if (why) {
        console.warn(`[store] refused a site's ${why} action from ${String(originator)}`);
        throw new Error(STORE_MARKET_REFUSAL);
      }
    }
    return create.call(wallet, args, originator);
  };
  return wallet;
}
