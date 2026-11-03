/**
 * NATIVE sign + seal of a bChatX room document, inside bWalletX (CTO / owner, 3 Nov 2026: "chat should be IN the
 * wallet"). Phone signing never goes through a web page: the dApp browser's approval stalled on "Waiting for
 * request…" (two live tests, 05:36Z and 05:57Z: prepare + compose reached the server, nothing after).
 *
 * The SAME protocol as bit-sign's web client (bit-sign src/lib/bwalletx-seal.ts `attempt`), with the wallet's OWN keys
 * instead of a BRC-100 round trip:
 *   POST /api/bitsign/nds/seal/prepare {documentId, fieldIds}           → nonce, identityKey, estFeeSats…
 *   POST /api/bitsign/nds/seal/compose {nonce, svg}                     → signing {protocolID,keyID,counterparty},
 *                                                                          recordCanonical, lockingScriptHex
 *   wallet.createSignature(recordCanonical bytes)                       → attestation (hex)
 *   wallet.createAction(one 0-sat OP_RETURN output, acceptDelayedBroadcast:false) → txid + AtomicBEEF
 *   SAVE {nonce, txid, beefHex, attestation} locally (the money has moved)
 *   POST /api/bitsign/nds/seal/commit {nonce, attestation, txid, beefHex} (retry once on a network fault)
 *   on a refusal / lost commit: POST /api/bitsign/nds/seal/recover with the same body.
 * Authenticated with the wallet's silent bChatX session (Bearer, chat/chatSession.ts); the server checks the same
 * identity binding it checks for the web (the account's linked bWalletX key).
 *
 * PURE orchestration over injected deps: nativeSeal.test.ts drives the real order.
 */

export interface SealApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}
export type SealApi = (
  path: 'prepare' | 'compose' | 'commit' | 'recover',
  body: Record<string, unknown>,
) => Promise<SealApiReply>;

/** The two wallet calls this needs, from the wallet's own (no-prompt) interface. */
export interface SealKeys {
  createSignature(args: {
    protocolID: [0 | 1 | 2, string];
    keyID: string;
    counterparty: string;
    data: number[];
  }): Promise<{ signature: number[] }>;
  createAction(args: {
    description: string;
    outputs: { satoshis: number; lockingScript: string; outputDescription: string }[];
    options: { acceptDelayedBroadcast: boolean; randomizeOutputs: boolean };
  }): Promise<{ txid?: string; tx?: number[] }>;
}

export interface PendingSeal {
  documentId: string;
  nonce: string;
  txid: string;
  beefHex: string;
  attestation: string;
  savedAt: number;
}
export interface PendingSealStore {
  list(): PendingSeal[];
  save(p: PendingSeal): void;
  remove(nonce: string): void;
}

export interface PreparedSeal {
  nonce: string;
  ref: string;
  title: string;
  identityKey: string;
  estFeeSats: number;
}

export type SealStep = 'preparing' | 'approving' | 'composing' | 'signing' | 'paying' | 'committing' | 'recovering';

export class NativeSealError extends Error {
  constructor(
    message: string,
    readonly code: 'already_sealed' | 'refused' | 'cancelled' | 'pending_recovery' | 'failed',
    readonly status = 0,
  ) {
    super(message);
    this.name = 'NativeSealError';
  }
}

export interface NativeSealOutcome {
  signatureId: string;
  txid: string;
  docHash: string;
  complete: boolean;
  sealed: boolean;
  recovered?: boolean;
}

const toHex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

async function call(api: SealApi, path: Parameters<SealApi>[0], body: Record<string, unknown>) {
  const r = await api(path, body);
  if (!r.ok) {
    const code = typeof r.body.code === 'string' ? r.body.code : '';
    const msg =
      typeof r.body.error === 'string' && r.body.error ? r.body.error : `The seal ${path} step failed (${r.status}).`;
    throw new NativeSealError(msg, code === 'already_sealed' ? 'already_sealed' : 'refused', r.status);
  }
  return r.body;
}

/**
 * Sign and seal. `approve(prepared)` is the ONE approval (the wallet's own sheet + Face ID), asked after prepare (so it
 * can show the fee and the reference) and before anything is signed or paid; false = cancelled, nothing happens.
 */
