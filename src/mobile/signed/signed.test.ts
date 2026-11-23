import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  nativeSignAndSeal,
  recoverNativeSeals,
  setSealRecordedHook,
  type PendingSeal,
  type SealApi,
  type SealRecorded,
} from '../chat/nativeSeal';
import { SEAL_HTML, SEAL_KEY, composedFor, preparedFor } from '../chat/nativeSeal.fixtures';
import { stubGlobals } from '../../testing/stubGlobals';
import {
  badgeCount,
  classifyServerRows,
  isTxid,
  mergeRows,
  rowTitle,
  rowsIn,
  shortHash,
  wocTxUrl,
  type LocalSigned,
  type ServerRow,
  type SignedRow,
} from './signedList';
import { addLocal, loadCachedSync, loadLocal, localKey, saveCachedSync, type KV } from './localStore';
import { PENDING_SEALS_KEY, SEALED_LEDGER_KEY, heldFor, heldSealStore, readHeldSeals, sealedLedger } from './held';
import { recordSeal, roomFor } from './recorder';
import { fetchServerRows, quietSyncDue, syncFailure, syncSigned } from './sync';
import { EMPTY_TEXT, HeldBanner, PAGE_STATUS, PageStatus, SyncNote } from './SignedParts';

/** One in-memory storage, installed as localStorage for this file (stubGlobals puts the old one back). */
const mem = new Map<string, string>();
const kv: KV & { removeItem(k: string): void; clear(): void } = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
};
stubGlobals({ localStorage: kv });
afterEach(() => {
  mem.clear();
  setSealRecordedHook(null);
});

const TX1 = 'a1'.repeat(32);
const TX2 = 'b2'.repeat(32);
const H1 = 'c3'.repeat(32);
const H2 = 'd4'.repeat(32);
const ME = `02${'11'.repeat(32)}`;

const manifest = (fields: { id: string; signerHandle?: string }[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ documentTitle: 'Board minute 012', documentRef: 'BCORP-BM-012', signatureFields: fields, ...over });
const row = (o: Partial<ServerRow> & { id: string }): ServerRow => ({
  signature_type: 'DOCUMENT',
  created_at: '2026-11-20T10:00:00Z',
  ...o,
});
const local = (o: Partial<LocalSigned> = {}): LocalSigned => ({
  signatureId: 'SIG1',
  documentId: 'DOC1',
  docHash: H1,
  sealTxid: TX1,
  room: 'BCORP',
  title: 'Board minute 012',
  at: Date.parse('2026-11-21T10:00:00Z'),
  ...o,
});
const srow = (o: Partial<SignedRow> = {}): SignedRow => ({
  key: 'SIG1',
  signatureId: 'SIG1',
  documentId: 'DOC1',
  title: 'Board minute 012',
  room: 'BCORP',
  at: Date.parse('2026-11-21T10:00:00Z'),
  docHash: H1,
  sealTxid: TX1,
  status: 'sealed',
  source: 'server',
  ...o,
});

