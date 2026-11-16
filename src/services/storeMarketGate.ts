/**
 * Store edition: a site may not buy, list or cancel a listing through the wallet (CTO + CEO, round A9, 16 Nov 2026).
 *
 * THE gate for every site entry point. initWallet.ts wraps it outermost on the one site wallet (the permissions
 * manager with every guard), and every site call reaches the wallet through that object: the in-app dApp browser and
 * bApp frames (mobile/dappBrowser.ts handleSiteCall → background createAction → walletForSiteRequest), deep links
 * (they only open a page in the dApp browser, mobile/browse/browseLink.ts), phone-paired sites and the extension's
 * content script. createAction is gated (a listing, purchase or cancel is a createAction, and nothing a site asks for
 * later, signAction or createSignature, can sign one without it), and since A10 internalizeAction too (6 below).
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
 * Round A10 (review R1, R2):
 *  4. A fungible token deploy or mint is judged output by output (and on every input read from the BEEF), whatever
 *     the module calls the whole action: BSV-21 deploy+mint / deploy+auth / mint / auth, BSV-20 deploy / mint, and
 *     any other bsv-20 content that is not a plain transfer or burn ('token-mint').
 *  5. Every spent coin is judged. A coin the BEEF does not carry in full (txid-only with trustSelf 'known', or left
 *     out) is read where the wallet itself reads it, from the wallet's storage (deps.inputScript, the backstop only):
 *     an OrdLock, a token deploy or mint, or any other 1Sat asset there is refused, and so is a coin whose script
 *     can't be found (fails closed). A coin from one of the wallet's asset baskets is refused whether or not the site
 *     put its transaction in the BEEF.
 *  6. internalizeAction is gated too (storeInternalizeRefusal): a site may not have the wallet take in an OrdLock, a
 *     token deploy or mint, or anything into the site-token deploy key (siteTokens.ts item 6). That is how a site
 *     would stage a listing in the wallet's storage for (5).
 * Everything else (a plain payment, the document seal's OP_RETURN, sign-in and message signing, which are not
 * createAction at all) goes on to the wallet exactly as before. bWalletX never wraps the wallet with this
 * (initWallet.ts), so its sites still get the module's purchase and listing sheets.
 */
