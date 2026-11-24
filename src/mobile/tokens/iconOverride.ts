import { KeyDeriver, OP, PrivateKey, PublicKey, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { applyAip, ONESAT_MAINNET_CONTENT_URL, type OneSatContext } from '@1sat/actions';
import { aipValid, isIdentityKey, isTokenId, MAP_PREFIX, normTokenId, parseCanonicalSigned } from '../issuer/issuer';
import { limited, REGISTRY, WOC_TX_HEX } from '../issuer/issuerVerify';
import type { Fetch } from '../names/names';
import { hasPinnedArt } from './officialTokens';

/**
 * Issuer-signed icon override for an existing BSV-21 token (spec: docs/specs/token-icon-override.md).
 *
 * A token's deploy icon is fixed on chain. The issuer can publish a signed statement that points at
 * a newer image inscription; wallets that read it show that image instead. One 0-sat OP_RETURN
 * (MAP + AIP, the same shape as the issuer statement in issuer.ts):
 *
 *   OP_FALSE OP_RETURN 1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5 SET
 *     p bsv-21-meta tokenId <txid_vout> icon <txid_vout of an image inscription> ts <unix seconds>
 *     identity_key <33-byte hex>
 *   | 15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva BITCOIN_ECDSA <address> <compact sig>
 *
 * Canonical layout only (MAP is part 0, AIP part 1, MAP byte-identical to iconOverrideScript of its
 * own fields). Valid only if the AIP signature checks, the signing address is the ICON child key of
 * identity_key (its own key id, never the one room admin signs with), and identity_key is the issuer
 * recorded in the token's own deploy tx. Anything else is ignored. The newest valid `ts` wins, and
 * a `ts` later than the tx's block time (or first-seen time) plus skew never counts. Verification is
 * local to the txs; no indexer is trusted for validity, only for finding candidate txids.
 */
export const META_PROTOCOL = 'bsv-21-meta';
/**
 * Icon updates have their OWN signing key under the issuer protocol. The issuer child key (key id '1') is also
 * what room admin signs challenge messages with (chat/issuerKey.ts), so a statement signed with it could be
 * coaxed out of that path. This key is never offered there. Verifiers derive it from identity_key the same way.
 */
export const ICON_PROTOCOL: [2, string] = [2, 'bwallet issuer'];
export const ICON_KEY_ID = 'icon 1';
/** A statement's `ts` may be this far past its block time (or first-seen time). Later is invalid for good. */
export const TS_SKEW_SECS = 2 * 3600;
/** How many candidate txids from the index the wallet will check. The index is spec'd to list only valid ones. */
export const MAX_CANDIDATES = 10;
/** An override icon bigger than this is not used. */
export const MAX_ICON_BYTES = 1_048_576;

const { toArray } = Utils;
const isOutpoint = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}_\d{1,6}$/.test(s);
const isTsText = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d{0,11})$/.test(s);
const isTxid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isCompressedKey = (s: unknown): s is string => typeof s === 'string' && /^0[23][0-9a-f]{64}$/.test(s);

/** The BRC-42 child (public) key an issuer signs icon updates with, derivable by anyone from the identity key. */
export function iconSigningKey(identityKey: string): PublicKey {
  return new KeyDeriver(new PrivateKey(1)).derivePublicKey(ICON_PROTOCOL, ICON_KEY_ID, identityKey, false);
}
/** Private side of iconSigningKey (what the wallet's createSignature uses): tests only. */
export function iconSigningPrivateKey(identityPriv: PrivateKey): PrivateKey {
  return new KeyDeriver(identityPriv).derivePrivateKey(ICON_PROTOCOL, ICON_KEY_ID, 'anyone');
}

export interface IconOverride {
  tokenId: string;
  /** Image inscription outpoint `<txid>_<vout>`. */
  icon: string;
  ts: number;
  /** The tx that carried the statement. */
  txid: string;
  identityKey: string;
}

/** Unsigned override statement (sign with AIP before adding to the tx). */
export function iconOverrideScript(f: { tokenId: string; icon: string; ts: number; identityKey: string }): Script {
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  s.writeBin(toArray(MAP_PREFIX, 'utf8'));
  s.writeBin(toArray('SET', 'utf8'));
  const pairs: [string, string][] = [
    ['p', META_PROTOCOL],
    ['tokenId', normTokenId(f.tokenId)],
    ['icon', normTokenId(f.icon)],
    ['ts', String(Math.floor(f.ts))],
    ['identity_key', f.identityKey.toLowerCase()],
  ];
  for (const [k, v] of pairs) {
    s.writeBin(toArray(k, 'utf8'));
    s.writeBin(toArray(v, 'utf8'));
  }
  return s;
}

