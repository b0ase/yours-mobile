import { describe, expect, test } from 'bun:test';
import {
  ALREADY_SIGNED,
  MISMATCH,
  NOT_BUILT,
  NOT_SIGNER,
  NOT_WAITING,
  OTHER_PENDING,
  openPendingForLink,
  type RoomReq,
  type RoomRes,
} from './nativeSealSource';

// The Massey s561 offer in DRAFTS (metadata only): upload 63987066 (sha d2695232…), contract 86b11d9a, nothing pending.
const T = 'DRAFTS';
const MEDIA = '63987066-b0f5-46fc-8b54-cd1c067cacf1';
const DRAFT = '86b11d9a-a4f4-408a-8b42-c5b1ed4acefe';
const SHA = 'd2695232' + '0'.repeat(56);
const pending = (id: string): RoomRes => ({
  ok: true,
  status: 200,
  body: { pending: { documentId: id, html: '<html></html>', manifest: { signatureFields: [] } } },
});
const none: RoomRes = { ok: true, status: 200, body: { pending: null } };

/** A room: answers prepare-doc from `pendingId`, and make-signable with `build` (which may move the pointer). */
const room = (start: string | null, build?: (b: Record<string, unknown>) => { res: RoomRes; pin?: string }) => {
  let pendingId = start;
  const calls: [string, string, Record<string, unknown> | undefined][] = [];
  const req: RoomReq = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path.endsWith('/prepare-doc')) return pendingId ? pending(pendingId) : none;
    if (path.endsWith('/make-signable') && build) {
      const out = build(body ?? {});
      if (out.pin) pendingId = out.pin;
      return out.res;
    }
    return { ok: false, status: 404, body: { error: 'nope' } };
  };
  return { req, calls };
};

describe('openPendingForLink', () => {
  test('the QR names the pending contract → opened, nothing built', async () => {
    const r = room(DRAFT);
    const out = await openPendingForLink(r.req, T, DRAFT, SHA);
    expect(out).toMatchObject({ ok: true, built: false, pending: { documentId: DRAFT } });
    expect(r.calls.map((c) => c[1])).toEqual([`/api/bitsign/rooms/${T}/prepare-doc`]);
  });

  test('Massey: nothing pending, upload QR → the phone builds it (same call as Sign here) and opens it', async () => {
    const r = room(null, () => ({ res: { ok: true, status: 200, body: { documentId: DRAFT } }, pin: DRAFT }));
    const out = await openPendingForLink(r.req, T, MEDIA, SHA.toUpperCase());
    expect(out).toMatchObject({ ok: true, built: true, pending: { documentId: DRAFT } });
    expect(r.calls[1]).toEqual([
      'POST',
      `/api/bitsign/rooms/${T}/make-signable`,
      { mediaId: MEDIA, expectedSha256: SHA, keepPending: true },
    ]);
    expect(r.calls).toHaveLength(3);
  });

  test('a different contract is pending → plain refusal, the pointer is untouched', async () => {
    const r = room('other-contract', () => ({
      res: { ok: false, status: 409, body: { otherPending: true, error: 'x' } },
    }));
    expect(await openPendingForLink(r.req, T, MEDIA, SHA)).toEqual({ ok: false, text: OTHER_PENDING });
    expect(r.calls).toHaveLength(2);
  });

  test('the server says the hash does not match → nothing signed', async () => {
    const r = room(null, () => ({ res: { ok: false, status: 409, body: { hashMismatch: true } } }));
    expect(await openPendingForLink(r.req, T, MEDIA, SHA)).toEqual({ ok: false, text: MISMATCH });
  });

  test('not a signer / already signed / unknown upload', async () => {
    const r1 = room(null, () => ({ res: { ok: false, status: 403, body: { notASigner: true } } }));
    expect(await openPendingForLink(r1.req, T, MEDIA, SHA)).toEqual({ ok: false, text: NOT_SIGNER });
    const r2 = room(null, () => ({ res: { ok: false, status: 409, body: { alreadySigned: true } } }));
    expect(await openPendingForLink(r2.req, T, MEDIA, SHA)).toEqual({ ok: false, text: ALREADY_SIGNED });
    const r3 = room(null, () => ({
      res: { ok: false, status: 404, body: { error: 'Document not found in this room' } },
    }));
    expect(await openPendingForLink(r3.req, T, MEDIA, SHA)).toEqual({ ok: false, text: NOT_WAITING });
  });

  test('no hash (banner, old link) → refused without asking the server to build', async () => {
    const r = room(null, () => ({ res: { ok: true, status: 200, body: { documentId: DRAFT } }, pin: DRAFT }));
    expect(await openPendingForLink(r.req, T, MEDIA, null)).toEqual({ ok: false, text: NOT_WAITING });
    expect(await openPendingForLink(r.req, T, MEDIA, 'pending-abc')).toEqual({ ok: false, text: NOT_WAITING });
    expect(r.calls.some((c) => c[1].endsWith('/make-signable'))).toBe(false);
  });

  test('built, but the room does not show it as pending → refused, never a different document', async () => {
    const r = room(null, () => ({ res: { ok: true, status: 200, body: { documentId: DRAFT } }, pin: 'someone-else' }));
    expect(await openPendingForLink(r.req, T, MEDIA, SHA)).toEqual({ ok: false, text: NOT_BUILT });
    const r2 = room(null, () => ({ res: { ok: true, status: 200, body: {} } }));
    expect(await openPendingForLink(r2.req, T, MEDIA, SHA)).toEqual({ ok: false, text: NOT_BUILT });
  });

  test('no document named (the banner opens whatever is pending) → the pending one, unchanged', async () => {
    expect(await openPendingForLink(room(DRAFT).req, T, '', null)).toMatchObject({ ok: true, built: false });
    expect(await openPendingForLink(room(null).req, T, '', null)).toEqual({ ok: false, text: NOT_WAITING });
  });
});