import { Beef, OP, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
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

export type StoreMarketWhy =
  | 'purchase'
  | 'listing'
  | 'cancel-listing'
  | 'ordlock'
  | 'token-mint'
  | 'held-asset'
  | 'unclassified';
export type StoreMarketVerdict = { refuse: false; kind: string } | { refuse: true; why: StoreMarketWhy };
export type StoreMarketDeps = {
  /** Canonical outpoints ('txid.vout') of every coin in the wallet's asset baskets. Throwing refuses (fails closed). */
  assetOutpoints: () => Promise<Set<string>>;
  /**
   * The locking script (hex) of a spent coin the request's BEEF does not carry in full, read where the wallet reads it
   * (storedInputScript). null or throwing refuses (fails closed). Absent on the page side, which has no wallet.
   */
  inputScript?: (outpoint: string) => Promise<string | null>;
};

type Output = { lockingScript?: unknown; basket?: unknown; tags?: unknown; satoshis?: unknown };
type Input = { outpoint?: unknown };
type Args = { labels?: unknown; outputs?: unknown; inputs?: unknown; inputBEEF?: unknown };

type ScriptKind = 'ordlock' | 'mint' | 'asset' | 'plain' | 'unreadable';

/** The content type every BSV-20 and BSV-21 token inscription carries (compared without case or parameters). */
const TOKEN_CONTENT = 'application/bsv-20';
/** Token ops that only move supply that already exists. Every other op creates supply or the right to mint it. */
const TOKEN_MOVES = new Set(['transfer', 'burn']);
const ORD = [0x6f, 0x72, 0x64];
type Chunk = Script['chunks'][number];
/** A data push of any form (direct, PUSHDATA1/2/4); OP_0 is an empty push. A truncated push is malformed. */
const pushData = (c: Chunk | undefined): number[] | null => {
  if (!c || c.op > OP.OP_PUSHDATA4) return null;
  if ((c as { invalidLength?: boolean }).invalidLength) throw new Error('truncated push');
  return c.data ?? [];
};
const sameBytes = (a: number[] | null, b: number[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
/** An envelope field's tag: OP_1..OP_16, or a pushed little-endian number. */
const tagOf = (c: Chunk): number | null => {
  if (c.op >= OP.OP_1 && c.op <= OP.OP_16) return c.op - OP.OP_1 + 1;
  const d = pushData(c);
  return d && d.length ? d.reduceRight((n, b) => n * 256 + b, 0) : null;
};

type Envelope = { types: string[]; body: number[] };
/**
 * Every ord envelope in a script, read chunk by chunk (A11, R7 + R8): OP_0 (OP_FALSE), OP_IF, then any push whose data
 * is "ord", then tag / value fields up to OP_0 (the body pushes) and OP_ENDIF. The content types are every field-1
 * value. A malformed envelope (a field with no value, a non-push in the body, no OP_ENDIF) throws.
 */
export const ordEnvelopes = (s: Script): Envelope[] => {
  const c = s.chunks;
  const out: Envelope[] = [];
  for (let i = 0; i + 2 < c.length; i++) {
    if (c[i].op !== OP.OP_0 || c[i + 1].op !== OP.OP_IF || !sameBytes(pushData(c[i + 2]), ORD)) continue;
    const env: Envelope = { types: [], body: [] };
    let j = i + 3;
    let closed = false;
    while (j < c.length) {
      if (c[j].op === OP.OP_ENDIF) {
        closed = true;
        break;
      }
      if (c[j].op === OP.OP_0) {
        // The body: data pushes up to OP_ENDIF.
        for (j++; j < c.length && c[j].op !== OP.OP_ENDIF; j++) {
          const d = pushData(c[j]);
          if (d === null) throw new Error('non-push in an inscription body');
          env.body.push(...d);
        }
        closed = j < c.length;
        break;
      }
      const tag = tagOf(c[j]);
      const value = pushData(c[j + 1]);
      if (value === null) throw new Error('inscription field without a value');
      if (tag === 1) env.types.push(Utils.toUTF8(value));
      j += 2;
    }
    if (!closed) throw new Error('inscription envelope without OP_ENDIF');
    out.push(env);
    i = j;
  }
  return out;
};

const isTokenType = (t: string) => t.split(';')[0].trim().toLowerCase() === TOKEN_CONTENT;
/** One token envelope rebuilt in the decoders' canonical form, so their own validation reads it. */
const canonicalToken = (body: number[]) =>
  new Script()
    .writeOpCode(OP.OP_0)
    .writeOpCode(OP.OP_IF)
    .writeBin(ORD)
    .writeOpCode(OP.OP_1)
    .writeBin(Utils.toArray(TOKEN_CONTENT, 'utf8'))
    .writeOpCode(OP.OP_0)
    .writeBin(body)
    .writeOpCode(OP.OP_ENDIF);

/**
 * A fungible token deploy or mint (A10 R2, A11 R7–R9): ANY envelope whose content type (field 1, any case) is
 * application/bsv-20 and whose body does not decode as a plain BSV-21 or BSV-20 transfer or burn. So BSV-21
 * deploy+mint, deploy+auth, mint and auth, BSV-20 deploy and mint, and bsv-20 content the decoders can't read all count
 * (fails closed), in whatever push form and envelope position. Content that only mentions the type does not.
 */
const tokenCreation = (envelopes: Envelope[]): boolean =>
  envelopes.some((e) => {
    if (!e.types.some(isTokenType)) return false;
    const canon = canonicalToken(e.body);
    const t = BSV21.decode(canon) ?? BSV20.decode(canon);
    return !t || !TOKEN_MOVES.has(String(t.tokenData.op).toLowerCase());
  });

/** What a locking script is, for this gate: the marketplace lock, a token deploy or mint, a 1Sat asset, or other. */
export const scriptKind = (hex: unknown): ScriptKind => {
  if (hex === undefined || hex === '') return 'plain';
  if (typeof hex !== 'string') return 'unreadable';
  try {
    const s = Script.fromHex(hex);
    if (OrdLock.isOrdLock(s) || OrdLockV2.isOrdLockV2(s)) return 'ordlock';
    const envelopes = ordEnvelopes(s); // throws on a malformed envelope: 'unreadable', refused (A11)
    if (tokenCreation(envelopes)) return 'mint';
    if (envelopes.length || BSV21.decode(s) || BSV20.decode(s) || Inscription.decode(s)) return 'asset';
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
    if (kind === 'mint') return refuse('token-mint');
    if (kind === 'asset') touches = true;
    // A script the gate can't parse (or a malformed inscription envelope) is refused outright (A11).
    if (kind === 'unreadable') return refuse('unclassified');
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
    if (kind === 'mint') return refuse('token-mint');
    if (kind === null) unread.push(op);
    else if (kind === 'asset') touches = true;
    else if (kind === 'unreadable') return refuse('unclassified');
  }
  // A coin the module was told to spend from outside (purchase of a listing) must be in the BEEF to be read.
  if (external.some((op) => unread.includes(op))) return refuse('unclassified');
  // A coin from one of the wallet's asset baskets, whether or not the site also put its transaction in the BEEF (A10).
  const coins = spent.filter((op): op is string => op !== null);
  if (coins.length) {
    let held: Set<string>;
    try {
      held = await deps.assetOutpoints();
    } catch {
      return refuse('unclassified');
    }
    if (coins.some((op) => held.has(op))) return refuse('held-asset');
  }
  // A coin the BEEF does not carry in full: the wallet reads its script from its own storage (wallet-toolbox
  // validateRequiredInputs, txid-only with trustSelf 'known' or left out), so the backstop reads it there too (A10, R1).
  if (deps.inputScript)
    for (const op of unread) {
      let hex: string | null;
      try {
        hex = await deps.inputScript(op);
      } catch {
        return refuse('unclassified');
      }
      const kind = hex === null ? 'unreadable' : scriptKind(hex);
      if (kind === 'ordlock') return refuse('ordlock');
      if (kind === 'mint') return refuse('token-mint');
      if (kind === 'asset') return refuse('held-asset');
      if (kind === 'unreadable') return refuse('unclassified');
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

/** Where the wallet reads a spent coin's script when the BEEF does not carry it: its own output row, else the raw tx. */
export type StoredScripts = {
  outputScript: (txid: string, vout: number) => Promise<ArrayLike<number> | string | null | undefined>;
  rawTx: (txid: string) => Promise<ArrayLike<number> | null | undefined>;
};

/**
 * deps.inputScript for the backstop, in wallet-toolbox's order (resolveInputScript): the wallet's own output row for
 * the outpoint, else the stored raw transaction (getProvenOrRawTx, which a txid-only BEEF entry reads). null when
 * neither has it: the gate then refuses.
 */
export const storedInputScript =
  (r: StoredScripts) =>
  async (outpoint: string): Promise<string | null> => {
    const [txid, v] = outpoint.split('.');
    const vout = Number(v);
    const own = await r.outputScript(txid, vout);
    if (own !== null && own !== undefined && own.length > 0)
      return typeof own === 'string' ? own : Utils.toHex(Array.from(own));
    const raw = await r.rawTx(txid);
    if (!raw || raw.length === 0) return null;
    return Transaction.fromBinary(Array.from(raw)).outputs[vout]?.lockingScript.toHex() ?? null;
  };

type InternalizeOutput = { outputIndex?: unknown; insertionRemittance?: { customInstructions?: unknown } };

/** The site-token deploy receive key (siteTokens.ts item 6: keyID 'deploy-<ms>') named in an insertion's record. */
const deployKeyRecord = (ci: unknown): boolean => {
  if (typeof ci !== 'string') return false;
  try {
    const keyID = (JSON.parse(ci) as { keyID?: unknown })?.keyID;
    return typeof keyID === 'string' && /^\s*deploy\b/i.test(keyID);
  } catch {
    return false;
  }
};

/**
 * Store build, a site's internalizeAction (A10, R1 + R2): why it is refused, or null. Each output the site asks the
 * wallet to take in is read from the transaction: an OrdLock (a listing staged in the wallet's storage), a token
 * deploy or mint, or a record naming the site-token deploy key is refused. So is a transaction or output the gate
 * can't read (fails closed). Anything else (a payment, a token or ordinal delivery) goes on as before.
 */
export const storeInternalizeRefusal = (args: unknown): StoreMarketWhy | null => {
  if (!args || typeof args !== 'object') return null;
  const a = args as { tx?: unknown; outputs?: unknown };
  const outputs = Array.isArray(a.outputs) ? (a.outputs as InternalizeOutput[]) : [];
  if (outputs.length === 0) return null;
  let tx: Transaction;
  try {
    tx = Transaction.fromAtomicBEEF(Array.from(a.tx as ArrayLike<number>));
  } catch {
    return 'unclassified';
  }
  for (const o of outputs) {
    if (deployKeyRecord(o?.insertionRemittance?.customInstructions)) return 'token-mint';
    const out = typeof o?.outputIndex === 'number' ? tx.outputs[o.outputIndex] : undefined;
    if (!out) return 'unclassified';
    const kind = scriptKind(out.lockingScript.toHex());
    if (kind === 'ordlock') return 'ordlock';
    if (kind === 'mint') return 'token-mint';
    if (kind === 'unreadable') return 'unclassified';
  }
  return null;
};

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap the site wallet (in place, like the other guards): a site's createAction goes through storeMarketRefusal first,
 * and its internalizeAction through storeInternalizeRefusal; a refusal throws STORE_MARKET_REFUSAL without calling into
 * the wallet. The wallet's own calls pass straight on.
 */
export function guardStoreMarketActions<T extends object>(
  wallet: T,
  deps: StoreMarketDeps & { adminOriginator: string },
): T {
  const w = wallet as T & { createAction?: AnyFn; internalizeAction?: AnyFn };
  const create = w.createAction;
  if (typeof create === 'function')
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
  const internalize = w.internalizeAction;
  if (typeof internalize === 'function')
    w.internalizeAction = async (args: unknown, originator?: unknown) => {
      if (originator !== deps.adminOriginator) {
        const why = storeInternalizeRefusal(args);
        if (why) {
          console.warn(`[store] refused a site's ${why} internalize from ${String(originator)}`);
          throw new Error(STORE_MARKET_REFUSAL);
        }
      }
      return internalize.call(wallet, args, originator);
    };
  return wallet;
}
