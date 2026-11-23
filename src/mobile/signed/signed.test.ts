import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  nativeSignAndSeal,
  recoverNativeSeals,
  setSealRecordedHook,
  recordedCount,
  settleUnsureSeal,
  sealKey,
  type PendingSeal,
  type SealApi,
  type SealRecorded,
} from '../chat/nativeSeal';
import { SEAL_HTML, SEAL_KEY, composedFor, preparedFor } from '../chat/nativeSeal.fixtures';
import { localLedger, localStore } from '../chat/sealStore';
import { stubGlobals } from '../../testing/stubGlobals';
import {
  badgeCount,
  classifyServerRows,
  isTxid,
  mergeRows,
  rowTitle,
  rowsIn,
  shortHash,
  waitingLine,
  wocTxUrl,
  type LocalSigned,
  type ServerRow,
  type SignedRow,
} from './signedList';
import {
  SYNC_MAX_BYTES,
  addLocal,
  cacheJson,
  loadCachedSync,
  loadLocal,
  localKey,
  saveCachedSync,
  syncKey,
  type KV,
} from './localStore';
import { PENDING_SEALS_KEY, finishStoreFor, heldFor, readHeldSeals } from './held';
import { recordSeal, roomFor } from './recorder';
import { SYNC_EVERY_MS, fetchServerRows, resetSyncThrottle, syncFailure, syncSigned } from './sync';
import { BUSY_TEXT, EMPTY_TEXT, HeldBanner, PAGE_STATUS, PageStatus, SyncNote, finishText } from './SignedParts';
import { refreshSignedBadge } from './SignedMenu';
import { getSignedBadge } from './badge';

/** One in-memory storage, installed as localStorage for this file (stubGlobals puts the old one back). */
const mem = new Map<string, string>();
let full = false;
const kv: KV & { removeItem(k: string): void; clear(): void } = {
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k, v) => {
    if (full) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    mem.set(k, String(v));
  },
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
};
stubGlobals({ localStorage: kv });
afterEach(() => {
  mem.clear();
  full = false;
  setSealRecordedHook(null);
  resetSyncThrottle();
});

const TX1 = 'a1'.repeat(32);
const TX2 = 'b2'.repeat(32);
const H1 = 'c3'.repeat(32);
const H2 = 'd4'.repeat(32);
const ME = `02${'11'.repeat(32)}`;
const OTHER = `03${'22'.repeat(32)}`;

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
  complete: true,
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

describe('bit-sign rows → Signed rows', () => {
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

  test('M3: Sealed only for a SEALED_DOCUMENT row (or a real seal_txid) with nobody waiting', () => {
    const fields = manifest([{ id: 'a', signerHandle: 'b0asex' }]);
    const sealed = row({
      id: 'S1',
      signature_type: 'SEALED_DOCUMENT',
      user_handle: 'b0asex',
      txid: TX1,
      payload_hash: H1,
      metadata: { roomTicker: '$bcorp', ndsSignedFields: ['a'], ndsManifest: fields },
    });
    // A plain DOCUMENT with an inscription txid: Signed, not Sealed (reviewer probe 561).
    const inscribed = row({
      id: 'D1',
      user_handle: 'b0asex',
      txid: TX2,
      metadata: {
        ndsSignedFields: ['a'],
        ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], {
          documentRef: 'OTHER-1',
          documentTitle: 'Inscribed',
        }),
      },
    });
    // …unless it carries a real seal_txid.
    const withSeal = row({
      id: 'D2',
      user_handle: 'b0asex',
      txid: TX2,
      seal_txid: TX2,
      metadata: {
        ndsSignedFields: ['a'],
        ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], {
          documentRef: 'OTHER-2',
          documentTitle: 'With seal',
        }),
      },
    });
    // A sealed copy where another party still signs: Signed, waiting for them, never Sealed.
    const waitingOthers = row({
      id: 'S2',
      signature_type: 'SEALED_DOCUMENT',
      user_handle: 'b0asex',
      txid: TX1,
      metadata: {
        ndsSignedFields: ['a'],
        ndsManifest: manifest(
          [
            { id: 'a', signerHandle: 'b0asex' },
            { id: 'b', signerHandle: 'bailey' },
          ],
          { documentRef: 'CN-1', documentTitle: 'Custody note' },
        ),
      },
    });
    // Complete with a `pending-…` txid: Signed (not on chain).
    const offchain = row({
      id: 'S3',
      signature_type: 'SEALED_DOCUMENT',
      user_handle: 'b0asex',
      txid: 'pending-1',
      metadata: {
        ndsComplete: true,
        ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], {
          documentRef: 'M-002',
          documentTitle: 'Minute 002',
        }),
      },
    });
    const by = Object.fromEntries(
      classifyServerRows([sealed, inscribed, withSeal, waitingOthers, offchain], ['b0asex']).map((r) => [
        r.signatureId,
        r,
      ]),
    );
    expect(by.S1).toMatchObject({ status: 'sealed', sealTxid: TX1, room: 'BCORP', docHash: H1 });
    expect(by.D1).toMatchObject({ status: 'signed', sealTxid: null });
    expect(by.D2).toMatchObject({ status: 'sealed', sealTxid: TX2 });
    expect(by.S2).toMatchObject({ status: 'signed', others: true, waitingOn: ['bailey'] });
    expect(waitingLine(by.S2)).toBe('Waiting for $bailey');
    expect(by.S3).toMatchObject({ status: 'signed', sealTxid: null });
  });

  test('one document, one row: superseded and earlier copies drop out', () => {
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

  test('not mine, files, drawn signatures, drafts / tests and archived rows are left out; long fields are cut', () => {
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
        row({
          id: 'K1',
          user_handle: 'b0asex',
          metadata: {
            ndsManifest: manifest([{ id: 'a', signerHandle: 'b0asex' }], {
              documentTitle: `Custody Note cert 012 test coins ${'x'.repeat(400)}`,
            }),
          },
        }),
      ],
      ['b0asex'],
    );
    expect(rows.map((r) => r.signatureId)).toEqual(['K1']);
    expect(rows[0].title.length).toBe(200);
  });
});

