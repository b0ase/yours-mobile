import { OP, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { applyAip, ONESAT_MAINNET_CONTENT_URL, type OneSatContext } from '@1sat/actions';
import {
  aipValid,
  isIdentityKey,
  isTokenId,
  ISSUER_KEY_ID,
  ISSUER_PROTOCOL,
  issuerSigningKey,
  MAP_PREFIX,
  normTokenId,
  parseSignedMap,
} from '../issuer/issuer';
import { REGISTRY, WOC_TX_HEX } from '../issuer/issuerVerify';
import type { Fetch } from '../names/names';

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
 * Valid only if the AIP signature checks, the signing address is the issuer-statement child key of
 * identity_key, and identity_key is the issuer recorded in the token's own deploy tx. Anything else
 * is ignored. The newest valid `ts` wins. Verification is local to the txs; no indexer is trusted
 * for validity, only for finding candidate txids.
 */
export const META_PROTOCOL = 'bsv-21-meta';
/** A `ts` this far ahead of the clock is ignored, so a typo cannot freeze the icon forever. */
export const MAX_TS_AHEAD_SECS = 24 * 3600;

const { toArray } = Utils;
const isOutpoint = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}_\d{1,6}$/i.test(s);

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

/**
 * Every valid override for `tokenId` in `tx` signed by `issuerKey` (the identity key recorded in the
 * token's deploy tx). Foreign signers, bad signatures, other tokens and malformed fields are skipped.
 */
export function overridesInTx(tx: Transaction, tokenId: string, issuerKey: string, nowSecs: number): IconOverride[] {
  const id = normTokenId(tokenId);
  const key = issuerKey.toLowerCase();
  const out: IconOverride[] = [];
  if (!isTokenId(id) || !isIdentityKey(key)) return out;
  const txid = tx.id('hex');
  for (const o of tx.outputs) {
    const p = parseSignedMap(o.lockingScript);
    if (!p) continue;
    const f = p.fields;
    if (f.p !== META_PROTOCOL || normTokenId(f.tokenId || '') !== id) continue;
    if ((f.identity_key || '').toLowerCase() !== key) continue;
    if (!isOutpoint(normTokenId(f.icon || ''))) continue;
    if (!/^\d{1,12}$/.test(f.ts || '')) continue;
    const ts = Number(f.ts);
    if (ts > nowSecs + MAX_TS_AHEAD_SECS) continue;
    if (!aipValid(p.message, p.signature, p.address)) continue;
    if (issuerSigningKey(key).toAddress() !== p.address) continue;
    out.push({ tokenId: id, icon: normTokenId(f.icon), ts, txid, identityKey: key });
  }
  return out;
}

/** The newest override (highest ts; equal ts → lowest txid, so every wallet picks the same one). */
export function newestOverride(list: IconOverride[]): IconOverride | null {
  let best: IconOverride | null = null;
  for (const o of list) if (!best || o.ts > best.ts || (o.ts === best.ts && o.txid < best.txid)) best = o;
  return best;
}

/** The URL to show for an override's icon outpoint. */
export const overrideIconUrl = (o: Pick<IconOverride, 'icon'> | null | undefined): string =>
  o ? `${ONESAT_MAINNET_CONTENT_URL}/${o.icon}` : '';

/** The icon to show: a valid override beats the deploy icon; with none, the deploy icon. */
export const pickIcon = (deployIcon: string, override: IconOverride | null): string =>
  override ? overrideIconUrl(override) : deployIcon;

const LS = 'bwallet.iconoverride.v1.';
const TTL = 3600_000;
const mem = new Map<string, { at: number; value: IconOverride | null }>();
const stored = new Set<string>();
const inflight = new Map<string, Promise<IconOverride | null>>();