describe('bit-sign rows → Signed rows (the vault classification, ported)', () => {
  test('waiting for me: a document with an unsigned block bound to one of my handles (any of them)', () => {
    const rows = classifyServerRows(
      [
        row({
          id: 'DOC1',
          user_handle: 'BCORP',
          metadata: {
            ndsManifest: manifest([
              { id: 'a', signerHandle: '$boase' },
              { id: 'b', signerHandle: 'bailey' },
            ]),
          },
        }),
      ],
      ['b0asex', 'boase'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'waiting', room: 'BCORP', title: 'Board minute 012', signatureId: 'DOC1' });
  });

  test('signed (mine done, not on chain), sealed (a real txid), a pending- placeholder is not a seal', () => {
    const rows = classifyServerRows(
      [
        row({
          id: 'P1',
          user_handle: 'b0asex',
          txid: 'pending-123',
          payload_hash: H2,
          metadata: {
            roomTicker: 'FILM',
            ndsSignedFields: ['a'],
            ndsManifest: manifest(
              [
                { id: 'a', signerHandle: 'b0asex' },
                { id: 'b', signerHandle: 'bob' },
              ],
              {
                documentTitle: 'Film rights',
                documentRef: 'FILM-1',
              },
            ),
          },
        }),
        row({
          id: 'S1',
          signature_type: 'SEALED_DOCUMENT',
          user_handle: 'b0asex',
          txid: TX1.toUpperCase(),
          payload_hash: H1.toUpperCase(),
          metadata: { roomTicker: '$bcorp', ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }]) },
        }),
      ],
      ['b0asex'],
    );
    const by = Object.fromEntries(rows.map((r) => [r.signatureId, r]));
    expect(by.P1).toMatchObject({ status: 'signed', sealTxid: null, room: 'FILM', docHash: H2 });
    expect(by.S1).toMatchObject({ status: 'sealed', sealTxid: TX1, room: 'BCORP', docHash: H1 });
  });

  test('one document, one row: a superseded copy and an earlier copy of the same document drop out', () => {
    const rows = classifyServerRows(
      [
        row({
          id: 'DOC1',
          user_handle: 'BCORP',
          metadata: { ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }]) },
        }),
        row({
          id: 'S1',
          signature_type: 'SEALED_DOCUMENT',
          user_handle: 'b0asex',
          txid: TX1,
          created_at: '2026-11-21T10:00:00Z',
          metadata: { originalDocumentId: 'DOC1', ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }]) },
        }),
        // Same reference and title in the same room, an older part-signed copy: not a second row.
        row({
          id: 'OLD',
          user_handle: 'BCORP',
          created_at: '2026-11-01T10:00:00Z',
          metadata: { ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }]) },
        }),
      ],
      ['b0asex'],
    );
    expect(rows.map((r) => [r.signatureId, r.status])).toEqual([['S1', 'sealed']]);
    expect(rows[0].documentId).toBe('DOC1');
  });

  test('not mine, files, drawn signatures, drafts / tests and archived rows are left out', () => {
    const rows = classifyServerRows(
      [
        row({
          id: 'X1',
          user_handle: 'BCORP',
          metadata: { ndsManifest: manifest([{ id: 'a', signerHandle: 'bob' }]) },
        }),
        row({ id: 'F1', user_handle: 'b0asex', metadata: { fileName: 'photo.png' } }),
        row({ id: 'D1', signature_type: 'TLDRAW', user_handle: 'b0asex' }),
        row({
          id: 'T1',
          user_handle: 'b0asex',
          metadata: {
            ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], { documentTitle: 'NDA (PRACTICE)' }),
          },
        }),
        row({
          id: 'A1',
          user_handle: 'b0asex',
          metadata: { archived_at: '2026-11-02', ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }]) },
        }),
        // "test coins" is an ordinary word, not a label: kept.
        row({
          id: 'K1',
          user_handle: 'b0asex',
          metadata: {
            ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], {
              documentTitle: 'Custody Note cert 012 test coins',
            }),
          },
        }),
      ],
      ['b0asex'],
    );
    expect(rows.map((r) => r.signatureId)).toEqual(['K1']);
  });
});

