/**
 * History v2 (docs/HISTORY-V2-PLAN.md): what a tx *was* (token buy, NFT sale, game payment, pot payment…), on top
 * of txHistory.ts's direction and amounts. Pure, no network: unit-tested against real mainnet txs (fixtures/).
 *
 * Sources, strongest first:
 *  1. The tx itself: 1Sat inscription envelopes (BSV-20/BSV-21 JSON → token, anything else → NFT), OrdLock
 *     outputs (a listing), our own listings being spent (sale or cancel), 1-sat outputs moving in or out.
 *  2. The wallet's own action records (BRC-100 description + labels, e.g. "Purchase 204 tokens for … sats",
 *     "p bsv21 token <id>", "tokenblaster launch").
 *  3. The connections log (connectionLog.ts): which app asked for the payment (games, other apps).
 */
import { Utils } from '@bsv/sdk';
import type { HistoryRow, LocalInfo, RawTx } from './txHistory';

export type Category = 'payment' | 'token' | 'nft' | 'game' | 'subscription' | 'app' | 'social';

/** What happened, in words a statement can use. */
export type EventType =
  | 'receive'
  | 'send'
  | 'self'
  | 'buy'
  | 'sell'
  | 'list'
  | 'cancel'
  | 'transfer-in'
  | 'transfer-out'
  | 'mint'
  | 'payment';

export type Asset = {
  kind: 'token' | 'nft';
  /** BSV-21 token id (txid_vout), BSV-20 tick, or for an NFT its outpoint here (origin needs an indexer). */
  id: string;
  symbol?: string;
  /** Raw token amount as inscribed (no decimals applied) for tokens; 1 for an NFT. */
  qty?: string;
};

export const CATEGORIES: { id: Category | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'payment', label: 'Payments' },
  { id: 'token', label: 'Tokens' },
  { id: 'nft', label: 'NFTs' },
  { id: 'game', label: 'Games' },
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'app', label: 'Apps' },
  { id: 'social', label: 'Social' },
];

// ─── Script parsing ──────────────────────────────────────────────────────────

/** OrdLock contract prefix (js-1sat-ord / @1sat/templates ORDLOCK_PREFIX), first 40 bytes is plenty. */
export const ORDLOCK_HEX = '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff026';
/** OP_FALSE OP_IF "ord" */
const ORD_ENVELOPE = '0063036f7264';

type Push = { op: number; data: string };

/** Read one push at hex offset i. */
const readPush = (hex: string, i: number): { push: Push; next: number } | null => {
  if (i + 2 > hex.length) return null;
  const op = parseInt(hex.slice(i, i + 2), 16);
  let len = 0;
  let at = i + 2;
  if (op >= 1 && op <= 75) len = op;
  else if (op === 0x4c) {
    len = parseInt(hex.slice(at, at + 2), 16);
    at += 2;
  } else if (op === 0x4d) {
    const b = hex.slice(at, at + 4);
    len = parseInt(b.slice(2, 4) + b.slice(0, 2), 16);
    at += 4;
  } else if (op === 0x4e) {
    const b = hex.slice(at, at + 8);
    len = parseInt(b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2), 16);
    at += 8;
  } else return { push: { op, data: '' }, next: at };
  return { push: { op, data: hex.slice(at, at + len * 2) }, next: at + len * 2 };
};

const hexToUtf8 = (h: string) => {
  try {
    return new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16))));
  } catch {
    return '';
  }
};

export type Inscription = { contentType: string; text?: string; truncated: boolean };

/** The 1Sat inscription in a locking script, if any. `text` only for text/json types that fit in the kept hex. */
export const parseInscription = (scriptHex: string | undefined): Inscription | null => {
  const s = (scriptHex ?? '').toLowerCase();
  const at = s.indexOf(ORD_ENVELOPE);
  if (at < 0) return null;
  let i = at + ORD_ENVELOPE.length;
  let contentType = '';
  let content: string | undefined;
  let truncated = false;
  for (let guard = 0; guard < 40 && i < s.length; guard++) {
    if (s.slice(i, i + 2) === '68') break; // OP_ENDIF
    const field = readPush(s, i);
    if (!field) break;
    // Fields are pairs: OP_1 (51) content type, OP_0 (00) content; skip others.
    const value = readPush(s, field.next);
    if (!value) {
      truncated = true;
      break;
    }
    const tag = field.push.op === 0x51 ? 1 : field.push.op === 0 ? 0 : field.push.data === '01' ? 1 : -1;
    if (value.next > s.length) truncated = true;
    if (tag === 1) contentType = hexToUtf8(value.push.data);
    else if (tag === 0) content = value.push.data;
    i = value.next;
  }
  const textual = /^(text\/|application\/(json|bsv-20))/.test(contentType);
  return { contentType, text: textual && content !== undefined && !truncated ? hexToUtf8(content) : undefined, truncated };
};

