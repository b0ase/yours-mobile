/**
 * Signed (☰ › Signed, /m/signed): every document this wallet is a party to. Owner, 23 Nov 2026: "nowhere in the
 * wallet app is there an obvious documents vault for documents signed by the user… show them what they've signed".
 *
 * Two sources, merged here (PURE: signed.test.ts):
 *   - LOCAL: the wallet's own record of every seal it recorded (signed/localStore.ts, written by signed/recorder.ts
 *     from nativeSeal's setSealRecordedHook). It needs no server and is never dropped because the server forgot.
 *   - SERVER: bit-sign GET /api/bitsign/signatures (the caller's own rows plus the rooms' documents), classified the way
 *     bit-sign's vault classifies them (bit-sign src/lib/vault-status.ts, ported in part below: latest generation,
 *     blocks bound to my handles, one document one row, drafts and tests left out). It fills in titles, rooms and
 *     status, and supplies what is waiting for me.
 *
 * Tabs: Waiting for me (one of my blocks is unsigned) · Signed (my blocks signed, not on chain yet) · Sealed (a real
 * 64-hex seal txid).
 */

export type SignedTab = 'waiting' | 'signed' | 'sealed';
export const TABS: { id: SignedTab; label: string }[] = [
  { id: 'waiting', label: 'Waiting for me' },
  { id: 'signed', label: 'Signed' },
  { id: 'sealed', label: 'Sealed' },
];