describe('merging the wallet’s own list with bit-sign’s', () => {
  test('same signature id: one row; the local title and room win, the server fills blanks and owns the status', () => {
    const out = mergeRows([local({ title: '', room: '' })], [srow({ title: 'From server', room: 'FILM' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'From server',
      room: 'FILM',
      sealTxid: TX1,
      status: 'sealed',
      source: 'both',
    });
    const mine = mergeRows([local()], [srow({ title: 'Relabelled', room: 'SCAM' })]);
    expect(mine[0]).toMatchObject({ title: 'Board minute 012', room: 'BCORP' });
  });

  test('M3: the local record never forces Sealed over the server’s status', () => {
    const out = mergeRows([local()], [srow({ status: 'signed', sealTxid: null, others: true, waitingOn: ['bailey'] })]);
    expect(out[0]).toMatchObject({ status: 'signed', sealTxid: null, others: true });
  });

  test('probe 561: a server row that only shares the doc hash never relabels a record with its own signature id', () => {
    const evil = classifyServerRows(
      [
        row({
          id: 'evil',
          signature_type: 'SEALED_DOCUMENT',
          payload_hash: H1,
          user_handle: 'me',
          txid: TX2,
          metadata: { title: 'Evil title', roomTicker: 'SCAM' },
        }),
      ],
      ['me'],
    );
    const out = mergeRows([local({ signatureId: 'loc' })], evil);
    expect(out.find((r) => r.signatureId === 'loc')).toMatchObject({
      title: 'Board minute 012',
      room: 'BCORP',
      source: 'local',
    });
    // A record with no signature id matches by hash, and still keeps its own title and room.
    const byHash = mergeRows(
      [local({ signatureId: '' })],
      [srow({ signatureId: 'S9', key: 'S9', title: 'X', room: 'Y' })],
    );
    expect(byHash).toHaveLength(1);
    expect(byHash[0]).toMatchObject({ signatureId: 'S9', title: 'Board minute 012', room: 'BCORP', source: 'both' });
  });

  test('local rows survive the server losing them; complete:false is Waiting for others, not Sealed', () => {
    const out = mergeRows(
      [local(), local({ signatureId: 'SIG2', documentId: 'DOC2', docHash: H2, sealTxid: TX2, complete: false, at: 1 })],
      [],
    );
    expect(out.map((r) => [r.signatureId, r.status, r.source, waitingLine(r)])).toEqual([
      ['SIG1', 'sealed', 'local', ''],
      ['SIG2', 'signed', 'local', 'Waiting for others'],
    ]);
  });

  test('L4: a waiting row is dropped only when this wallet sealed the WHOLE document', () => {
    const waiting = srow({
      key: 'DOC1',
      signatureId: 'DOC1',
      documentId: 'DOC1',
      status: 'waiting',
      sealTxid: null,
      docHash: '',
    });
    // One block of mine sealed (complete:false): another block of mine may still wait, so the row stays.
    expect(
      mergeRows([local({ signatureId: 'S9', docHash: H2, complete: false })], [waiting]).some(
        (r) => r.signatureId === 'DOC1',
      ),
    ).toBe(true);
    expect(
      mergeRows([local({ signatureId: 'S9', docHash: H2, complete: true })], [waiting]).some(
        (r) => r.signatureId === 'DOC1',
      ),
    ).toBe(false);
  });

  test('tabs and the badge: waiting rows plus held documents', () => {
    const rows = mergeRows(
      [local()],
      [srow({ key: 'W', signatureId: 'W', documentId: 'W', status: 'waiting', sealTxid: null, docHash: '' })],
    );
    expect(rowsIn(rows, 'waiting').map((r) => r.signatureId)).toEqual(['W']);
    expect(rowsIn(rows, 'sealed').map((r) => r.signatureId)).toEqual(['SIG1']);
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
  });
});

describe('the wallet-local list: per identity key, bounded, never in the seal’s way', () => {
  test('add, update by signature id (blanks never overwrite), kept apart per identity key', () => {
    addLocal(ME, local({ title: 'First', room: '' }));
    addLocal(ME, local({ title: '', room: 'BCORP', sealTxid: '' }));
    addLocal(OTHER, local({ signatureId: 'OTHER' }));
    const mine = loadLocal(ME);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'First', room: 'BCORP', sealTxid: TX1 });
    expect(loadLocal(OTHER).map((l) => l.signatureId)).toEqual(['OTHER']);
    expect(localKey(ME)).toBe(`bwallet.signed.${ME}`);
  });
  test('M5 (probe 561): title ≤ 200, room ≤ 32, ids ≤ 128; bad hashes and txids never stored', () => {
    addLocal(
      ME,
      local({
        title: 'x'.repeat(1_000_000),
        room: 'R'.repeat(99),
        signatureId: 's'.repeat(999),
        documentId: 'd'.repeat(999),
        docHash: 'zz',
        sealTxid: 'pending-1',
      }),
    );
    const [r] = loadLocal(ME);
    expect([r.title.length, r.room.length, r.signatureId.length, r.documentId.length, r.docHash, r.sealTxid]).toEqual([
      200,
      32,
      128,
      128,
      '',
      '',
    ]);
    expect(mem.get(localKey(ME))!.length).toBeLessThan(1000);
    mem.set(localKey(ME), '{not json');
    expect(loadLocal(ME)).toEqual([]);
  });
  test('M5: the sync cache stays under 128 KB, newest rows kept', () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      srow({ key: `K${i}`, signatureId: `K${i}`, title: 't'.repeat(200), at: i }),
    );
    const json = cacheJson(many, 5);
    expect(json.length).toBeLessThanOrEqual(SYNC_MAX_BYTES);
    const kept = JSON.parse(json).rows as SignedRow[];
    expect(kept[0].signatureId).toBe('K1999');
    saveCachedSync(ME, many, 5);
    expect(mem.get(syncKey(ME))!.length).toBeLessThanOrEqual(SYNC_MAX_BYTES);
  });
  test('M5: on a quota error the sync cache is dropped first; nothing throws', () => {
    saveCachedSync(ME, [srow()], 5);
    expect(mem.has(syncKey(ME))).toBe(true);
    full = true;
    expect(() => addLocal(ME, local())).not.toThrow();
    expect(mem.has(syncKey(ME))).toBe(false);
    expect(() => saveCachedSync(ME, [srow()], 6)).not.toThrow();
  });
});