export async function nativeSignAndSeal(input: {
  documentId: string;
  fieldIds: string[];
  svg: string;
  api: SealApi;
  keys: SealKeys;
  store: PendingSealStore;
  approve: (prepared: PreparedSeal) => Promise<boolean>;
  onStep?: (s: SealStep) => void;
  now?: () => number;
}): Promise<NativeSealOutcome> {
  const step = (s: SealStep) => input.onStep?.(s);
  step('preparing');
  const prepared = (await call(input.api, 'prepare', {
    documentId: input.documentId,
    fieldIds: input.fieldIds,
  })) as unknown as PreparedSeal;

  step('approving');
  if (!(await input.approve(prepared)))
    throw new NativeSealError('Not sealed: you cancelled. Nothing was signed or paid.', 'cancelled');

  step('composing');
  const composed = await call(input.api, 'compose', { nonce: prepared.nonce, svg: input.svg.trim() });
  const signing = composed.signing as { protocolID: [0 | 1 | 2, string]; keyID: string; counterparty: string };
  const recordCanonical = String(composed.recordCanonical);
  const lockingScriptHex = String(composed.lockingScriptHex);

  step('signing');
  const { signature } = await input.keys.createSignature({
    protocolID: signing.protocolID,
    keyID: signing.keyID,
    counterparty: signing.counterparty,
    data: Array.from(new TextEncoder().encode(recordCanonical)),
  });
  const attestation = toHex(signature);

  step('paying');
  const paid = await input.keys.createAction({
    description: 'bit-sign: sign and seal a document',
    outputs: [
      { satoshis: 0, lockingScript: lockingScriptHex, outputDescription: 'Document seal (OP_RETURN, hashes only)' },
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  });
  if (!paid?.txid || !paid.tx)
    throw new NativeSealError('The wallet did not return the seal transaction, so nothing was recorded.', 'failed');
  const txid = paid.txid.toLowerCase();
  const beefHex = toHex(paid.tx);

  // ⚠ PERSIST BEFORE COMMIT: from here on the seal is paid for.
  input.store.save({
    documentId: input.documentId,
    nonce: prepared.nonce,
    txid,
    beefHex,
    attestation,
    savedAt: (input.now ?? Date.now)(),
  });

  step('committing');
  const body = { nonce: prepared.nonce, attestation, txid, beefHex };
  let out: Record<string, unknown> | null = null;
  let lastErr = '';
  for (let i = 0; i < 2 && !out; i++) {
    try {
      const r = await input.api('commit', body);
      if (r.ok) out = r.body;
      else {
        lastErr = typeof r.body.error === 'string' ? r.body.error : `Commit failed (${r.status}).`;
        break; // a refusal will not change on a plain retry: recover
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'network error'; // retry once with the same nonce + txid
    }
  }
  let recovered = false;
  if (!out) {
    step('recovering');
    try {
      const r = await input.api('recover', body);
      if (r.ok) {
        out = r.body;
        recovered = true;
      } else if (r.status !== 0 && r.status < 500 && r.status !== 429) {
        input.store.remove(prepared.nonce);
        throw new NativeSealError(
          typeof r.body.error === 'string' ? r.body.error : 'The seal could not be recorded.',
          'failed',
          r.status,
        );
      }
    } catch (e) {
      if (e instanceof NativeSealError) throw e;
    }
  }
  if (!out) {
    throw new NativeSealError(
      `Paid (${txid.slice(0, 12)}…) but not recorded yet${lastErr ? ` (${lastErr})` : ''}. It is saved on this phone and will be finished the next time you open this document.`,
      'pending_recovery',
    );
  }
  input.store.remove(prepared.nonce);
  return {
    signatureId: String(out.signatureId ?? ''),
    txid: String(out.txid || txid),
    docHash: String(out.docHash ?? ''),
    complete: !!out.complete,
    sealed: !!out.sealed,
    ...(recovered ? { recovered: true } : {}),
  };
}

/** Finish paid-but-unrecorded seals saved on this phone (for this document, or all). Never throws. */
export async function recoverNativeSeals(api: SealApi, store: PendingSealStore, documentId?: string): Promise<number> {
  let done = 0;
  for (const p of store.list()) {
    if (documentId && p.documentId !== documentId) continue;
    try {
      const r = await api('recover', { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex });
      if (r.ok || (r.status !== 0 && r.status < 500 && r.status !== 429)) {
        store.remove(p.nonce);
        if (r.ok) done++;
      }
    } catch {
      /* next time */
    }
  }
  return done;
}

// ── The drawn signature, in exactly the web pad's format (bit-sign InPlaceSignaturePad / SovereignSignature) ──────────

/** POST to bChatX as the wallet's session; throws on a refusal. */
export type RoomPost = (path: string, body: Record<string, unknown>) => Promise<unknown>;

/**
 * The ROOM's steps after a native seal, exactly as the web room does them (bit-sign room page runPhoneRoomSteps):
 * fully signed → pin the sealed copy (POST /api/bitsign/rooms, which posts the "signed and sealed" row) and clear the
 * pending pointer (prepare-doc 'sealed'); part-signed → hand the signed copy on (prepare-doc 'send'). Without these the
 * room kept showing "Ready to sign" after the phone sealed (owner's iPhone, 3 Nov 2026). The seal is already on chain,
 * so a failure here is the room step only and is safe to retry.
 */
export async function nativeRoomSteps(
  post: RoomPost,
  ticker: string,
  manifest: Record<string, unknown> | null,
  out: Pick<NativeSealOutcome, 'signatureId' | 'txid' | 'docHash' | 'complete'>,
): Promise<'pinned' | 'handed-on'> {
  const room = `/api/bitsign/rooms/${encodeURIComponent(ticker)}/prepare-doc`;
  if (out.complete) {
    await post('/api/bitsign/rooms', {
      ticker,
      documentId: out.signatureId,
      docTxid: out.txid,
      docHash: out.docHash,
      manifest,
    });
    await post(room, { action: 'sealed' });
    return 'pinned';
  }
  await post(room, { action: 'send', documentId: out.signatureId });
  return 'handed-on';
}

/**
 * The signed copy after a native seal, for the phone to show (owner, 3 Nov 2026: "the document, once signed, did not
 * have the signature on it on my phone"). Same source as the room card: GET /api/bitsign/rooms/<T>/executed, tried by
 * each id in order (the original document, then the new signature). Null when none answers with HTML.
 */
export async function fetchSignedCopy(
  get: (path: string) => Promise<unknown>,
  ticker: string,
  ids: string[],
): Promise<string | null> {
  for (const id of ids.filter(Boolean)) {
    try {
      const html = await get(
        `/api/bitsign/rooms/${encodeURIComponent(ticker)}/executed?documentId=${encodeURIComponent(id)}`,
      );
      if (typeof html === 'string' && /<[a-z!]/i.test(html)) return html;
    } catch {
      /* try the next id */
    }
  }
  return null;
}

export type PadPoint = { x: number; y: number; pressure: number };

/** Strokes on a pad of `width`×`height` → the canonical SVG bit-sign's sanitiser accepts byte-for-byte. Null if empty. */
export function strokesToSvg(strokes: PadPoint[][], width: number, height: number): string | null {
  const usable = strokes.filter((s) => s.length > 1);
  if (!usable.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of usable)
    for (const p of s) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width, maxX + pad);
  maxY = Math.min(height, maxY + pad);
  const svgW = maxX - minX;
  const svgH = maxY - minY;
  let paths = '';
  for (const s of usable) {
    let d = `M ${(s[0].x - minX).toFixed(1)} ${(s[0].y - minY).toFixed(1)}`;
    for (let i = 1; i < s.length; i++) d += ` L ${(s[i].x - minX).toFixed(1)} ${(s[i].y - minY).toFixed(1)}`;
    const avg = s.reduce((n, p) => n + p.pressure, 0) / s.length;
    paths += `<path d="${d}" stroke="black" stroke-width="${(1 + avg * 4).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW.toFixed(0)} ${svgH.toFixed(0)}" width="${svgW.toFixed(0)}" height="${svgH.toFixed(0)}">${paths}</svg>`;
}

// ── Which blocks this person signs ─────────────────────────────────────────────────────────────────────────────────

export interface SigField {
  id: string;
  signerHandle?: string | null;
  role?: string;
  name?: string | null;
  required?: boolean;
}

/** The unsigned blocks bound to one of this person's handles (all handles of the same identity key). */
/**
 * Every handle the signed-in account holds, from GET /api/bitsign/me/handles ({ handles: [{ handle }], primary }).
 * A block bound to any of them is yours (owner, 3 Nov 2026: the Massey s561 block is bound to $boase while the phone
 * signs in as $b0asex, the same account, and the phone said "no signature block"). Bad or empty input → [].
 */
export function accountHandles(resp: unknown): string[] {
  const r = (resp ?? {}) as { handles?: Array<{ handle?: unknown }>; primary?: unknown };
  const out = new Set<string>();
  for (const h of Array.isArray(r.handles) ? r.handles : [])
    if (typeof h?.handle === 'string' && h.handle) out.add(h.handle);
  if (typeof r.primary === 'string' && r.primary) out.add(r.primary);
  return [...out];
}

export function myFields(fields: SigField[], myHandles: string[], signedIds: Set<string>): SigField[] {
  const mine = new Set(myHandles.map((h) => h.replace(/^\$/, '').toLowerCase()).filter(Boolean));
  return fields.filter(
    (f) =>
      !signedIds.has(f.id) && !!f.signerHandle && mine.has(String(f.signerHandle).replace(/^\$/, '').toLowerCase()),
  );
}

/** Blocks the document already shows signed (data-sig-anchor="x" data-signed="true"). */
export function signedFieldIds(html: string): Set<string> {
  const out = new Set<string>();
  const re = /<[a-zA-Z][a-zA-Z0-9-]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const a = m[1] || '';
    const id = /\sdata-sig-anchor\s*=\s*["']([^"']+)["']/i.exec(a)?.[1];
    if (id && /\sdata-signed\s*=\s*["']true["']/i.test(a)) out.add(id);
  }
  return out;
}

/** The document for display: scripts, event handlers and active URLs removed (it renders in a no-script frame too). */
export function inertHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '$1="#"');
}

/** The native Review & sign screen for one room document (MobileRoutes "seal/:ticker/:doc"). Null for a bad ref. */
export const nativeSealRoute = (ticker: string, docId: string): string | null => {
  const t = (ticker || '').trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9_.-]{1,64}$/.test(t) || !/^[A-Za-z0-9-]{1,64}$/.test(docId || '')) return null;
  return `/m/seal/${encodeURIComponent(t)}/${encodeURIComponent(docId)}`;
};