/** One bit-sign vault row, as GET /api/bitsign/signatures returns it (no document body). */
export interface ServerRow {
  id: string;
  signature_type: string;
  created_at?: string | null;
  txid?: string | null;
  seal_txid?: string | null;
  payload_hash?: string | null;
  /** The owner's handle, or a room's ticker for documents a room drafted. */
  user_handle?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** What the wallet keeps about one seal it recorded (signed/localStore.ts). */
export interface LocalSigned {
  /** bit-sign's row for the sealed copy: the pointer to open it (signatures/<id>/preview). */
  signatureId: string;
  /** The room document that was signed. */
  documentId: string;
  docHash: string;
  sealTxid: string;
  room: string;
  title: string;
  /** ms */
  at: number;
  complete?: boolean;
}

export interface SignedRow {
  /** signatureId, else the doc hash, else the document id. */
  key: string;
  /** The row to open (the sealed copy for a seal; the document itself when waiting). */
  signatureId: string;
  /** The room document (for the Sign page). */
  documentId: string;
  title: string;
  /** Room ticker without "$"; '' when unknown. */
  room: string;
  at: number;
  /** Full sha256 hex of the document, lower case; '' when unknown. */
  docHash: string;
  /** A real 64-hex txid, or null. */
  sealTxid: string | null;
  status: SignedTab;
  /** Where the row came from: shown nowhere, used by tests and the merge. */
  source: 'local' | 'server' | 'both';
}

const TXID = /^[0-9a-f]{64}$/i;
/** A real transaction id (bit-sign's `pending-…` placeholder is not one). */
export const isTxid = (t: unknown): t is string => typeof t === 'string' && TXID.test(t.trim());
/** WhatsOnChain for a seal, built ONLY from a valid 64-hex txid (anything else → null, never a link). */
export const wocTxUrl = (txid: unknown): string | null =>
  isTxid(txid) ? `https://whatsonchain.com/tx/${txid.trim().toLowerCase()}` : null;
/** The first 8 of a sha256 hex ('' when it isn't one). */
export const shortHash = (h: unknown): string =>
  typeof h === 'string' && /^[0-9a-f]{8,}$/i.test(h.trim()) ? h.trim().slice(0, 8).toLowerCase() : '';
const hash64 = (h: unknown): string => (typeof h === 'string' && TXID.test(h.trim()) ? h.trim().toLowerCase() : '');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const normHandle = (h: unknown): string =>
  typeof h === 'string'
    ? h
        .trim()
        .replace(/^[$@]+/, '')
        .toLowerCase()
    : '';
const cleanRoom = (t: unknown): string => (str(t) ?? '').replace(/^\$/, '').toUpperCase();
const ms = (iso: unknown): number => {
  const n = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

// ── bit-sign vault-status, the parts Signed needs ────────────────────────────────────────────────────────────────

function manifestOf(meta: Record<string, unknown>): Record<string, unknown> | null {
  let man: unknown = meta.ndsManifest;
  if (typeof man === 'string') {
    try {
      man = JSON.parse(man);
    } catch {
      man = null;
    }
  }
  return man && typeof man === 'object' && !Array.isArray(man) ? (man as Record<string, unknown>) : null;
}

type Field = { id: string; handle: string; signed?: boolean };
/** Handle-bound, required blocks (witness blocks and optional ones never wait). */
function rosterOf(meta: Record<string, unknown>): Field[] | null {
  const man = manifestOf(meta);
  if (man && Array.isArray(man.signatureFields)) {
    return (man.signatureFields as Array<Record<string, unknown>>)
      .filter((f) => f && typeof f === 'object' && f.required !== false)
      .map((f) => ({ id: String(f.id ?? ''), handle: normHandle(f.signerHandle) }))
      .filter((f) => f.handle);
  }
  const env = str(meta.envelopeId) ?? str(meta.envelope_id) ?? str(meta.signingEnvelopeId);
  if (env && Array.isArray(meta.signers)) {
    return (meta.signers as Array<Record<string, unknown>>)
      .map((s, i) => ({
        id: `signer-${i}`,
        handle: normHandle(s?.handle),
        signed: String(s?.status ?? '').toLowerCase() === 'signed',
      }))
      .filter((f) => f.handle);
  }
  return null;
}

const titleOf = (meta: Record<string, unknown>): string | null =>
  str(manifestOf(meta)?.documentTitle) ?? str(meta.documentTitle) ?? str(meta.title);
const fileNameOf = (meta: Record<string, unknown>): string | null => str(meta.originalFileName) ?? str(meta.fileName);
const refOf = (meta: Record<string, unknown>): string | null =>
  str(meta.documentRef) ?? str(meta.reference) ?? str(manifestOf(meta)?.documentRef);

/** bit-sign practice-marker.ts: PRACTICE / TEST / DRAFT written as a label, never as an ordinary word. */
const EXT = /\.(?:html?|pdf|md|markdown|txt|docx?|json)$/i;
const TAIL = /(?:\s*[—–-]\s*|_)(?:sealed|part-signed|signed(?:\s+by\s+[^—–]*)?)\s*$/i;
const MARK = 'draft|practice|test';
const BRACKET = new RegExp(`[(\\[]\\s*(?:${MARK})\\s*[)\\]]`, 'i');
const CAPS = new RegExp(`(?:^|[^A-Za-z0-9])(?:${MARK.toUpperCase()})(?=$|[^A-Za-z0-9])`);
const FIRST = new RegExp(`^(?:${MARK})(?=$|[^a-z0-9])`, 'i');
const LAST = new RegExp(`[—–\\-_:|/]\\s*(?:${MARK})\\s*[.!]?$`, 'i');
export const marksItselfDraft = (text: string | null | undefined): boolean => {
  if (typeof text !== 'string') return false;
  const t = text.normalize('NFKC').trim();
  if (!t) return false;
  if (BRACKET.test(t)) return true;
  const shouted = /\s/.test(t) && !/[a-z]/.test(t);
  if (!shouted && CAPS.test(t)) return true;
  if (FIRST.test(t)) return true;
  let core = t.replace(EXT, '');
  for (let i = 0; i < 4; i++) {
    const next = core.replace(TAIL, '').trim();
    if (next === core) break;
    core = next;
  }
  return LAST.test(core);
};

const ROOM_TICKER = /^[A-Z0-9][A-Z0-9&._-]{1,31}$/;
const DRAFTS_ROOM = 'DRAFTS';
function ownRoom(row: ServerRow, mine: ReadonlySet<string>): string | null {
  const meta = row.metadata || {};
  const t = str(meta.roomTicker) ?? str(meta.from_room);
  if (t) return cleanRoom(t);
  const uh = str(row.user_handle);
  return uh && ROOM_TICKER.test(uh) && !mine.has(normHandle(uh)) ? uh : null;
}
function originRoom(row: ServerRow, mine: ReadonlySet<string>, byId: ReadonlyMap<string, ServerRow>): string | null {
  let cur: ServerRow | undefined = row;
  for (let hop = 0; cur && hop < 12; hop++) {
    const r = ownRoom(cur, mine);
    if (r) return r;
    const up = str(cur.metadata?.originalDocumentId);
    cur = up ? byId.get(up) : undefined;
  }
  return null;
}

type Blocks = { isContract: boolean; mineBound: boolean; needsMine: boolean };
function blocksOf(row: ServerRow, mine: ReadonlySet<string>): Blocks {
  const none: Blocks = { isContract: false, mineBound: false, needsMine: false };
  const meta = row.metadata || {};
  const fields = rosterOf(meta);
  if (!fields || !fields.length) return none;
  const sealed = row.signature_type === 'SEALED_DOCUMENT';
  let signed: Set<string>;
  if (meta.ndsComplete === true) signed = new Set(fields.map((f) => f.id));
  else if (Array.isArray(meta.ndsSignedFieldsAll) || Array.isArray(meta.ndsSignedFields)) {
    signed = new Set(((meta.ndsSignedFieldsAll ?? meta.ndsSignedFields) as unknown[]).map((x) => String(x ?? '')));
  } else if (fields.some((f) => f.signed !== undefined)) {
    signed = new Set(fields.filter((f) => f.signed).map((f) => f.id));
  } else if (sealed) {
    signed = new Set(fields.map((f) => f.id));
  } else if (meta.partiallySigned === true && (!str(row.user_handle) || mine.has(normHandle(row.user_handle)))) {
    signed = new Set(fields.filter((f) => mine.has(f.handle)).map((f) => f.id));
  } else {
    signed = new Set();
  }
  const mineBound = fields.some((f) => mine.has(f.handle));
  const needsMine = fields.some((f) => mine.has(f.handle) && !signed.has(f.id));
  return { isContract: true, mineBound, needsMine };
}

const RANK: Record<SignedTab, number> = { waiting: 1, signed: 2, sealed: 3 };

/**
 * bit-sign's vault rows → Signed rows: the latest generation of each document that I am a party to (a block bound to
 * one of my handles, or a signed record in my own vault), one row per document (room + reference + title: the most advanced
 * copy wins, then the newest). Files, drawn signatures, archived rows and drafts / tests are left out.
 */
export function classifyServerRows(rows: readonly ServerRow[], myHandles: Iterable<string>): SignedRow[] {
  const mine = new Set([...myHandles].map(normHandle).filter(Boolean));
  const docs = rows.filter(
    (r) =>
      r &&
      typeof r.id === 'string' &&
      (r.signature_type === 'DOCUMENT' || r.signature_type === 'SEALED_DOCUMENT') &&
      !r.metadata?.archived_at,
  );
  const byId = new Map(docs.map((r) => [r.id, r]));
  const superseded = new Set(docs.map((r) => str(r.metadata?.originalDocumentId)).filter((x): x is string => !!x));
  const out: (SignedRow & { group: string })[] = [];
  for (const r of docs) {
    if (superseded.has(r.id)) continue;
    const meta = r.metadata || {};
    const title = titleOf(meta);
    const fileName = fileNameOf(meta);
    const ref = refOf(meta);
    if ([title, ref, fileName].some(marksItselfDraft)) continue;
    const room = originRoom(r, mine, byId) ?? '';
    if (room === DRAFTS_ROOM) continue;
    const b = blocksOf(r, mine);
    const sealed = r.signature_type === 'SEALED_DOCUMENT';
    const ownRow = !!str(r.user_handle) && mine.has(normHandle(r.user_handle));
    // A party: one of my handles has a block, or it is a signed record in my own vault. Not a file.
    if (!b.mineBound && !(ownRow && (sealed || b.isContract))) continue;
    const seal = [r.seal_txid, r.txid].find(isTxid) ?? null;
    const status: SignedTab = b.needsMine ? 'waiting' : seal ? 'sealed' : 'signed';
    out.push({
      key: r.id,
      signatureId: r.id,
      documentId: str(meta.originalDocumentId) ?? r.id,
      title: title ?? (fileName ? fileName.replace(EXT, '') : ''),
      room,
      at: ms(r.created_at),
      docHash: hash64(r.payload_hash),
      sealTxid: seal ? seal.trim().toLowerCase() : null,
      status,
      source: 'server',
      group: `${room}|${ref ?? ''}|${(title ?? fileName ?? r.id).toLowerCase()}`,
    });
  }
  const best = new Map<string, SignedRow & { group: string }>();
  for (const r of out) {
    const cur = best.get(r.group);
    if (!cur || RANK[r.status] > RANK[cur.status] || (RANK[r.status] === RANK[cur.status] && r.at > cur.at))
      best.set(r.group, r);
  }
  return [...best.values()].map(({ group: _g, ...r }) => r);
}

const fromLocal = (l: LocalSigned): SignedRow => {
  const seal = isTxid(l.sealTxid) ? l.sealTxid.trim().toLowerCase() : null;
  return {
    key: l.signatureId || hash64(l.docHash) || l.documentId,
    signatureId: l.signatureId,
    documentId: l.documentId,
    title: l.title,
    room: cleanRoom(l.room),
    at: l.at,
    docHash: hash64(l.docHash),
    sealTxid: seal,
    status: seal ? 'sealed' : 'signed',
    source: 'local',
  };
};

/**
 * Local and server rows → one list, newest first. A local row and a server row are the same when their signature id
 * or their doc hash match: the server fills in what the local row lacks (title, room) and a real seal txid from
 * either side makes it Sealed. A local row with no server match stays (the server is down, or forgot it). A server
 * row still "waiting" on a document this wallet has sealed since is dropped (the seal superseded it).
 */
export function mergeRows(local: readonly LocalSigned[], server: readonly SignedRow[]): SignedRow[] {
  const merged: SignedRow[] = [];
  const used = new Set<SignedRow>();
  const sealedDocs = new Set(local.map((l) => l.documentId).filter(Boolean));
  for (const l of local) {
    const mine = fromLocal(l);
    const s = server.find(
      (r) =>
        !used.has(r) &&
        ((!!mine.signatureId && r.signatureId === mine.signatureId) || (!!mine.docHash && r.docHash === mine.docHash)),
    );
    if (!s) {
      merged.push(mine);
      continue;
    }
    used.add(s);
    const seal = mine.sealTxid ?? s.sealTxid;
    merged.push({
      ...s,
      key: s.signatureId || mine.key,
      documentId: mine.documentId || s.documentId,
      title: s.title || mine.title,
      room: s.room || mine.room,
      at: mine.at || s.at,
      docHash: s.docHash || mine.docHash,
      sealTxid: seal,
      status: seal ? 'sealed' : s.status === 'waiting' ? 'signed' : s.status,
      source: 'both',
    });
  }
  for (const s of server) {
    if (used.has(s)) continue;
    if (s.status === 'waiting' && (sealedDocs.has(s.documentId) || sealedDocs.has(s.signatureId))) continue;
    merged.push(s);
  }
  // One row per key (two local records of one seal, e.g. a recovery after a fresh record).
  const seen = new Set<string>();
  return merged.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).sort((a, b) => b.at - a.at);
}

export const rowsIn = (rows: readonly SignedRow[], tab: SignedTab): SignedRow[] => rows.filter((r) => r.status === tab);

/** The menu badge: documents waiting for my signature, plus seals held on this device (each needs a tap). */
export const badgeCount = (rows: readonly SignedRow[], heldCount: number): number =>
  rows.filter((r) => r.status === 'waiting').length + Math.max(0, heldCount);

/** The title a row shows: its own, else a plain name from its hash or id. */
export const rowTitle = (r: Pick<SignedRow, 'title' | 'docHash' | 'documentId' | 'signatureId'>): string =>
  r.title || `Document ${shortHash(r.docHash) || (r.documentId || r.signatureId).slice(0, 8)}`;