describe('the recorder: every seal this device records lands in the list', () => {
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
  test('L3: the room is the seal’s own ticker, else a row already known for the document; never the open screen', () => {
    expect(roomFor({ documentId: 'DOC1', ticker: '$bcorp' }, ME)).toBe('BCORP');
    expect(roomFor({ documentId: 'DOC1' }, ME)).toBe('');
    saveCachedSync(ME, [srow({ room: 'FILM' })], 1);
    expect(roomFor({ documentId: 'DOC1' }, ME)).toBe('FILM');
  });
  test('L3: a seal with no identity key is filed under no account', () => {
    recordSeal(rec({ identityKey: '' }), { now: () => 1234 });
    expect(mem.size).toBe(0);
    recordSeal(rec(), { now: () => 1234 });
    expect(loadLocal(ME)).toEqual([
      {
        signatureId: 'SIG1',
        documentId: 'DOC1',
        docHash: H1,
        sealTxid: TX1,
        room: '',
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
    const store = localStore(kv);
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
    expect(
      recordedCount(await recoverNativeSeals(api, store, 'DOC1', localLedger(kv), undefined, { identityKey: ME })),
    ).toBe(1);
    expect(got).toEqual([
      { documentId: 'DOC1', identityKey: ME, title: '', signatureId: 'SIG1', txid: TX1, docHash: H1, complete: false },
    ]);
    expect(readHeldSeals(kv)).toEqual([]);
  });
});

describe('the room comes from the seal flow’s ticker (#560)', () => {
  test('a recovered held record carrying its ticker files the seal under that room', async () => {
    const { installSignedRecorder } = await import('./recorder');
    installSignedRecorder();
    const store = localStore(kv);
    store.save({
      documentId: 'DOC7',
      nonce: 'N7',
      txid: TX1,
      beefHex: '0909',
      attestation: 'ab',
      savedAt: 1,
      identityKey: ME,
      ticker: 'bcorp',
    } as PendingSeal);
    const api: SealApi = async () => ({
      ok: true,
      status: 200,
      body: { signatureId: 'SIG7', txid: TX1, docHash: H1, complete: true },
    });
    await recoverNativeSeals(api, store, 'DOC7', localLedger(kv), undefined, { identityKey: ME });
    expect(loadLocal(ME).find((l) => l.signatureId === 'SIG7')?.room).toBe('BCORP');
  });
});

describe('the hook on the on-screen settle path (#560 settleUnsureSeal)', () => {
  test('a held payment recorded while the page settles it lands in the list too', async () => {
    const got: SealRecorded[] = [];
    setSealRecordedHook((s) => got.push(s));
    const store = localStore(kv);
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
      body: { signatureId: 'SIG1', txid: TX1, docHash: H1, complete: true },
    });
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: 'N1',
      ledger: localLedger(kv),
      sleep: async () => undefined,
      delaysMs: [0],
    });
    expect(r.k).toBe('recorded');
    expect(got.map((g) => [g.documentId, g.signatureId, g.identityKey])).toEqual([['DOC1', 'SIG1', ME]]);
  });
});

const NOW = Date.parse('2026-11-23T12:00:00Z');
const held = (o: Partial<PendingSeal> = {}): PendingSeal => ({
  documentId: '1c377264-aaaa',
  nonce: 'N1',
  txid: TX1,
  beefHex: '0909',
  attestation: 'ab',
  savedAt: NOW - 60 * 60_000,
  identityKey: ME,
  fieldIds: ['f1'],
  ...o,
});
/** An unsure record the wallet already answered "no such action" for once, 10 s ago (#560's release rule needs two). */
const ONE_NOT_FOUND = { notFound: 1, notFoundFirstAt: NOW - 10_000, notFoundLastAt: NOW - 10_000 };
const setHeld = (list: unknown[]) => mem.set(PENDING_SEALS_KEY, JSON.stringify(list));
const stored = () => JSON.parse(mem.get(PENDING_SEALS_KEY) || '[]') as Array<Record<string, unknown>>;