/** The exact script iconOverrideScript writes for these parsed fields, or null if any value is not strictly canonical. */
function rebuild(f: Record<string, string>): Script | null {
  if (f.p !== META_PROTOCOL || !isOutpoint(f.tokenId) || !isOutpoint(f.icon) || !isTsText(f.ts)) return null;
  if (!isCompressedKey(f.identity_key)) return null;
  return iconOverrideScript({ tokenId: f.tokenId, icon: f.icon, ts: Number(f.ts), identityKey: f.identity_key });
}

/**
 * Every valid override for `tokenId` in `tx` signed by `issuerKey` (the identity key recorded in the
 * token's deploy tx). `seenSecs` is the confirming block's time, or when the tx was first seen if it is
 * unconfirmed: a statement dated later than that plus skew is invalid, for good (not "not yet").
 * Foreign signers, bad signatures, other tokens, non-canonical layouts and malformed fields are skipped.
 */
export function overridesInTx(tx: Transaction, tokenId: string, issuerKey: string, seenSecs: number): IconOverride[] {
  const id = normTokenId(tokenId);
  const key = issuerKey.toLowerCase();
  const out: IconOverride[] = [];
  if (!isTokenId(id) || !isIdentityKey(key) || !Number.isFinite(seenSecs)) return out;
  const txid = tx.id('hex');
  for (const o of tx.outputs) {
    const p = parseCanonicalSigned(o.lockingScript, rebuild);
    if (!p) continue;
    const f = p.fields;
    if (f.tokenId !== id || f.identity_key !== key) continue;
    const ts = Number(f.ts);
    if (ts > seenSecs + TS_SKEW_SECS) continue;
    if (!aipValid(p.message, p.signature, p.address)) continue;
    if (iconSigningKey(key).toAddress() !== p.address) continue;
    out.push({ tokenId: id, icon: f.icon, ts, txid, identityKey: key });
  }
  return out;
}

/** The newest override (highest ts; equal ts → lowest txid, so every wallet picks the same one). */
export function newestOverride(list: IconOverride[]): IconOverride | null {
  return sortOverrides(list)[0] ?? null;
}
const sortOverrides = (list: IconOverride[]) =>
  [...list].sort((a, b) => b.ts - a.ts || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));

/** The URL to show for an override's icon outpoint. */
export const overrideIconUrl = (o: Pick<IconOverride, 'icon'> | null | undefined): string =>
  o ? `${ONESAT_MAINNET_CONTENT_URL}/${o.icon}` : '';

/** The icon to show: a valid override beats the deploy icon; with none, the deploy icon. */
export const pickIcon = (deployIcon: string, override: IconOverride | null): string =>
  override ? overrideIconUrl(override) : deployIcon;

// ---- cache: keyed by token AND issuer key, re-validated on every read ----

const LS = 'bwallet.iconoverride.v2.';
const TTL = 3600_000;
/** After a partly failed lookup an answer is kept only briefly, so a newer statement we could not see shows up soon. */
const SHORT_TTL = 60_000;
type Entry = { at: number; ttl?: number; value: IconOverride | null };
const mem = new Map<string, Entry>();
const stored = new Set<string>();
const inflight = new Map<string, Promise<IconOverride | null>>();
const listeners = new Set<(tokenId: string) => void>();

const cacheKey = (tokenId: string, issuerKey: string) => `${normTokenId(tokenId)}:${issuerKey.toLowerCase()}`;

/** Is `o` a well-formed override for exactly this token and issuer? (Cached JSON is never trusted as-is.) */
const wellFormed = (o: unknown, id: string, key: string): o is IconOverride => {
  const v = o as Partial<IconOverride> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.tokenId === id &&
    v.identityKey === key &&
    isOutpoint(v.icon) &&
    isTxid(v.txid) &&
    typeof v.ts === 'number' &&
    Number.isSafeInteger(v.ts) &&
    v.ts >= 0
  );
};

function readEntry(tokenId: string, issuerKey: string): Entry | undefined {
  const id = normTokenId(tokenId);
  const key = issuerKey.toLowerCase();
  const k = cacheKey(id, key);
  let hit: unknown = mem.get(k);
  if (!hit) {
    try {
      const raw = globalThis.localStorage?.getItem(LS + k);
      if (raw) hit = JSON.parse(raw);
    } catch {
      /* storage blocked or corrupt */
    }
  }
  const e = hit as Partial<Entry> | undefined;
  if (!e || typeof e !== 'object' || typeof e.at !== 'number' || !Number.isFinite(e.at)) return undefined;
  if (e.ttl !== undefined && (typeof e.ttl !== 'number' || !(e.ttl > 0 && e.ttl <= TTL))) return undefined;
  if (e.value !== null && !wellFormed(e.value, id, key)) return undefined;
  return e as Entry;
}

