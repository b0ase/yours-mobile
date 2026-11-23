/**
 * Signed (☰ › Signed, /m/signed): every document this wallet is a party to. Owner, 23 Nov 2026: "nowhere in the
 * wallet app is there an obvious documents vault for documents signed by the user… show them what they've signed".
 *
 * Two sources, merged here (PURE: signed.test.ts, vaultStatus.selftest.test.ts):
 *   - LOCAL: the wallet's own record of every seal it recorded (signed/localStore.ts, written by signed/recorder.ts
 *     from nativeSeal's setSealRecordedHook). It needs no server and is never dropped because the server forgot.
 *   - SERVER: bit-sign GET /api/bitsign/signatures (the caller's own rows plus the rooms' documents), classified EXACTLY
 *     as bit-sign's vault classifies them (bit-sign src/lib/vault-status.ts, ported below as vaultBuckets; the selftest
 *     mirrors bit-sign's vault-status-selftest.mts so a drift shows up as a failing test).
 *
 * bit-sign's piles → Signed's tabs:
 *   to_sign (one of my blocks is unsigned)            → Waiting for me
 *   waiting (mine are done, others are not)           → Signed, "Waiting for $bailey"
 *   signed_offchain (done, no real txid)              → Signed
 *   signed (done, real txid)                          → Sealed ONLY for a SEALED_DOCUMENT row or a real seal_txid;
 *                                                       a plain DOCUMENT with an inscription txid stays Signed
 *   files, drafts & tests, other, earlier copies, review copies I needn't sign → not listed
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
  /** false: my blocks are sealed, another party's are not (Waiting for others). */
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
  /** A real 64-hex txid, or null. Shown as the seal link only on a Sealed row. */
  sealTxid: string | null;
  status: SignedTab;
  /** Signed rows: mine are done, another party's are not. `waitingOn` names them when known. */
  others?: boolean;
  waitingOn?: string[];
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

/** Stored and shown sizes (review of #561, M5). */
export const TITLE_MAX = 200;
export const ROOM_MAX = 32;
export const ID_MAX = 128;
export const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const normHandle = (h: unknown): string =>
  typeof h === 'string'
    ? h
        .trim()
        .replace(/^[$@]+/, '')
        .toLowerCase()
    : '';