describe('held seals: listing, and the store Finish hands to recovery', () => {
  test('L6 (probe 561): only this identity’s records; a key-less record shows for nobody', () => {
    setHeld([
      held(),
      held({ nonce: 'N2', identityKey: OTHER }),
      held({ nonce: 'N3', identityKey: undefined }),
      { junk: true },
    ]);
    expect(heldFor(ME, readHeldSeals(kv)).map((p) => p.nonce)).toEqual(['N1']);
    expect(heldFor(OTHER, readHeldSeals(kv)).map((p) => p.nonce)).toEqual(['N2']);
    expect(heldFor(ME, [held({ identityKey: undefined })])).toEqual([]);
  });

  test('L1 (probe 561): writing through Finish’s store keeps malformed and unknown entries untouched', () => {
    const odd = { documentId: 5, nonce: 'odd', beefHex: 'x' };
    setHeld([odd, held(), held({ nonce: 'N2', identityKey: OTHER, drawing: 'M 0 0' } as Partial<PendingSeal>)]);
    const view = finishStoreFor(ME, '1c377264-aaaa', NOW, localStore(kv));
    view.remove('N1');
    expect(stored()).toEqual([odd, { ...held({ nonce: 'N2', identityKey: OTHER }), drawing: 'M 0 0' }]);
  });

  test('H1: the view lists only this identity’s records for this document; nothing another page or window is handling', () => {
    setHeld([
      held(),
      held({ nonce: 'N2', identityKey: OTHER }),
      held({ nonce: 'N3', identityKey: undefined }),
      held({ nonce: 'N4', documentId: 'other-doc' }),
      // Being settled on screen by a live page: its.
      held({
        nonce: 'N5',
        fieldIds: ['f5'],
        txid: '',
        beefHex: '',
        settling: { by: 'another-page', until: NOW + 30_000 },
      }),
      // A stale settling mark: Finish may take it.
      held({ nonce: 'N6', fieldIds: ['f6'], txid: '', beefHex: '', settling: { by: 'another-page', until: NOW - 1 } }),
      // A kept seal another window is paying (a live claim by another context).
      held({ nonce: 'N7', fieldIds: ['f7'] }),
    ]);
    localStore(kv).claims!.save({
      key: sealKey(ME, '1c377264-aaaa', ['f7']),
      by: 'another-window',
      at: NOW,
      until: NOW + 60_000,
    });
    expect(
      finishStoreFor(ME, '1c377264-aaaa', NOW, localStore(kv))
        .list()
        .map((p) => p.nonce),
    ).toEqual(['N1', 'N6']);
  });

  test('probe 561: recovery through the view never touches another account’s seal (404 not_yours, unsure lookups)', async () => {
    setHeld([held({ nonce: 'nA' }), held({ nonce: 'nB', identityKey: OTHER, txid: TX2 })]);
    const calls: string[] = [];
    const api: SealApi = async (path, body) => {
      calls.push(`${path}:${String(body.nonce)}`);
      if (body.nonce === 'nB') return { ok: false, status: 404, body: { code: 'not_yours' } };
      return { ok: true, status: 200, body: { signatureId: 's', txid: body.txid, docHash: H1 } };
    };
    await recoverNativeSeals(
      api,
      finishStoreFor(ME, '1c377264-aaaa', NOW, localStore(kv)),
      '1c377264-aaaa',
      localLedger(kv),
      undefined,
      { identityKey: ME, now: () => NOW },
    );
    expect(calls).toEqual(['recover:nA']);
    expect(readHeldSeals(kv).map((p) => p.nonce)).toEqual(['nB']);

    setHeld([
      held({ nonce: 'uA', txid: '', beefHex: '', lockingScriptHex: '00', ...ONE_NOT_FOUND }),
      held({ nonce: 'uB', identityKey: OTHER, txid: '', beefHex: '', lockingScriptHex: '01', ...ONE_NOT_FOUND }),
    ]);
    calls.length = 0;
    await recoverNativeSeals(
      api,
      finishStoreFor(ME, '1c377264-aaaa', NOW, localStore(kv)),
      '1c377264-aaaa',
      localLedger(kv),
      {
        find: async () => ({ found: false }),
        beef: async () => null,
      },
      { identityKey: ME, now: () => NOW },
    );
    expect(calls).toEqual(['cancel:uA']);
    expect(readHeldSeals(kv).map((p) => p.nonce)).toEqual(['uB']);
  });
});