export type Bsv20 = { op: string; id?: string; tick?: string; amt?: string; sym?: string };

/** BSV-20 / BSV-21 JSON from an inscription. */
export const parseBsv20 = (ins: Inscription | null): Bsv20 | null => {
  if (!ins || ins.contentType !== 'application/bsv-20' || !ins.text) return null;
  try {
    const j = JSON.parse(ins.text) as Record<string, unknown>;
    if (j.p !== 'bsv-20' || typeof j.op !== 'string') return null;
    const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
    return { op: j.op, id: str(j.id), tick: str(j.tick), amt: str(j.amt), sym: str(j.sym) };
  } catch {
    return null;
  }
};

export const isOrdLock = (scriptHex: string | undefined) => (scriptHex ?? '').toLowerCase().includes(ORDLOCK_HEX);

/**
 * The P2PKH address at the end of a script that WhatsOnChain does not decode (an inscription wrapped round a
 * P2PKH lock: the usual 1Sat ordinal / token output). Mainnet only.
 */
export const trailingP2pkh = (scriptHex: string | undefined): string | null => {
  const s = (scriptHex ?? '').toLowerCase();
  const m = s.match(/76a914([0-9a-f]{40})88ac$/) ?? (s.startsWith('76a914') ? s.match(/^76a914([0-9a-f]{40})88ac/) : null);
  if (!m) return null;
  return Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
};

// ─── Classification ──────────────────────────────────────────────────────────

/** Extra context the classifier can use. */
export type EventContext = {
  own: Set<string>;
  /** Own outputs by `txid:vout` (txHistory.ownOutputs). */
  prev: Map<string, { sats: number; address: string }>;
  /** OrdLock outputs this account created (`txid:vout` → what was listed). */
  listings: Map<string, { asset: Asset; priceSats?: number }>;
  /** txid → app that asked for it (connection log). */
  appByTxid?: Map<string, { app: string; game?: boolean }>;
  /** Token id → symbol (from an indexer, best effort). */
  symbols?: Map<string, string>;
  /** Account kind: pot or agent account (agents/agentAccounts.ts). */
  accountKind?: string;
};

export type ClassifiedRow = HistoryRow & { category: Category; type: EventType; asset?: Asset; app?: string };

const assetOf = (b: Bsv20, outpoint: string, symbols?: Map<string, string>): Asset => {
  const id = b.id ?? b.tick ?? outpoint;
  return { kind: 'token', id, symbol: symbols?.get(id) ?? b.sym ?? b.tick, qty: b.amt };
};

/**
 * The input outpoint whose first satoshi lands at the start of output `n` (1Sat ordinal theory: sats keep their
 * order from inputs to outputs). Only when every earlier input's value is known (our own coins); else null.
 */
export const sourceOutpoint = (t: RawTx, n: number, prev: Map<string, { sats: number }>): string | null => {
  let offset = 0;
  for (const o of t.vout) {
    if (o.n === n) break;
    offset += o.sats;
  }
  let at = 0;
  for (const i of t.vin) {
    const p = i.txid !== undefined ? prev.get(`${i.txid}:${i.vout}`) : undefined;
    if (!p) return null;
    if (offset < at + p.sats) return `${i.txid}_${i.vout}`;
    at += p.sats;
  }
  return null;
};

/**
 * OrdLock listings created by this account (we funded the tx, so it is ours), with what they hold. An NFT keeps
 * the id of the outpoint it was listed from (where we got it), so a sale matches its purchase in the tax report.
 */
export const findListings = (txs: RawTx[], prev: Map<string, { sats: number; address: string }>) => {
  const m = new Map<string, { asset: Asset }>();
  for (const t of txs) {
    const funded = t.vin.some((i) => i.txid !== undefined && prev.has(`${i.txid}:${i.vout}`));
    if (!funded) continue;
    for (const o of t.vout) {
      if (!isOrdLock(o.script)) continue;
      const b = parseBsv20(parseInscription(o.script));
      const op = `${t.txid}_${o.n}`;
      const src = b ? null : sourceOutpoint(t, o.n, prev);
      m.set(`${t.txid}:${o.n}`, { asset: b ? assetOf(b, op) : { kind: 'nft', id: src ?? op, qty: '1' } });
    }
  }
  return m;
};

