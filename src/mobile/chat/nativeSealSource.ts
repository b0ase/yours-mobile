/**
 * Which document the native Review & sign screen opens for a scanned QR (CEO, 3 Nov 2026: the owner signs ONLY on his
 * phone, so scanning the card's QR must be the whole flow).
 *
 * A bChatX card's QR names either the room's pending CONTRACT (id + the sha256 of the html the room serves) or, when
 * no contract is pending yet, the UPLOAD it will be built from (media id + the upload's sha256). The Massey s561 offer
 * was the second kind and this screen refused it: "This document is not waiting for your signature".
 *
 *   1. The room's pending contract is the QR's document → open it (unchanged).
 *   2. Otherwise, with the QR's hash in hand, ask the room to build that contract from the upload: the SAME call the
 *      desktop's "Sign here" makes (POST rooms/<T>/make-signable { mediaId }), plus `expectedSha256` (the server
 *      refuses unless the stored upload hashes to the QR's sha256, so the phone never signs a different file) and
 *      `keepPending` (the server refuses rather than displace a DIFFERENT pending contract). It also refuses when this
 *      session has no signature block on the result. bit-sign: lib/phone-build-guard.ts.
 *   3. Re-read the pending contract; it must now be the one just built. Then the normal flow continues.
 *
 * Nothing here signs. PURE apart from the injected request (nativeSealSource.test.ts).
 */

export type RoomRes = { ok: boolean; status: number; body: Record<string, unknown> };
export type RoomReq = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<RoomRes>;

export type PendingDoc = {
  documentId: string;
  html: string;
  manifest: ({ documentTitle?: string; signatureFields?: unknown[] } & Record<string, unknown>) | null;
};

export type OpenOutcome = { ok: true; pending: PendingDoc; built: boolean } | { ok: false; text: string };

export const NOT_WAITING = 'This document is not waiting for your signature (it may already be signed and sealed).';
export const OTHER_PENDING =
  'Another document is already waiting for signature in this room. Sign or withdraw that one first; nothing was changed.';
export const MISMATCH = 'This QR does not match the document in the room, so nothing was signed. Scan the card again.';
export const NOT_SIGNER = 'You are not a signer of this document.';
export const ALREADY_SIGNED = 'This document is already signed.';
export const NOT_BUILT = 'The document could not be put up for signature. Try again.';

const HASH_RE = /^[0-9a-f]{64}$/;

const pendingOf = (r: RoomRes): PendingDoc | null => {
  if (!r.ok) return null;
  const p = r.body?.pending as Partial<PendingDoc> | null | undefined;
  if (!p || typeof p.documentId !== 'string' || !p.documentId || typeof p.html !== 'string') return null;
  return { documentId: p.documentId, html: p.html, manifest: (p.manifest as PendingDoc['manifest']) ?? null };
};

/** The plain sentence for a refused build (the server's flags first, its own words second). */
export const buildRefusal = (r: RoomRes): string => {
  const b = r.body || {};
  if (b.otherPending === true) return OTHER_PENDING;
  if (b.hashMismatch === true) return MISMATCH;
  if (b.notASigner === true) return NOT_SIGNER;
  if (b.alreadySigned === true) return ALREADY_SIGNED;
  if (r.status === 404) return NOT_WAITING;
  return typeof b.error === 'string' && b.error ? b.error : NOT_BUILT;
};

export async function openPendingForLink(
  req: RoomReq,
  ticker: string,
  docId: string,
  hash: string | null | undefined,
): Promise<OpenOutcome> {
  const room = `/api/bitsign/rooms/${encodeURIComponent(ticker)}`;
  const first = pendingOf(await req('GET', `${room}/prepare-doc`));
  if (first && (!docId || first.documentId === docId)) return { ok: true, pending: first, built: false };
  // No hash, no build: a banner / button that names a document which is no longer pending (or a bad QR).
  const h = (hash || '').toLowerCase();
  if (!docId || !HASH_RE.test(h)) return { ok: false, text: NOT_WAITING };

  const built = await req('POST', `${room}/make-signable`, { mediaId: docId, expectedSha256: h, keepPending: true });
  if (!built.ok) return { ok: false, text: buildRefusal(built) };
  const id = typeof built.body?.documentId === 'string' ? built.body.documentId : '';
  if (!id) return { ok: false, text: NOT_BUILT };

  const again = pendingOf(await req('GET', `${room}/prepare-doc`));
  if (!again || again.documentId !== id) return { ok: false, text: NOT_BUILT };
  return { ok: true, pending: again, built: true };
}