/** A fresh cached answer: an override, null for "none", or undefined when unknown or stale. */
export const cachedOverride = (
  tokenId: string,
  issuerKey: string,
  now = Date.now(),
): IconOverride | null | undefined => {
  const e = readEntry(tokenId, issuerKey);
  if (!e || now - e.at > (e.ttl ?? TTL) || e.at > now + 60_000) return undefined;
  mem.set(cacheKey(tokenId, issuerKey), e);
  return e.value;
};

/** Is `listener` told when a token's cached override changes (so an open screen can refresh)? Returns the unsubscribe. */
export const onOverrideChange = (listener: (tokenId: string) => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const notify = (tokenId: string) => {
  for (const l of [...listeners]) {
    try {
      l(normTokenId(tokenId));
    } catch {
      /* a listener must not break the cache */
    }
  }
};

const remember = (tokenId: string, issuerKey: string, value: IconOverride | null, now: number, ttl?: number) => {
  const k = cacheKey(tokenId, issuerKey);
  const e: Entry = { at: now, value, ...(ttl ? { ttl } : {}) };
  mem.set(k, e);
  try {
    globalThis.localStorage?.setItem(LS + k, JSON.stringify(e));
    stored.add(k);
  } catch {
    /* storage blocked */
  }
  notify(tokenId);
};

export const clearOverrideCache = () => {
  mem.clear();
  try {
    for (const k of stored) globalThis.localStorage?.removeItem(LS + k);
    stored.clear();
  } catch {
    /* storage blocked */
  }
};

// ---- fetching ----

/** Candidate txids that mention the token, from bit-sign's index. Only a pointer: validity is checked locally. */
export async function listOverrideTxids(f: Fetch, tokenId: string): Promise<string[] | null> {
  try {
    const r = await f(`${REGISTRY}/${normTokenId(tokenId)}/icon`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return r.status === 404 ? [] : null;
    const j = (await r.json()) as { txids?: unknown };
    const ids = Array.isArray(j?.txids) ? j.txids : [];
    return ids
      .filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t))
      .map((t) => t.toLowerCase())
      .slice(0, MAX_CANDIDATES);
  } catch {
    return null;
  }
}

const WOC_TX_INFO = (txid: string) => `https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`;