/**
 * App labels on a payment (the convention for apps: a createAction description, or a label, starting
 * `game:` or `app:`, e.g. "game: round 12 won"). Returns what to show and whether the app says it's a game.
 */
export const appLabelOf = (local: LocalInfo | undefined): { game: boolean; text: string } | null => {
  for (const t of [local?.description ?? '', ...(local?.labels ?? [])]) {
    const m = t.match(/^\s*(game|app)\s*:\s*(.{1,120})/i);
    if (m) return { game: m[1].toLowerCase() === 'game', text: m[2].trim() };
  }
  return null;
};

const ownAddr = (o: RawTx['vout'][number], own: Set<string>) =>
  o.addresses.some((a) => own.has(a)) || (!!o.script && own.has(trailingP2pkh(o.script) ?? ''));

/** Local record text → event (wallet action descriptions from @1sat/actions and our own code). */
const fromLocal = (local: LocalInfo | undefined): { type: EventType; kind?: 'token' | 'nft'; qty?: string; id?: string } | null => {
  if (!local) return null;
  const d = local.description ?? '';
  const labels = local.labels ?? [];
  const tokenLabel = labels.map((l) => l.match(/^(?:p bsv21 token |bsv21 |bsv20 )(\S+)/)?.[1]).find(Boolean);
  let m: RegExpMatchArray | null;
  if ((m = d.match(/^Purchase (\d+) tokens? for/i))) return { type: 'buy', kind: 'token', qty: m[1], id: tokenLabel };
  if (/^(Purchase ordinal|Fund OrdLock purchase)/i.test(d)) return { type: 'buy', kind: 'nft' };
  if (/^List (ordinal|OpNS)/i.test(d)) return { type: 'list', kind: tokenLabel ? 'token' : 'nft', id: tokenLabel };
  if (/^Cancel .*listing/i.test(d)) return { type: 'cancel', kind: tokenLabel ? 'token' : 'nft', id: tokenLabel };
  if (/^Transfer \d+ ordinal/i.test(d)) return { type: 'transfer-out', kind: 'nft' };
  if (/^Send \S+ to \d+ recipient/i.test(d)) return { type: 'transfer-out', kind: 'token', id: tokenLabel };
  if (/^Deploy /i.test(d) || labels.includes('launch')) return { type: 'mint', kind: 'token', id: tokenLabel };
  if (/^Recovered .* tokens/i.test(d)) return { type: 'buy', kind: 'token', id: tokenLabel };
  if (tokenLabel) return { type: 'transfer-out', kind: 'token', id: tokenLabel };
  return null;
};