describe('merging the wallet’s own list with bit-sign’s', () => {
  test('dedupe by signature id: one row, the server fills the title and room, the local seal txid stands', () => {
    const out = mergeRows(
      [local({ title: '', room: '' })],
      [srow({ title: 'From server', room: 'FILM', sealTxid: null, status: 'signed' })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'From server',
      room: 'FILM',
      sealTxid: TX1,
      status: 'sealed',
      source: 'both',
    });
  });

  test('dedupe by doc hash when the ids differ', () => {
    const out = mergeRows([local({ signatureId: '' })], [srow({ signatureId: 'OTHER', key: 'OTHER' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ signatureId: 'OTHER', source: 'both' });
  });

  test('local rows survive the server losing them (down, signed out, or it forgot)', () => {
    const out = mergeRows(
      [local(), local({ signatureId: 'SIG2', documentId: 'DOC2', docHash: H2, sealTxid: TX2 })],
      [],
    );
    expect(out.map((r) => [r.signatureId, r.status, r.source])).toEqual([
      ['SIG1', 'sealed', 'local'],
      ['SIG2', 'sealed', 'local'],
    ]);
  });

  test('a server row still waiting on a document this wallet sealed since is dropped; others stay, newest first', () => {
    const out = mergeRows(
      [local({ signatureId: 'SIG9', docHash: H2 })],
      [
        srow({ key: 'DOC1', signatureId: 'DOC1', documentId: 'DOC1', status: 'waiting', sealTxid: null, docHash: '' }),
        srow({
          key: 'W2',
          signatureId: 'W2',
          documentId: 'W2',
          status: 'waiting',
          sealTxid: null,
          docHash: '',
          at: 9e12,
        }),
      ],
    );
    expect(out.map((r) => r.signatureId)).toEqual(['W2', 'SIG9']);
  });

  test('tabs and the badge: waiting rows plus held seals', () => {
    const rows = mergeRows(
      [local()],
      [srow({ key: 'W', signatureId: 'W', documentId: 'W', status: 'waiting', sealTxid: null, docHash: '' })],
    );
    expect(rowsIn(rows, 'waiting').map((r) => r.signatureId)).toEqual(['W']);
    expect(rowsIn(rows, 'sealed').map((r) => r.signatureId)).toEqual(['SIG1']);
    expect(rowsIn(rows, 'signed')).toEqual([]);
    expect(badgeCount(rows, 0)).toBe(1);
    expect(badgeCount(rows, 2)).toBe(3);
    expect(badgeCount([], -1)).toBe(0);
  });

  test('a row with no title is named by its short hash, never left blank', () => {
    expect(rowTitle({ title: '', docHash: H1, documentId: 'DOC1', signatureId: 'S' })).toBe(
      `Document ${H1.slice(0, 8)}`,
    );
    expect(rowTitle({ title: '', docHash: '', documentId: 'abcdef123456', signatureId: '' })).toBe('Document abcdef12');
  });
});

describe('the seal link and the short hash', () => {
  test('WhatsOnChain only from a valid 64-hex txid', () => {
    expect(wocTxUrl(TX1)).toBe(`https://whatsonchain.com/tx/${TX1}`);
    expect(wocTxUrl(` ${TX1.toUpperCase()} `)).toBe(`https://whatsonchain.com/tx/${TX1}`);
    for (const bad of [
      'pending-123',
      TX1.slice(1),
      `${TX1}0`,
      `${TX1.slice(0, 63)}g`,
      '',
      null,
      undefined,
      42,
      'javascript:alert(1)',
    ])
      expect(wocTxUrl(bad)).toBeNull();
    expect(isTxid('pending-abc')).toBe(false);
  });
  test('short hash: the first 8, lower case; not a hash → nothing', () => {
    expect(shortHash(H1.toUpperCase())).toBe(H1.slice(0, 8));
    expect(shortHash('xyz')).toBe('');
    expect(shortHash(undefined)).toBe('');
  });
});

describe('the wallet-local list (per identity key, on this device)', () => {
  test('add, update by signature id (blanks never overwrite), and kept apart per identity key', () => {
    addLocal(ME, local({ title: 'First', room: '' }));
    addLocal(ME, local({ title: '', room: 'BCORP', sealTxid: '' }));
    addLocal(`03${'22'.repeat(32)}`, local({ signatureId: 'OTHER' }));
    const mine = loadLocal(ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'First', room: 'BCORP', sealTxid: TX1 });
    expect(loadLocal(`03${'22'.repeat(32)}`).map((l) => l.signatureId)).toEqual(['OTHER']);
    expect(mem.has(localKey(ME))).toBe(true);
    expect(localKey(ME)).toBe(`bwallet.signed.${ME}`);
  });
  test('a bad txid is never stored as a seal; junk in storage reads as empty', () => {
    addLocal(ME, local({ sealTxid: 'pending-1' }));
    expect(loadLocal(ME)[0].sealTxid).toBe('');
    mem.set(localKey(ME), '{not json');
    expect(loadLocal(ME)).toEqual([]);
    expect(loadLocal('')).toEqual([]);
  });
  test('the last sync is cached for offline, and paces the quiet sync', () => {
    expect(quietSyncDue(ME, true, 1_000_000)).toBe(true);
    saveCachedSync(ME, [srow()], 1_000_000);
    expect(loadCachedSync(ME)?.rows.map((r) => r.signatureId)).toEqual(['SIG1']);
    expect(quietSyncDue(ME, true, 1_000_000 + 60_000)).toBe(false);
    expect(quietSyncDue(ME, true, 1_000_000 + 5 * 60_000)).toBe(true);
    expect(quietSyncDue(ME, false, 9e12)).toBe(false);
  });
});

describe('the recorder: every seal this device records lands in the list', () => {
  const env = (path = '/m/chat') => ({ path: () => path, identityKey: () => ME, now: () => 1234, kv });
  const rec = (o: Partial<SealRecorded> = {}): SealRecorded => ({
    documentId: 'DOC1',
    identityKey: ME,
    title: 'Board minute 012',
    signatureId: 'SIG1',
    txid: TX1,
    docHash: H1,
    complete: true,
    ...o,
  });
  test('the room comes from the Sign page’s route, else a row already known for that document', () => {
    expect(roomFor({ documentId: 'DOC1' }, ME, env('/m/seal/%24bcorp/DOC1'))).toBe('BCORP');
    expect(roomFor({ documentId: 'DOC1' }, ME, env())).toBe('');
    saveCachedSync(ME, [srow({ room: 'FILM' })], 1);
    expect(roomFor({ documentId: 'DOC1' }, ME, env())).toBe('FILM');
  });
  test('a record saved before keys were stored with it files under the current account', () => {
    recordSeal(rec({ identityKey: '' }), env('/m/seal/BCORP/DOC1'));
    expect(loadLocal(ME)).toEqual([
      {
        signatureId: 'SIG1',
        documentId: 'DOC1',
        docHash: H1,
        sealTxid: TX1,
        room: 'BCORP',
        title: 'Board minute 012',
        at: 1234,
        complete: true,
      },
    ]);
  });

  test('nativeSeal’s hook fires on a fresh seal, with prepare’s title', async () => {
    const got: SealRecorded[] = [];
    setSealRecordedHook((s) => got.push(s));
    let prepared = { documentId: 'D', fieldIds: ['f1'] as string[] };
    const api: SealApi = async (path, body) => {
      if (path === 'prepare') {
        prepared = body as typeof prepared;
        return { ok: true, status: 200, body: preparedFor('N1') };
      }
      if (path === 'compose')
        return {
          ok: true,
          status: 200,
          body: composedFor({ ...prepared, svg: String(body.svg), nonce: String(body.nonce) }),
        };
      return {
        ok: true,
        status: 200,
        body: { signatureId: 'S', txid: TX1, docHash: H1, complete: true, sealed: true },
      };
    };
    const m = new Map<string, PendingSeal>();
    await nativeSignAndSeal({
      documentId: 'D',
      documentHtml: SEAL_HTML,
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
      svg: '<svg/>',
      api,
      keys: {
        createSignature: async () => ({ signature: [1, 2, 255] }),
        createAction: async () => ({ txid: TX1, tx: [9, 9] }),
      },
      store: { list: () => [...m.values()], save: (p) => void m.set(p.nonce, p), remove: (n) => void m.delete(n) },
      approve: async () => true,
    });
    expect(got).toEqual([
      { documentId: 'D', identityKey: SEAL_KEY, title: 'T', signatureId: 'S', txid: TX1, docHash: H1, complete: true },
    ]);
  });

  test('…and on a recovered one; a listener that throws never touches the seal', async () => {
    const got: SealRecorded[] = [];
    setSealRecordedHook((s) => {
      got.push(s);
      throw new Error('listener bug');
    });
    const store = heldSealStore(kv);
    store.save({
      documentId: 'DOC1',
      nonce: 'N1',
      txid: TX1,
      beefHex: '0909',
      attestation: 'ab',
      savedAt: 1,
      identityKey: ME,
    });
    const api: SealApi = async () => ({
      ok: true,
      status: 200,
      body: { signatureId: 'SIG1', txid: TX1, docHash: H1, complete: false },
    });
    expect(await recoverNativeSeals(api, store, 'DOC1', sealedLedger(kv))).toBe(1);
    expect(got).toEqual([
      { documentId: 'DOC1', identityKey: ME, title: '', signatureId: 'SIG1', txid: TX1, docHash: H1, complete: false },
    ]);
    expect(readHeldSeals(kv)).toEqual([]);
  });
});

describe('held seals: the banner, and Finish runs the seal page’s own recovery', () => {
  const held = (o: Partial<PendingSeal> = {}): PendingSeal => ({
    documentId: '1c377264-aaaa',
    nonce: 'N1',
    txid: '',
    beefHex: '',
    attestation: 'ab',
    savedAt: Date.parse('2026-11-22T09:00:00Z'),
    identityKey: ME,
    ...o,
  });

  test('the same storage as the seal page (its keys are pinned to NativeSealPage.tsx)', () => {
    const page = readFileSync(new URL('../chat/NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain(`'${PENDING_SEALS_KEY}'`);
    expect(page).toContain(`'${SEALED_LEDGER_KEY}'`);
  });

  test('read only lists this account’s held seals; unknown fields survive a save', () => {
    mem.set(
      PENDING_SEALS_KEY,
      JSON.stringify([
        held(),
        held({ nonce: 'N2', identityKey: `03${'22'.repeat(32)}` }),
        held({ nonce: 'N3', identityKey: undefined }),
        { junk: true },
      ]),
    );
    expect(heldFor(ME, readHeldSeals(kv)).map((p) => p.nonce)).toEqual(['N1', 'N3']);
    const store = heldSealStore(kv);
    store.save({
      ...(store.list()[0] as PendingSeal & { drawing?: string }),
      drawing: 'M 0 0',
      txid: TX1,
    } as PendingSeal);
    expect(JSON.parse(mem.get(PENDING_SEALS_KEY)!).find((p: { nonce: string }) => p.nonce === 'N1')).toMatchObject({
      drawing: 'M 0 0',
      txid: TX1,
    });
    mem.set(PENDING_SEALS_KEY, 'nope');
    expect(readHeldSeals(kv)).toEqual([]);
  });

  test('the banner lists each held document once, with Finish, and the state of a Finish', () => {
    const html = renderToStaticMarkup(
      createElement(HeldBanner, {
        held: [held(), held({ nonce: 'N2' }), held({ documentId: 'other', nonce: 'N3' })],
        titleOf: (id: string) => `Doc ${id}`,
        onFinish: () => undefined,
        states: { other: 'still_held' },
      }),
    );
    expect(html).toContain('Held: needs recovery');
    expect(html.match(/>Finish</g)).toHaveLength(2);
    expect(html).toContain('Doc 1c377264-aaaa');
    expect(html).toContain('Not recorded yet. It stays here and is tried again; nothing is paid twice.');
    expect(
      renderToStaticMarkup(
        createElement(HeldBanner, { held: [], titleOf: String, onFinish: () => undefined, states: {} }),
      ),
    ).toBe('');
  });

  test('Finish calls recoverNativeSeals for that document with the shared store and ledger', async () => {
    // session.ts pulls in the wallet toolbox; imported here so the rest of the file stays light.
    const { finishHeld } = await import('./session');
    mem.set(PENDING_SEALS_KEY, JSON.stringify([held()]));
    const calls: unknown[][] = [];
    const ctx = {} as Parameters<typeof finishHeld>[0];
    // Held, then recorded by the recovery.
    const r1 = await finishHeld(ctx, '1c377264-aaaa', (async (api, store, documentId, ledger, lookup) => {
      calls.push([typeof api, store.list().map((p) => p.nonce), documentId, typeof ledger?.add, typeof lookup?.find]);
      store.remove('N1');
      return 1;
    }) as typeof recoverNativeSeals);
    expect(r1).toBe('finished');
    expect(calls).toEqual([['function', ['N1'], '1c377264-aaaa', 'function', 'function']]);
    mem.set(PENDING_SEALS_KEY, JSON.stringify([held()]));
    expect(await finishHeld(ctx, '1c377264-aaaa', (async () => 0) as typeof recoverNativeSeals)).toBe('still_held');
    expect(
      await finishHeld(ctx, '1c377264-aaaa', (async () => {
        throw new Error('x');
      }) as typeof recoverNativeSeals),
    ).toBe('failed');
  });
});

describe('sync with bit-sign: signed out, offline and errors in plain words', () => {
  const list = [
    row({ id: 'W1', user_handle: 'BCORP', metadata: { ndsManifest: manifest([{ id: 'a', signerHandle: 'boase' }]) } }),
  ];
  test('ok: my handles from /me/handles widen "mine"; the result is cached', async () => {
    const seen: string[] = [];
    const get = async (p: string) => {
      seen.push(p);
      return p === '/api/bitsign/signatures' ? { signatures: list } : { handles: [{ handle: 'boase' }] };
    };
    const r = await syncSigned(ME, get, 'b0asex', () => 77);
    expect(r.state).toEqual({ k: 'ok', at: 77 });
    expect(r.rows?.map((x) => [x.signatureId, x.status])).toEqual([['W1', 'waiting']]);
    expect(seen.sort()).toEqual(['/api/bitsign/me/handles', '/api/bitsign/signatures']);
    expect(loadCachedSync(ME)?.at).toBe(77);
  });
  test('a failed handles list still lists, with the session handle alone', async () => {
    const get = async (p: string) => {
      if (p.endsWith('/handles')) throw Object.assign(new Error('x'), { status: 503 });
      return { signatures: list };
    };
    expect(await fetchServerRows(get, 'boase')).toHaveLength(1);
  });
  test('signed out (no session, or a 401), offline (no answer), server trouble, an odd answer', async () => {
    expect((await syncSigned(ME, null, '')).state).toEqual({ k: 'signed_out' });
    const fail = (status: number) => async () => {
      throw Object.assign(new Error('nope'), { status });
    };
    expect((await syncSigned(ME, fail(0), 'b')).state).toEqual({ k: 'offline' });
    expect((await syncSigned(ME, fail(401), 'b')).state).toEqual({ k: 'signed_out' });
    expect((await syncSigned(ME, fail(500), 'b')).state).toEqual({
      k: 'error',
      text: 'bChatX is having trouble right now. Try again in a minute.',
    });
    expect((await syncSigned(ME, async () => ({}), 'b')).state.k).toBe('error');
    expect(syncFailure(new Error('x'), false)).toEqual({ k: 'offline' });
    // Nothing was cached by a failure.
    expect(loadCachedSync(ME)).toBeNull();
  });
  test('the notes say so plainly', () => {
    const note = (state: Parameters<typeof SyncNote>[0]['state'], cachedAt: number | null = null) =>
      renderToStaticMarkup(
        createElement(SyncNote, { state, cachedAt, onSignIn: () => undefined, onRetry: () => undefined }),
      );
    expect(note({ k: 'signed_out' })).toContain('Sign in to bChatX to see documents from your rooms');
    expect(note({ k: 'signed_out' })).toContain('>Sign in<');
    expect(note({ k: 'offline' })).toContain('You are offline. Showing what this wallet keeps.');
    expect(note({ k: 'offline' }, Date.parse('2026-11-22T09:00:00Z'))).toContain(', and the list from ');
    expect(note({ k: 'error', text: 'Boom.' })).toContain('Boom. What this wallet has sealed is still listed.');
    expect(note({ k: 'ok', at: 1 })).toBe('');
  });
});

describe('the page: copy, status checklist, and where it is mounted', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('the empty state and the live / coming checklist', () => {
    expect(EMPTY_TEXT).toBe('Nothing signed yet. Documents you sign in bChatX rooms show up here.');
    const html = renderToStaticMarkup(createElement(PageStatus));
    expect(PAGE_STATUS.filter((s) => s.live).map((s) => s.label)).toEqual([
      'Waiting for me',
      'Signed',
      'Sealed on Bitcoin, with a link to the seal',
      'Held seals: Finish',
      'Kept on this device, works offline',
    ]);
    expect(html).toContain('Search (coming)');
    expect(html).toContain('Export (coming)');
  });
  test('no dropped brand, nothing securities-flavoured', () => {
    for (const f of ['./SignedPage.tsx', './SignedParts.tsx', './SignedMenu.tsx', './signedList.ts']) {
      const s = src(f);
      expect(s).not.toMatch(/bVault/i);
      expect(s).not.toMatch(/\b(share(holder)?s?|invest(or|ment)s?|dividend|securit(y|ies))\b/i);
    }
  });
  test('☰ › Signed in the top bar every edition shares (mobile, web, extension), and the route', () => {
    const top = src('../tabs/TopNav.tsx');
    expect(top).toMatch(
      /const SignedMenuRow = SIGNED_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\.\/signed\/SignedMenu'\)/,
    );
    expect(top).toContain("navigate('/m/signed')");
    expect(top).toContain('<SignedBadgeKeeper />');
    // The same top bar in all three builds: mobile swaps it in, the extension and web builds take mobile's swaps.
    expect(src('../../../vite.config.mobile.ts')).toMatch(
      /\[resolve\(__dirname, 'src\/components\/TopNav\.tsx'\)\]: resolve\(__dirname, 'src\/mobile\/tabs\/TopNav\.tsx'\)/,
    );
    expect(src('../../../vite.config.ts')).toMatch(/\.\.\.MOBILE_SWAPS/);
    expect(src('../../../vite.config.web.ts')).toMatch(/import mobileConfig from '\.\/vite\.config\.mobile'/);
    const routes = src('../tabs/MobileRoutes.tsx');
    expect(routes).toContain('<Route path="signed" element={<SignedPage />} />');
    expect(routes).toContain('{SignedRecorder && <SignedRecorder />}');
    // The wide web layout's sidebar, with the same badge.
    expect(src('../wide/WideShell.tsx')).toMatch(
      /id: 'signed',\s*label: 'Signed',[\s\S]*?to: '\/m\/signed',\s*badge: signedBadge/,
    );
  });
  test('bWalletX only: a literal env flag, and the store grep checks its strings', () => {
    expect(src('../storeBuild.ts')).toMatch(
      /export const SIGNED_ENABLED: boolean = !\(\s*import\.meta\.env\.VITE_STORE_BUILD === '1' \|\|\s*import\.meta\.env\.VITE_CHANNEL === 'ios-store' \|\|\s*import\.meta\.env\.VITE_CHANNEL === 'android-play'\s*\);/,
    );
    const grep = src('../../../docs/STORE-AUDIT.md')
      .split('\n')
      .find((l) => l.startsWith('grep -rlE '));
    expect(grep).toContain('bwallet.signed|Held: needs recovery|Nothing signed yet');
  });
});