const cleanRoom = (t: unknown): string => clip((str(t) ?? '').replace(/^\$/, '').toUpperCase(), ROOM_MAX);
const ms = (iso: unknown): number => {
  const n = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

// ── bit-sign src/lib/vault-status.ts (+ practice-marker.ts, vault-layout.ts helpers), ported ─────────────────────

export type VaultBucket = 'to_sign' | 'waiting' | 'signed_offchain' | 'signed' | 'files' | 'drafts' | 'other';
export interface VaultStatus {
  bucket: VaultBucket;
  reviewCopy: boolean;
  earlierCopy: boolean;
  isContract: boolean;
  ref: string | null;
  title: string | null;
  fileName: string | null;
  room: string | null;
  waitingOn: string[];
  needsMine: boolean;
  /** One of my handles has a block on this copy (signed or not). */
  mineBound: boolean;
}

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
  str(manifestOf(meta)?.documentTitle) ?? str(meta.documentTitle);
const fileNameOf = (meta: Record<string, unknown>): string | null => str(meta.originalFileName) ?? str(meta.fileName);
const refOf = (meta: Record<string, unknown>): string | null =>
  str(meta.documentRef) ?? str(meta.reference) ?? str(manifestOf(meta)?.documentRef);

/** practice-marker.ts: PRACTICE / TEST / DRAFT written as a label, never as an ordinary word. */
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
export const isDraftOrTest = (...texts: ReadonlyArray<string | null | undefined>): boolean =>
  texts.some(marksItselfDraft);

const ROOM_TICKER = /^[A-Z0-9][A-Z0-9&._-]{1,31}$/;
const DRAFTS_ROOM = 'DRAFTS';
function ownRoom(row: ServerRow, mine: ReadonlySet<string>): string | null {
  const meta = row.metadata || {};
  const t = str(meta.roomTicker) ?? str(meta.from_room);
  if (t) return t.replace(/^\$/, '').toUpperCase();
  const uh = str(row.user_handle);
  return uh && ROOM_TICKER.test(uh) && !mine.has(normHandle(uh)) ? uh : null;
}
function originRoom(row: ServerRow, mine: ReadonlySet<string>, byId?: ReadonlyMap<string, ServerRow>): string | null {
  let cur: ServerRow | undefined = row;
  for (let hop = 0; cur && hop < 12; hop++) {
    const r = ownRoom(cur, mine);
    if (r) return r;
    const up = str(cur.metadata?.originalDocumentId);
    cur = up && byId ? byId.get(up) : undefined;
  }
  return null;
}

type Blocks = { isContract: boolean; needsMine: boolean; waitingOn: string[]; mineBound: boolean };
function blocksOf(row: ServerRow, mine: ReadonlySet<string>): Blocks {
  const none: Blocks = { isContract: false, needsMine: false, waitingOn: [], mineBound: false };
  const type = row.signature_type;
  if (type !== 'DOCUMENT' && type !== 'SEALED_DOCUMENT') return none;
  const meta = row.metadata || {};
  const fields = rosterOf(meta);
  if (!fields || !fields.length) return none;
  const sealed = type === 'SEALED_DOCUMENT';
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
  const open = fields.filter((f) => !signed.has(f.id));
  return {
    isContract: true,
    needsMine: open.some((f) => mine.has(f.handle)),
    waitingOn: [...new Set(open.filter((f) => !mine.has(f.handle)).map((f) => f.handle))],
    mineBound: fields.some((f) => mine.has(f.handle)),
  };
}

export function classifyVaultItem(
  row: ServerRow,
  myHandles: Iterable<string>,
  byId?: ReadonlyMap<string, ServerRow>,
): VaultStatus {
  const mine = new Set([...myHandles].map(normHandle).filter(Boolean));
  const meta = row.metadata || {};
  const ref = refOf(meta);
  const title = titleOf(meta);
  const fileName = fileNameOf(meta);
  const room = originRoom(row, mine, byId);
  const base: VaultStatus = {
    bucket: 'other',
    reviewCopy: false,
    earlierCopy: false,
    isContract: false,
    ref,
    title,
    fileName,
    room,
    waitingOn: [],
    needsMine: false,
    mineBound: false,
  };
  const type = row.signature_type;
  if (type !== 'DOCUMENT' && type !== 'SEALED_DOCUMENT') return base;
  const b = blocksOf(row, mine);
  const sealed = type === 'SEALED_DOCUMENT';
  if (isDraftOrTest(title, ref, fileName)) return { ...base, isContract: b.isContract, bucket: 'drafts' };
  if (!b.isContract && !sealed) return { ...base, bucket: 'files' };
  const review = room === DRAFTS_ROOM;
  const done = (): VaultBucket => (review ? 'to_sign' : isTxid(row.txid) ? 'signed' : 'signed_offchain');
  if (!b.isContract) return { ...base, reviewCopy: review, bucket: done() };
  const common = {
    ...base,
    isContract: true,
    reviewCopy: review,
    waitingOn: b.waitingOn,
    mineBound: b.mineBound,
  };
  if (b.needsMine) return { ...common, needsMine: true, bucket: 'to_sign' };
  if (b.waitingOn.length) return { ...common, bucket: 'waiting' };
  return { ...common, bucket: done() };
}

/** The rows the vault lists: not archived, and not superseded by a later DOCUMENT / SEALED_DOCUMENT row. */
export function latestGenerations<T extends ServerRow>(items: readonly T[]): T[] {
  const live = items.filter((s) => !s.metadata?.archived_at);
  const superseded = new Set(
    live
      .filter(
        (s) =>
          (s.signature_type === 'DOCUMENT' || s.signature_type === 'SEALED_DOCUMENT') &&
          str(s.metadata?.originalDocumentId),
      )
      .map((s) => String(s.metadata!.originalDocumentId)),
  );
  return live.filter((s) => !superseded.has(s.id));
}

const RANK: Partial<Record<VaultBucket, number>> = { to_sign: 1, waiting: 2, signed_offchain: 3, signed: 4 };
const baseName = (name: string | null): string =>
  String(name ?? '')
    .replace(/\.(html?|pdf|md|txt)$/i, '')
    .split(' — ')[0]
    .trim()
    .toLowerCase();

/** Every listed row's status, by id; earlier copies of one document marked (bit-sign classifyVaultItems). */
export function vaultBuckets<T extends ServerRow>(
  items: readonly T[],
  myHandles: Iterable<string>,
): Map<string, VaultStatus> {
  const mine = [...myHandles];
  const byId = new Map(items.map((s) => [s.id, s as ServerRow]));
  const rows = latestGenerations(items);
  const out = new Map<string, VaultStatus>();
  for (const s of rows) out.set(s.id, classifyVaultItem(s, mine, byId));
  const groups = new Map<string, T[]>();
  for (const s of rows) {
    const st = out.get(s.id)!;
    if (!RANK[st.bucket] || !(st.isContract || (s.signature_type === 'SEALED_DOCUMENT' && st.ref))) continue;
    const key = `${st.ref ?? ''}|${(st.title ?? baseName(st.fileName)).toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const best = [...g].sort((a, b) => {
      const ra = RANK[out.get(a.id)!.bucket]!;
      const rb = RANK[out.get(b.id)!.bucket]!;
      return rb - ra || ms(b.created_at) - ms(a.created_at);
    })[0];
    for (const s of g) if (s.id !== best.id) out.set(s.id, { ...out.get(s.id)!, earlierCopy: true });
  }
  return out;
}

// ── Signed's rows ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * bit-sign's vault rows → Signed rows, by the pile map above. Only documents I am a party to: one of my handles has a
 * block, or it is a signed record in my own vault.
 */
export function classifyServerRows(rows: readonly ServerRow[], myHandles: Iterable<string>): SignedRow[] {
  const mine = new Set([...myHandles].map(normHandle).filter(Boolean));
  const valid = rows.filter((r) => r && typeof r.id === 'string' && r.id && typeof r.signature_type === 'string');
  const st = vaultBuckets(valid, mine);
  const out: SignedRow[] = [];
  for (const r of valid) {
    const s = st.get(r.id);
    if (!s || s.earlierCopy) continue;
    const ownRow = !!str(r.user_handle) && mine.has(normHandle(r.user_handle));
    if (!s.mineBound && !ownRow) continue;
    const sealedRow = r.signature_type === 'SEALED_DOCUMENT';
    let status: SignedTab;
    let seal: string | null = null;
    if (s.bucket === 'to_sign') {
      if (!s.needsMine) continue; // a review copy I needn't sign: not executed, nothing for me to do
      status = 'waiting';
    } else if (s.bucket === 'waiting' || s.bucket === 'signed_offchain') status = 'signed';
    else if (s.bucket === 'signed') {
      seal = isTxid(r.seal_txid) ? r.seal_txid : sealedRow && isTxid(r.txid) ? r.txid : null;
      status = seal ? 'sealed' : 'signed';
    } else continue;
    const meta = r.metadata || {};
    out.push({
      key: clip(r.id, ID_MAX),
      signatureId: clip(r.id, ID_MAX),
      documentId: clip(str(meta.originalDocumentId) ?? r.id, ID_MAX),
      title: clip(s.title ?? (s.fileName ? s.fileName.replace(EXT, '') : ''), TITLE_MAX),
      room: cleanRoom(s.room),
      at: ms(r.created_at),
      docHash: hash64(r.payload_hash),
      sealTxid: seal ? seal.trim().toLowerCase() : null,
      status,
      ...(s.bucket === 'waiting' ? { others: true, waitingOn: s.waitingOn.slice(0, 10) } : {}),
      source: 'server',
    });
  }
  return out;
}

const fromLocal = (l: LocalSigned): SignedRow => {
  const seal = isTxid(l.sealTxid) ? l.sealTxid.trim().toLowerCase() : null;
  const others = l.complete === false;
  return {
    key: l.signatureId || hash64(l.docHash) || l.documentId,
    signatureId: l.signatureId,
    documentId: l.documentId,
    title: clip(l.title, TITLE_MAX),
    room: cleanRoom(l.room),
    at: l.at,
    docHash: hash64(l.docHash),
    sealTxid: seal,
    // My blocks are on chain, but another party still signs: Signed ("Waiting for others"), not Sealed.
    status: seal && !others ? 'sealed' : 'signed',
    ...(others ? { others: true, waitingOn: [] } : {}),
    source: 'local',
  };
};

/**
 * Local and server rows → one list, newest first.
 *   - Same row: the same signature id, or (only when the local record has no signature id) the same doc hash.
 *   - Status comes from the server when it has the row (it knows who still has to sign); the local record never
 *     forces Sealed over it. The local title and room win when set (what this wallet signed), the server fills blanks.
 *   - A local row with no server match stays (the server is down, or forgot it).
 *   - A server "waiting for me" row is dropped only when a local record shows that whole document complete (a seal of
 *     one of my blocks must not hide another block of mine still waiting).
 */
export function mergeRows(local: readonly LocalSigned[], server: readonly SignedRow[]): SignedRow[] {
  const merged: SignedRow[] = [];
  const used = new Set<SignedRow>();
  const completeDocs = new Set(
    local
      .filter((l) => l.complete === true)
      .map((l) => l.documentId)
      .filter(Boolean),
  );
  for (const l of local) {
    const mine = fromLocal(l);
    const s = server.find(
      (r) =>
        !used.has(r) &&
        (mine.signatureId ? r.signatureId === mine.signatureId : !!mine.docHash && r.docHash === mine.docHash),
    );
    if (!s) {
      merged.push(mine);
      continue;
    }
    used.add(s);
    merged.push({
      ...s,
      key: mine.signatureId || s.key,
      signatureId: mine.signatureId || s.signatureId,
      documentId: mine.documentId || s.documentId,
      title: mine.title || s.title,
      room: mine.room || s.room,
      at: mine.at || s.at,
      docHash: s.docHash || mine.docHash,
      sealTxid: s.sealTxid ?? (s.status === 'sealed' ? mine.sealTxid : null),
      source: 'both',
    });
  }
  for (const s of server) {
    if (used.has(s)) continue;
    if (s.status === 'waiting' && completeDocs.has(s.documentId)) continue;
    merged.push(s);
  }
  const seen = new Set<string>();
  return merged.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).sort((a, b) => b.at - a.at);
}

export const rowsIn = (rows: readonly SignedRow[], tab: SignedTab): SignedRow[] => rows.filter((r) => r.status === tab);

/** The menu badge: documents waiting for my signature, plus this account's held documents (each needs a tap). */
export const badgeCount = (rows: readonly SignedRow[], heldCount: number): number =>
  rows.filter((r) => r.status === 'waiting').length + Math.max(0, heldCount);

/** The title a row shows: its own, else a plain name from its hash or id. */
export const rowTitle = (r: Pick<SignedRow, 'title' | 'docHash' | 'documentId' | 'signatureId'>): string =>
  r.title || `Document ${shortHash(r.docHash) || (r.documentId || r.signatureId).slice(0, 8)}`;

/** "Waiting for $bailey, $bob" / "Waiting for others", for a Signed row whose other parties haven't signed. */
export const waitingLine = (r: Pick<SignedRow, 'others' | 'waitingOn'>): string =>
  r.others
    ? r.waitingOn?.length
      ? `Waiting for ${r.waitingOn.map((h) => `$${h}`).join(', ')}`
      : 'Waiting for others'
    : '';