/** Add category / type / asset / app to a row (txHistory.classify did direction and amounts). */
export const classifyEvent = (row: HistoryRow, tx: RawTx | undefined, local: LocalInfo | undefined, ctx: EventContext): ClassifiedRow => {
  const app = ctx.appByTxid?.get(row.txid);
  const appLabel = appLabelOf(local);
  const base = (category: Category, type: EventType, asset?: Asset): ClassifiedRow => ({
    ...row,
    category,
    type,
    asset,
    app: app?.app,
    ...(appLabel ? { appNote: appLabel.text } : {}),
  });
  const plainType: EventType = row.direction === 'in' ? 'receive' : row.direction === 'out' ? 'send' : 'self';

  if (tx) {
    // Our own listing being spent: a sale (the asset left, we were paid) or a cancel (it came back).
    const listingIn = tx.vin.map((i) => ctx.listings.get(`${i.txid}:${i.vout}`)).find(Boolean);
    if (listingIn) {
      const back = tx.vout.some((o) => o.sats === 1 && ownAddr(o, ctx.own));
      const asset = { ...listingIn.asset, symbol: ctx.symbols?.get(listingIn.asset.id) ?? listingIn.asset.symbol };
      return { ...base(asset.kind, back ? 'cancel' : 'sell', asset), label: `${asset.kind === 'nft' ? 'NFT' : 'token'} ${back ? 'listing cancelled' : 'sold'}` };
    }
    const funded = tx.vin.some((i) => ctx.prev.has(`${i.txid}:${i.vout}`));
    const lockOut = tx.vout.find((o) => isOrdLock(o.script));
    if (funded && lockOut) {
      const b = parseBsv20(parseInscription(lockOut.script));
      const asset: Asset = b ? assetOf(b, `${tx.txid}_${lockOut.n}`, ctx.symbols) : { kind: 'nft', id: `${tx.txid}_${lockOut.n}`, qty: '1' };
      return { ...base(asset.kind, 'list', asset), label: `${asset.kind === 'nft' ? 'NFT' : 'token'} listed` };
    }
    const ownOne = tx.vout.find((o) => o.sats === 1 && ownAddr(o, ctx.own));
    const extOne = tx.vout.find((o) => o.sats === 1 && !ownAddr(o, ctx.own) && !isOrdLock(o.script));
    const vin0Own = tx.vin[0]?.txid !== undefined && ctx.prev.has(`${tx.vin[0].txid}:${tx.vin[0].vout}`);
    // A 1Sat market purchase: input 0 is someone else's OrdLock, we pay for it and get the 1-sat output.
    if (funded && ownOne && !vin0Own && row.direction === 'out') {
      const b = parseBsv20(parseInscription(ownOne.script));
      const asset: Asset = b
        ? assetOf(b, `${tx.txid}_${ownOne.n}`, ctx.symbols)
        : { kind: 'nft', id: `${tx.txid}_${ownOne.n}`, qty: '1' };
      return { ...base(asset.kind, 'buy', asset), label: `${asset.kind === 'nft' ? 'NFT' : 'token'} bought` };
    }
    const spentOne = tx.vin.some((i) => ctx.prev.get(`${i.txid}:${i.vout}`)?.sats === 1);
    if (spentOne && extOne) {
      const b = parseBsv20(parseInscription(extOne.script));
      const asset: Asset = b ? assetOf(b, `${tx.txid}_${extOne.n}`, ctx.symbols) : { kind: 'nft', id: `${tx.txid}_${extOne.n}`, qty: '1' };
      return { ...base(asset.kind, 'transfer-out', asset), label: `${asset.kind === 'nft' ? 'NFT' : 'token'} sent` };
    }
    if (ownOne && !funded) {
      const b = parseBsv20(parseInscription(ownOne.script));
      const asset: Asset = b ? assetOf(b, `${tx.txid}_${ownOne.n}`, ctx.symbols) : { kind: 'nft', id: `${tx.txid}_${ownOne.n}`, qty: '1' };
      return { ...base(asset.kind, 'transfer-in', asset), label: `${asset.kind === 'nft' ? 'NFT' : 'token'} received` };
    }
    if (ownOne && funded) {
      const b = parseBsv20(parseInscription(ownOne.script));
      if (b && /deploy|mint/.test(b.op)) {
        const asset = assetOf(b, `${tx.txid}_${ownOne.n}`, ctx.symbols);
        return { ...base('token', 'mint', asset.id.includes('_') ? asset : { ...asset, id: `${tx.txid}_${ownOne.n}` }), label: 'token minted' };
      }
    }
  }

  const loc = fromLocal(local);
  if (loc?.kind) {
    const asset: Asset | undefined = loc.id || loc.qty ? { kind: loc.kind, id: loc.id ?? '', qty: loc.qty, symbol: loc.id ? ctx.symbols?.get(loc.id) : undefined } : undefined;
    return base(loc.kind, loc.type, asset);
  }

  if (app?.game || appLabel?.game) return { ...base('game', 'payment'), label: row.direction === 'in' ? 'game winnings' : 'game payment' };
  if (row.label === 'pot payment' || ctx.accountKind === 'pot') return base('subscription', row.direction === 'out' ? 'payment' : plainType);
  if (row.label === 'agent spend') return base('app', 'payment');
  if (app || appLabel) return { ...base('app', row.direction === 'out' ? 'payment' : plainType), label: row.label === 'send' ? 'app payment' : row.label };
  if (['tip', 'like', 'lock', 'seal'].includes(row.label)) return base('social', plainType);
  if (row.label === 'NFT') return base('nft', plainType);
  if (row.label === 'token transfer') return base('token', plainType);
  if (row.label === 'market') return base('nft', plainType);
  return base('payment', plainType);
};

export const filterCategory = <R extends { category: Category }>(rows: R[], c: Category | 'all') =>
  c === 'all' ? rows : rows.filter((r) => r.category === c);

/** Short text for an asset: "204 $NINJAPUNKGIRLS", "NFT 04caf4…_8". */
export const assetText = (a: Asset | undefined) => {
  if (!a) return '';
  if (a.kind === 'nft') return `NFT ${a.id.length > 20 ? `${a.id.slice(0, 8)}…${a.id.slice(-4)}` : a.id}`;
  const name = a.symbol ? (a.symbol.startsWith('$') ? a.symbol : `$${a.symbol}`) : a.id ? `${a.id.slice(0, 8)}…` : 'tokens';
  return `${a.qty ?? ''} ${name}`.trim();
};