describe('Finish: true outcomes, never an auth failure as done, never across accounts', () => {
  type Deps = Parameters<typeof import('./session').finishHeldWith>[1];
  const ADDR = '1Me';
  const deps = (
    o: Partial<Deps> & {
      replies?: (
        path: string,
        body: Record<string, unknown>,
      ) => { ok: boolean; status: number; body: Record<string, unknown> };
    } = {},
  ) => {
    let cleared = 0;
    const calls: string[] = [];
    const d: Deps = {
      identityKey: ME,
      account: ADDR,
      chatAccount: () => ADDR,
      session: () => ({ token: 't', handle: 'b0asex', address: 'a', account: ADDR }),
      clearSession: () => void cleared++,
      post: async (path, body) => {
        calls.push(`${path}:${String(body.nonce)}`);
        return (
          o.replies?.(path, body) ?? { ok: true, status: 200, body: { signatureId: 'S', txid: body.txid, docHash: H1 } }
        );
      },
      check: async () => 200,
      store: localStore(kv),
      ledger: localLedger(kv),
      now: () => NOW,
      ...o,
    };
    return { d, calls, cleared: () => cleared };
  };
  const finish = async (d: Deps) => (await import('./session')).finishHeldWith('1c377264-aaaa', d);

  test('M1: recorded only when bit-sign recorded it', async () => {
    setHeld([held()]);
    const { d, calls } = deps();
    expect(await finish(d)).toEqual({ k: 'recorded' });
    expect(calls).toEqual(['recover:N1']);
    expect(readHeldSeals(kv)).toEqual([]);
  });

  test('M1: released (never built: nothing paid), kept (in progress), refused (with the reason), orphaned', async () => {
    setHeld([held({ txid: '', beefHex: '', lockingScriptHex: '00', ...ONE_NOT_FOUND })]);
    const r1 = deps({ lookup: { find: async () => ({ found: false }), beef: async () => null } });
    expect(await finish(r1.d)).toEqual({ k: 'released' });
    expect(finishText({ k: 'released' })).toBe('Nothing was paid; you can seal again.');

    setHeld([held()]);
    const r2 = deps({ replies: () => ({ ok: false, status: 429, body: { code: 'commit_in_progress' } }) });
    expect(await finish(r2.d)).toEqual({ k: 'kept' });
    expect(readHeldSeals(kv)).toHaveLength(1);
    expect(finishText({ k: 'kept' })).toStartWith('Still checking');

    setHeld([held()]);
    const r3 = deps({ replies: () => ({ ok: false, status: 409, body: { error: 'The session was cancelled.' } }) });
    expect(await finish(r3.d)).toEqual({
      k: 'refused',
      reason: `Paid, but bChatX wouldn't record it. Contact support (ref seal-N1). bChatX said: The session was cancelled.`,
    });

    setHeld([held()]);
    const r4 = deps({
      replies: () => ({ ok: true, status: 200, body: { orphaned: true, message: 'Another party sealed it first.' } }),
    });
    expect(await finish(r4.d)).toEqual({ k: 'orphaned' });
    expect(finishText({ k: 'orphaned' })).toContain('Your payment is recorded');

    // The first "no such action" answer only counts: kept, never released on one look (#560's release rule).
    setHeld([held({ txid: '', beefHex: '', lockingScriptHex: '00' })]);
    const r5 = deps({ lookup: { find: async () => ({ found: false }), beef: async () => null } });
    expect(await finish(r5.d)).toEqual({ k: 'kept' });
    expect(r5.calls).toEqual([]);
  });

  test('H2 / N1: only a 401 means the session is bad (cleared, Sign in); the held seal is never erased', async () => {
    setHeld([held()]);
    const a = deps({ check: async () => 401 });
    expect(await finish(a.d)).toEqual({ k: 'sign_in' });
    expect(a.calls).toEqual([]);
    expect(a.cleared()).toBe(1);
    // A 401 on the seal route itself: kept, session cleared, Sign in asked.
    setHeld([held()]);
    const b = deps({ replies: () => ({ ok: false, status: 401, body: { error: 'Unauthorized' } }) });
    expect(await finish(b.d)).toEqual({ k: 'sign_in' });
    expect(readHeldSeals(kv).map((p) => p.nonce)).toEqual(['N1']);
    expect(b.cleared()).toBe(1);
    // No session at all: Sign in, nothing sent.
    setHeld([held()]);
    const c = deps({ session: () => null });
    expect(await finish(c.d)).toEqual({ k: 'sign_in' });
    expect(c.calls).toEqual([]);
    expect(finishText({ k: 'sign_in' })).toBe('Sign in to bChatX to finish this.');
  });

  test('N1 (probe 561b): 403 or 404 not_yours: a seal for another handle; the proven session stays, the seal stays', async () => {
    for (const reply of [
      { ok: false, status: 403, body: { error: 'Key not linked' } },
      { ok: false, status: 404, body: { code: 'not_yours' } },
    ]) {
      setHeld([held()]);
      const b = deps({ replies: () => reply });
      expect(await finish(b.d)).toEqual({ k: 'wrong_handle', handle: 'b0asex' });
      expect(readHeldSeals(kv).map((p) => p.nonce)).toEqual(['N1']);
      expect(b.cleared()).toBe(0);
    }
    expect(finishText({ k: 'wrong_handle', handle: 'b0asex' })).toBe(
      "bChatX doesn't know this seal for the handle you're signed in as ($b0asex). It stays held. Sign in as the handle that sealed it.",
    );
    // A 403 on the session check is not "signed out" either: Finish goes on.
    setHeld([held()]);
    const c = deps({ check: async () => 403 });
    expect(await finish(c.d)).toEqual({ k: 'recorded' });
    expect(c.cleared()).toBe(0);
    // Every record of another account or with no key is untouched, even when every answer is 404.
    setHeld([
      held({ nonce: 'nA' }),
      held({ nonce: 'nB', identityKey: OTHER }),
      held({ nonce: 'nK', identityKey: undefined }),
      held({ nonce: 'nK2', identityKey: '' }),
    ]);
    const all404 = deps({ replies: () => ({ ok: false, status: 404, body: { code: 'not_yours' } }) });
    await finish(all404.d);
    expect(all404.calls).toEqual(['recover:nA']);
    expect(
      readHeldSeals(kv)
        .map((p) => p.nonce)
        .sort(),
    ).toEqual(['nA', 'nB', 'nK', 'nK2']);
  });

  test('N2: 409 replayed says it was already recorded with an earlier payment', async () => {
    setHeld([held()]);
    const r = deps({ replies: () => ({ ok: false, status: 409, body: { code: 'replayed', error: 'replayed' } }) });
    expect(await finish(r.d)).toEqual({ k: 'replayed' });
    expect(readHeldSeals(kv)).toEqual([]);
    expect(finishText({ k: 'replayed' })).toBe("Already recorded with an earlier payment; this one wasn't needed.");
    // Any other 409 is a refusal with its reason, and the payment stays held.
    setHeld([held()]);
    const o = deps({ replies: () => ({ ok: false, status: 409, body: { code: 'not_composed', error: 'nc' } }) });
    expect(await finish(o.d)).toEqual({
      k: 'refused',
      reason: `Paid, but bChatX wouldn't record it. Contact support (ref seal-N1). bChatX said: nc`,
    });
    expect(readHeldSeals(kv)).toHaveLength(1);
  });

  test('N4: one document, one recorded and one refused: the refused one is reported, with the other counted', async () => {
    setHeld([held({ nonce: 'nA', fieldIds: ['a'] }), held({ nonce: 'nB', fieldIds: ['b'] })]);
    const m = deps({
      replies: (_p, body) =>
        body.nonce === 'nA'
          ? { ok: true, status: 200, body: { signatureId: 'S', txid: TX1, docHash: H1 } }
          : { ok: false, status: 410, body: { error: 'Too late' } },
    });
    expect(await finish(m.d)).toEqual({
      k: 'refused',
      reason: `Paid, but bChatX wouldn't record it. Contact support (ref seal-nB). bChatX said: Too late`,
      alsoRecorded: 1,
    });
    expect(readHeldSeals(kv).map((p) => p.nonce)).toEqual(['nB']);
    expect(finishText({ k: 'refused', reason: 'Too late', alsoRecorded: 1 })).toBe(
      'Too late One other seal for it was recorded.',
    );
  });

  test('L2 / N3: another account before: nothing done; a switch while it ran: say what was recorded, else that it switched', async () => {
    setHeld([held()]);
    const before = deps({ chatAccount: () => 'someone-else' });
    expect(await finish(before.d)).toEqual({ k: 'account_changed' });
    expect(before.calls).toEqual([]);
    const wrongSession = deps({ session: () => ({ token: 't', handle: 'x', address: 'a', account: 'someone-else' }) });
    expect(await finish(wrongSession.d)).toEqual({ k: 'sign_in' });
    // Switched during recovery after bit-sign recorded it: the truth is "recorded".
    let acct = ADDR;
    const during = deps({
      chatAccount: () => acct,
      replies: (_p, body) => (
        (acct = 'someone-else'),
        { ok: true, status: 200, body: { signatureId: 'S', txid: body.txid } }
      ),
    });
    expect(await finish(during.d)).toEqual({ k: 'recorded' });
    // Switched during recovery and nothing recorded: it says so, and a 401 then never clears the new account's session.
    setHeld([held()]);
    acct = ADDR;
    const lost = deps({
      chatAccount: () => acct,
      replies: () => ((acct = 'someone-else'), { ok: false, status: 401, body: {} }),
    });
    expect(await finish(lost.d)).toEqual({ k: 'account_changed' });
    expect(lost.cleared()).toBe(0);
    // Switched while the session was being checked: nothing more, nothing cleared.
    acct = ADDR;
    const checking = deps({ chatAccount: () => acct, check: async () => ((acct = 'someone-else'), 401) });
    expect(await finish(checking.d)).toEqual({ k: 'account_changed' });
    expect(checking.cleared()).toBe(0);
  });

  test('#560 refused state: the banner says Paid · contact support with the reference, and it ranks first', async () => {
    const { paidRefusedFor } = await import('./held');
    const refusedRec = held({ nonce: 'abcdef1234567890', refused: { at: NOW, status: 410, error: 'Too late' } });
    expect(paidRefusedFor('1c377264-aaaa', [held({ nonce: 'x' }), refusedRec])).toBe(
      "Paid, but bChatX wouldn't record it. Contact support (ref seal-abcdef123456).",
    );
    expect(paidRefusedFor('other', [refusedRec])).toBeNull();
    // The support list (archived refused payments) is never read as held or as signed.
    mem.set('bwx.nativeSeal.support', JSON.stringify([{ ...refusedRec, archivedAt: NOW }]));
    expect(readHeldSeals(kv)).toEqual([]);
    expect(loadLocal(ME)).toEqual([]);
    refreshSignedBadge(ME);
    expect(getSignedBadge()).toBe(0);
    mem.delete('bwx.nativeSeal.support');
    // A kept drawing from a paid seal (#560 paidRef) is never read here: not held, not signed, not "nothing paid".
    mem.set(
      'bwx.nativeSeal.drawings',
      JSON.stringify([
        {
          key: 'k',
          documentId: '1c377264-aaaa',
          identityKey: ME,
          fieldIds: ['f1'],
          svg: '<svg/>',
          savedAt: NOW,
          paidRef: 'seal-abcdef123456',
        },
      ]),
    );
    expect(readHeldSeals(kv)).toEqual([]);
    refreshSignedBadge(ME);
    expect(getSignedBadge()).toBe(0);
    mem.delete('bwx.nativeSeal.drawings');
    const html = renderToStaticMarkup(
      createElement(HeldBanner, {
        held: [refusedRec],
        titleOf: () => 'Doc',
        onFinish: () => undefined,
        states: {},
        refusedText: (id: string) => paidRefusedFor(id, [refusedRec]),
      }),
    );
    expect(html).toContain('Contact support (ref seal-abcdef123456)');
    expect(html).not.toContain('Still checking');
    // Mixed answers: a refused record outranks one still being checked (kept) and one never built.
    setHeld([held({ nonce: 'nA', fieldIds: ['a'] }), held({ nonce: 'nB', fieldIds: ['b'] })]);
    const m = deps({
      replies: (_p, body) =>
        body.nonce === 'nA'
          ? { ok: false, status: 503, body: { error: 'busy' } }
          : { ok: false, status: 410, body: { error: 'Too late' } },
    });
    expect((await finish(m.d)).k).toBe('refused');
  });

  test('two taps at once share one Finish', async () => {
    setHeld([held()]);
    let n = 0;
    const r = deps({
      replies: () => (n++, { ok: true, status: 200, body: { signatureId: 'S', txid: TX1 } }),
    });
    const [a, b] = await Promise.all([finish(r.d), finish(r.d)]);
    expect([a, b, n]).toEqual([{ k: 'recorded' }, { k: 'recorded' }, 1]);
  });

  test('N5: a settling mark or claim further ahead than its lifetime + 30 s is stale (clock moved back, bad data)', async () => {
    const { busyElsewhere } = await import('./held');
    const st = localStore(kv);
    expect(busyElsewhere(held({ settling: { by: 'x', until: NOW + 80_000 } }), st, NOW)).toBe(true);
    expect(busyElsewhere(held({ settling: { by: 'x', until: NOW + 365 * 864e5 } }), st, NOW)).toBe(false);
    st.claims!.save({ key: sealKey(ME, '1c377264-aaaa', ['f1']), by: 'other', at: NOW, until: NOW + 365 * 864e5 });
    expect(busyElsewhere(held(), st, NOW)).toBe(false);
    st.claims!.save({ key: sealKey(ME, '1c377264-aaaa', ['f1']), by: 'other', at: NOW, until: NOW + 60_000 });
    expect(busyElsewhere(held(), st, NOW)).toBe(true);
    // A live paying mark (another context is in createAction for it): busy; a stale one is not.
    expect(
      busyElsewhere(held({ fieldIds: ['p1'], paying: { by: 'x', at: NOW, until: NOW + 60_000 } }), localStore(kv), NOW),
    ).toBe(true);
    expect(
      busyElsewhere(
        held({ fieldIds: ['p1'], paying: { by: 'x', at: NOW - 10 * 60_000, until: NOW - 1 } }),
        localStore(kv),
        NOW,
      ),
    ).toBe(false);
    // A claim whose heartbeat stopped (#560: CLAIM_STALE_MS) belongs to a context that crashed or slept: not busy.
    st.claims!.save({ key: sealKey(ME, '1c377264-aaaa', ['f1']), by: 'other', at: NOW - 60_000, until: NOW + 60_000 });
    expect(busyElsewhere(held(), st, NOW)).toBe(false);
    st.claims!.save({ key: sealKey(ME, '1c377264-aaaa', ['f1']), by: 'other', at: NOW, until: NOW + 60_000 });
    expect(busyElsewhere(held(), st, NOW)).toBe(true);
  });

  test('M2: a seal another page is settling, or another window is paying, is left alone; offline says so', async () => {
    setHeld([held({ settling: { by: 'another-page', until: NOW + 30_000 } })]);
    const y = deps();
    expect(await finish(y.d)).toEqual({ k: 'kept' });
    expect(y.calls).toEqual([]);
    setHeld([held()]);
    localStore(kv).claims!.save({
      key: sealKey(ME, '1c377264-aaaa', ['f1']),
      by: 'another-window',
      at: NOW,
      until: NOW + 60_000,
    });
    const c = deps();
    expect(await finish(c.d)).toEqual({ k: 'kept' });
    expect(c.calls).toEqual([]);
    mem.delete('bwx.nativeSeal.claims');
    expect(await finish(deps({ check: async () => 0 }).d)).toEqual({ k: 'offline' });
  });

  test('Finish passes this identity key to recovery, never keyless', async () => {
    setHeld([held()]);
    const seen: unknown[] = [];
    const { d } = deps({
      recover: (async (...args: Parameters<typeof recoverNativeSeals>) => {
        seen.push(args[5]);
        return [];
      }) as typeof recoverNativeSeals,
    });
    expect(await finish(d)).toEqual({ k: 'kept' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ identityKey: ME });
    expect((seen[0] as { keyless?: boolean }).keyless).toBeUndefined();
  });

  test('the banner: one line per document, Finish, Sign in after an auth refusal, busy ones wait', () => {
    const html = renderToStaticMarkup(
      createElement(HeldBanner, {
        held: [
          held(),
          held({ nonce: 'N2' }),
          held({ documentId: 'other', nonce: 'N3' }),
          held({ documentId: 'busy', nonce: 'N4' }),
        ],
        titleOf: (id: string) => `Doc ${id}`,
        onFinish: () => undefined,
        onSignIn: () => undefined,
        states: { other: { k: 'sign_in' } },
        busy: new Set(['busy']),
      }),
    );
    expect(html).toContain('Held: needs recovery');
    expect(html.match(/>Finish</g)).toHaveLength(2);
    expect(html.match(/>Sign in</g)).toHaveLength(1);
    expect(html).toContain(BUSY_TEXT);
    expect(html).toContain('Doc 1c377264-aaaa');
    expect(
      renderToStaticMarkup(
        createElement(HeldBanner, { held: [], titleOf: String, onFinish: () => undefined, states: {} }),
      ),
    ).toBe('');
  });

  test('the wiring: Finish passes the identity key and the account to finishHeldWith (session.ts)', () => {
    const src = readFileSync(new URL('./session.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/finishHeldWith\(documentId, \{\s*identityKey,\s*account,\s*chatAccount: getChatAccount,/);
    const page = readFileSync(new URL('./SignedPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('finishHeld(apiContext, documentId, identityKey, identityAddress)');
  });

  test('the badge counts this account’s held documents, never key-less ones', () => {
    setHeld([held(), held({ nonce: 'N2' }), held({ nonce: 'N3', identityKey: undefined, documentId: 'legacy' })]);
    refreshSignedBadge(ME);
    expect(getSignedBadge()).toBe(1);
    refreshSignedBadge('');
    expect(getSignedBadge()).toBe(0);
  });
});

describe('sync with bit-sign: throttled, shared, and plain about failures', () => {
  const list = [
    row({ id: 'W1', user_handle: 'BCORP', metadata: { ndsManifest: manifest([{ id: 'a', signerHandle: 'boase' }]) } }),
  ];
  const okGet =
    (seen: string[] = []) =>
    async (p: string) => {
      seen.push(p);
      return p === '/api/bitsign/signatures' ? { signatures: list } : { handles: [{ handle: 'boase' }] };
    };
  test('ok: my handles from /me/handles widen "mine"; the result is cached', async () => {
    const seen: string[] = [];
    const r = await syncSigned(ME, okGet(seen), 'b0asex', { now: () => 77 });
    expect(r.state).toEqual({ k: 'ok', at: 77 });
    expect(r.rows?.map((x) => [x.signatureId, x.status])).toEqual([['W1', 'waiting']]);
    expect(seen.sort()).toEqual(['/api/bitsign/me/handles', '/api/bitsign/signatures']);
    expect(loadCachedSync(ME)?.at).toBe(77);
  });
  test('M4: one request per 5 minutes, failures included; concurrent callers share one; a tap may force', async () => {
    let n = 0;
    let t = 1_000_000;
    const failing = async (p: string) => {
      if (p.endsWith('/signatures')) n++;
      throw Object.assign(new Error('x'), { status: 500 });
    };
    expect((await syncSigned(ME, failing, 'b', { now: () => t })).state.k).toBe('error');
    t += 60_000;
    const again = await syncSigned(ME, failing, 'b', { now: () => t });
    expect(again).toEqual({
      state: { k: 'error', text: 'bChatX is having trouble right now. Try again in a minute.' },
      rows: null,
    });
    expect(n).toBe(1);
    t += SYNC_EVERY_MS;
    let release = () => undefined as void;
    const slow = async (p: string) => {
      if (p.endsWith('/signatures')) {
        n++;
        await new Promise<void>((r) => (release = r));
      }
      return { signatures: [] };
    };
    const a = syncSigned(ME, slow, 'b', { now: () => t });
    const b = syncSigned(ME, slow, 'b', { now: () => t, force: true });
    expect(b).toBe(a);
    release();
    await a;
    expect(n).toBe(2); // the failure, then one shared list request
    expect((await syncSigned(ME, okGet(), 'b', { now: () => t, force: true })).state.k).toBe('ok');
  });
  test('L2: a list fetched while the account switched is thrown away, never cached as this account’s', async () => {
    let acct = '1Me';
    const get = async (p: string) => {
      if (p.endsWith('/signatures')) acct = '1Other';
      return p.endsWith('/signatures') ? { signatures: list } : { handles: [] };
    };
    const r = await syncSigned(ME, get, 'boase', { force: true, account: { account: '1Me', chatAccount: () => acct } });
    expect(r).toEqual({ state: { k: 'idle' }, rows: null });
    expect(loadCachedSync(ME)).toBeNull();
    // Another account current from the start: no request at all.
    let asked = 0;
    const r2 = await syncSigned(ME, async () => (asked++, {}), 'boase', {
      force: true,
      account: { account: '1Me', chatAccount: () => '1Other' },
    });
    expect([r2.rows, asked]).toEqual([null, 0]);
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
    expect((await syncSigned(ME, fail(0), 'b', { force: true })).state).toEqual({ k: 'offline' });
    expect((await syncSigned(ME, fail(401), 'b', { force: true })).state).toEqual({ k: 'signed_out' });
    expect((await syncSigned(ME, async () => ({}), 'b', { force: true })).state.k).toBe('error');
    expect(syncFailure(new Error('x'), false)).toEqual({ k: 'offline' });
    expect(loadCachedSync(ME)).toBeNull();
  });
  test('the notes say so plainly', () => {
    const note = (state: Parameters<typeof SyncNote>[0]['state'], cachedAt: number | null = null) =>
      renderToStaticMarkup(
        createElement(SyncNote, { state, cachedAt, onSignIn: () => undefined, onRetry: () => undefined }),
      );
    expect(note({ k: 'signed_out' })).toContain('Sign in to bChatX to see documents from your rooms');
    expect(note({ k: 'offline' })).toContain('You are offline. Showing what this wallet keeps.');
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
    for (const f of ['./SignedPage.tsx', './SignedParts.tsx', './SignedMenu.tsx', './signedList.ts', './session.ts']) {
      const s = src(f);
      expect(s).not.toMatch(/bVault/i);
      expect(s).not.toMatch(/\b(share(holder)?s?|invest(or|ment)s?|dividend|securit(y|ies))\b/i);
    }
  });
  test('L5: the page says when it may sign in (only on a tap)', () => {
    expect(src('./SignedPage.tsx')).toContain("only on the user's tap");
    expect(src('./session.ts')).toContain('Finish never signs in by itself');
  });
  test('☰ › Signed in the top bar every edition shares (mobile, web, extension), and the route', () => {
    const top = src('../tabs/TopNav.tsx');
    expect(top).toMatch(
      /const SignedMenuRow = SIGNED_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\.\/signed\/SignedMenu'\)/,
    );
    expect(top).toContain("navigate('/m/signed')");
    expect(top).toContain('<SignedBadgeKeeper />');
    expect(src('../../../vite.config.mobile.ts')).toMatch(
      /\[resolve\(__dirname, 'src\/components\/TopNav\.tsx'\)\]: resolve\(__dirname, 'src\/mobile\/tabs\/TopNav\.tsx'\)/,
    );
    expect(src('../../../vite.config.ts')).toMatch(/\.\.\.MOBILE_SWAPS/);
    expect(src('../../../vite.config.web.ts')).toMatch(/import mobileConfig from '\.\/vite\.config\.mobile'/);
    const routes = src('../tabs/MobileRoutes.tsx');
    expect(routes).toContain('<Route path="signed" element={<SignedPage />} />');
    expect(routes).toContain('{SignedRecorder && <SignedRecorder />}');
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