export const cachedOverride = (tokenId: string, now = Date.now()): IconOverride | null | undefined => {
  const id = normTokenId(tokenId);
  let hit = mem.get(id);
  if (!hit) {
    try {
      const raw = globalThis.localStorage?.getItem(LS + id);
      if (raw) hit = JSON.parse(raw) as { at: number; value: IconOverride | null };
    } catch {
      /* storage blocked */
    }
  }
  if (!hit || now - hit.at > TTL) return undefined;
  mem.set(id, hit);
  return hit.value;
};

const remember = (tokenId: string, value: IconOverride | null, now: number) => {
  const id = normTokenId(tokenId);
  mem.set(id, { at: now, value });
  try {
    globalThis.localStorage?.setItem(LS + id, JSON.stringify({ at: now, value }));
    stored.add(id);
  } catch {
    /* storage blocked */
  }
};

export const clearOverrideCache = () => {
  mem.clear();
  try {
    for (const id of stored) globalThis.localStorage?.removeItem(LS + id);
    stored.clear();
  } catch {
    /* storage blocked */
  }
};

/** Candidate txids that mention the token, from bit-sign's index. Only a pointer: validity is checked locally. */
export async function listOverrideTxids(f: Fetch, tokenId: string): Promise<string[] | null> {
  try {
    const r = await f(`${REGISTRY}/${normTokenId(tokenId)}/icon`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return r.status === 404 ? [] : null;
    const j = (await r.json()) as { txids?: unknown };
    const ids = Array.isArray(j?.txids) ? j.txids : [];
    return ids.filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t)).slice(0, 50);
  } catch {
    return null;
  }
}

async function fetchTx(f: Fetch, txid: string): Promise<Transaction | null> {
  try {
    const r = await f(WOC_TX_HEX(txid), { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    return Transaction.fromHex((await r.text()).trim());
  } catch {
    return null;
  }
}

/**
 * The newest valid icon override for a token whose verified issuer is `issuerKey`, or null.
 * `extraTxids` are txs the wallet already knows about (its own just-published override).
 */
export async function resolveIconOverride(
  tokenId: string,
  issuerKey: string,
  f: Fetch = fetch,
  now = Date.now(),
  extraTxids: string[] = [],
): Promise<IconOverride | null> {
  const id = normTokenId(tokenId);
  const hit = cachedOverride(id, now);
  if (hit !== undefined && !extraTxids.length) return hit;
  const running = inflight.get(id);
  if (running && !extraTxids.length) return running;
  const p = (async () => {
    const listed = await listOverrideTxids(f, id);
    const txids = [...new Set([...extraTxids, ...(listed ?? [])])];
    const found: IconOverride[] = [];
    for (const t of txids) {
      const tx = await fetchTx(f, t);
      if (tx) found.push(...overridesInTx(tx, id, issuerKey, Math.floor(now / 1000)));
    }
    const value = newestOverride(found);
    // Nothing is cached when the lookup failed, so a network blip cannot hide an override for an hour.
    if (listed === null && !value) return null;
    remember(id, value, now);
    return value;
  })();
  inflight.set(id, p);
  try {
    return await p;
  } finally {
    inflight.delete(id);
  }
}

/**
 * Publish an override: sign with the issuer child key (same one as the mint statement) and put the
 * statement in its own 0-sat output. Returns the txid. The caller has already shown the approval sheet.
 */
export async function publishIconOverride(
  ctx: OneSatContext,
  tokenId: string,
  icon: string,
  nowMs = Date.now(),
): Promise<{ txid?: string; error?: string }> {
  try {
    const wallet = ctx.wallet as WalletInterface;
    const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
    const unsigned = iconOverrideScript({ tokenId, icon, ts: Math.floor(nowMs / 1000), identityKey });
    const signed = await applyAip(ctx, unsigned, ISSUER_PROTOCOL, ISSUER_KEY_ID, 'anyone');
    const r = await wallet.createAction({
      description: `New icon for token ${normTokenId(tokenId).slice(0, 8)}…`,
      outputs: [{ lockingScript: signed.toHex(), satoshis: 0, outputDescription: 'Token icon update (MAP + AIP)' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    return r.txid ? { txid: r.txid } : { error: 'The wallet did not return a transaction' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