/** The tx, only if what came back really is `txid`. */
async function fetchTx(f: Fetch, txid: string): Promise<Transaction | null> {
  try {
    const hex = await limited(async () => {
      const r = await f(WOC_TX_HEX(txid), { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`tx ${r.status}`);
      return (await r.text()).trim();
    });
    const tx = Transaction.fromHex(hex);
    return tx.id('hex') === txid.toLowerCase() ? tx : null;
  } catch {
    return null;
  }
}

/** Block time if confirmed, else when the node first saw it, else `nowSecs` (a tx no one has seen is seen now). */
async function fetchSeenSecs(f: Fetch, txid: string, nowSecs: number): Promise<number | null> {
  try {
    const j = await limited(async () => {
      const r = await f(WOC_TX_INFO(txid), { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`info ${r.status}`);
      return (await r.json()) as { blocktime?: unknown; time?: unknown };
    });
    for (const t of [j?.blocktime, j?.time]) if (typeof t === 'number' && t > 0 && Number.isFinite(t)) return t;
    return nowSecs;
  } catch {
    return null;
  }
}

/** 'ok': an image under the size cap. 'bad': something else (not an image, too big). 'unknown': could not tell. */
async function checkIcon(f: Fetch, icon: string): Promise<'ok' | 'bad' | 'unknown'> {
  try {
    const r = await f(overrideIconUrl({ icon }), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      void r.body?.cancel().catch(() => undefined);
      return 'unknown';
    }
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const len = Number(r.headers.get('content-length'));
    if (!type.startsWith('image/') || (Number.isFinite(len) && len > MAX_ICON_BYTES)) {
      void r.body?.cancel().catch(() => undefined);
      return 'bad';
    }
    // No (or a wrong) length header: count what actually arrives, up to the cap.
    let seen = 0;
    const reader = r.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.length ?? 0;
      if (seen > MAX_ICON_BYTES) {
        void reader.cancel().catch(() => undefined);
        return 'bad';
      }
    }
    return 'ok';
  } catch {
    return 'unknown';
  }
}

/**
 * The newest valid icon override for a token whose verified issuer is `issuerKey`, or null.
 * `extraTxids` are txs the wallet already knows about. Nothing is cached as "none" unless every fetch worked.
 */
export async function resolveIconOverride(
  tokenId: string,
  issuerKey: string,
  f: Fetch = fetch,
  now = Date.now(),
  extraTxids: string[] = [],
): Promise<IconOverride | null> {
  const id = normTokenId(tokenId);
  const key = issuerKey.toLowerCase();
  // First-party and pinned art always wins: nothing an issuer publishes replaces it.
  if (hasPinnedArt(id) || !isTokenId(id) || !isIdentityKey(key)) return null;
  const hit = cachedOverride(id, key, now);
  if (hit !== undefined && !extraTxids.length) return hit;
  const ck = cacheKey(id, key);
  const running = inflight.get(ck);
  if (running && !extraTxids.length) return running;
  const nowSecs = Math.floor(now / 1000);
  const p = (async () => {
    // What we verified before (even if stale) is a candidate again: a hiding or lagging index cannot lose it.
    const prev = readEntry(id, key)?.value ?? null;
    const listed = await listOverrideTxids(f, id);
    let failed = listed === null;
    const txids = [...new Set([...extraTxids.filter(isTxid), ...(listed ?? []), ...(prev ? [prev.txid] : [])])];
    const found: IconOverride[] = [];
    for (const t of txids) {
      const tx = await fetchTx(f, t);
      const seen = tx ? await fetchSeenSecs(f, t, nowSecs) : null;
      if (tx && seen !== null) found.push(...overridesInTx(tx, id, key, seen));
      else if (prev && prev.txid === t) found.push(prev);
      else failed = true;
    }
    let value: IconOverride | null = null;
    for (const o of sortOverrides(found)) {
      const verdict = await checkIcon(f, o.icon);
      if (verdict === 'ok') {
        value = o;
        break;
      }
      if (verdict === 'unknown') {
        // Cannot tell whether the newest is usable: show the deploy icon for now, cache nothing.
        return null;
      }
    }
    if (value) remember(id, key, value, now, failed ? SHORT_TTL : undefined);
    else if (!failed) remember(id, key, null, now);
    return value;
  })();
  inflight.set(ck, p);
  try {
    return await p;
  } finally {
    inflight.delete(ck);
  }
}

/**
 * Publish an override: sign with the icon child key and put the statement in its own 0-sat output.
 * The tx the wallet returns is checked here (same txid, the statement verifies) and written straight to the
 * cache, so the icon shows at once even before any indexer has the tx. The caller has already shown the approval sheet.
 */
export async function publishIconOverride(
  ctx: OneSatContext,
  tokenId: string,
  icon: string,
  nowMs = Date.now(),
): Promise<{ txid?: string; override?: IconOverride; error?: string }> {
  try {
    const wallet = ctx.wallet as WalletInterface;
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    const identityKey = publicKey.toLowerCase();
    const id = normTokenId(tokenId);
    const iconId = normTokenId(icon);
    if (!isTokenId(id) || !isOutpoint(iconId)) return { error: 'That token or image is not valid' };
    const unsigned = iconOverrideScript({ tokenId: id, icon: iconId, ts: Math.floor(nowMs / 1000), identityKey });
    const signed = await applyAip(ctx, unsigned, ICON_PROTOCOL, ICON_KEY_ID, 'anyone');
    const r = await wallet.createAction({
      description: `New icon for token ${id.slice(0, 8)}…`,
      outputs: [{ lockingScript: signed.toHex(), satoshis: 0, outputDescription: 'Token icon update (MAP + AIP)' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    if (!r.txid) return { error: 'The wallet did not return a transaction' };
    // The wallet's own answer is checked, not trusted: right txid, and our statement is in it and verifies.
    let override: IconOverride | undefined;
    try {
      if (r.tx) {
        const tx = Transaction.fromAtomicBEEF(r.tx);
        if (tx.id('hex') === r.txid.toLowerCase()) {
          override = overridesInTx(tx, id, identityKey, Math.floor(nowMs / 1000))[0];
        }
      }
    } catch {
      /* fall through: the caller can resolve it from the txid */
    }
    if (override) {
      const cur = cachedOverride(id, identityKey, nowMs);
      if (!cur || override.ts >= cur.ts) remember(id, identityKey, override, nowMs);
    }
    return { txid: r.txid, override };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
