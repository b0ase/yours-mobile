import { describe, expect, test } from 'bun:test';
import {
  classifyServerRows,
  classifyVaultItem,
  isDraftOrTest,
  latestGenerations,
  vaultBuckets,
  type ServerRow,
  type VaultBucket,
} from './signedList';

/**
 * bit-sign's vault-status-selftest.mts, case for case, against the wallet's port (signedList.ts). bit-sign and the
 * wallet must put every row in the same pile; if bit-sign changes its rules, port the change and the case here.
 * (Not ported, because the wallet doesn't show them: minute numbers, chips, nameWithPrimary.)
 */
const TX = 'b'.repeat(64);
const ME = ['b0asex', 'boase'];
const man = (ref: string, title: string, fields: Array<[string, string | null]>) => ({
  documentRef: ref,
  documentTitle: title,
  signatureFields: fields.map(([id, h]) => ({ id, signerHandle: h, required: true })),
});
const row = (
  id: string,
  signature_type: string,
  metadata: Record<string, unknown>,
  extra: Partial<ServerRow> = {},
): ServerRow => ({
  id,
  signature_type,
  txid: 'pending-x',
  created_at: '2026-10-01T10:00:00Z',
  user_handle: 'b0asex',
  metadata,
  ...extra,
});
const cls = (r: ServerRow, byId?: Map<string, ServerRow>) => classifyVaultItem(r, ME, byId);
const counts = (st: Map<string, { bucket: VaultBucket; earlierCopy: boolean }>) => {
  const c: Record<string, number> = { to_sign: 0, waiting: 0, signed_offchain: 0, signed: 0, files: 0, drafts: 0 };
  for (const s of st.values()) if (!s.earlierCopy && s.bucket !== 'other') c[s.bucket]++;
  return c;
};

describe('vault-status selftest (bit-sign), mirrored', () => {
  test('drafts & tests: whole words, written as a label', () => {
    expect(
      isDraftOrTest('Investor-Confirmation-Connor-PRACTICE') &&
        isDraftOrTest('SIGNING-TEST-2026-11-02') &&
        isDraftOrTest('US-Investor-Letter-Connor-DRAFT-v2'),
    ).toBe(true);
    expect(isDraftOrTest('Token Sale Agreement — draft.html')).toBe(true);
    expect(
      isDraftOrTest('Practice_Doc_A.html') && isDraftOrTest('a-TEST-b') && isDraftOrTest('contract_test.html'),
    ).toBe(true);
    expect(isDraftOrTest('Custody Note — cert 012 test coins')).toBe(false);
    expect(isDraftOrTest('Custody_Note_cert_012_test_coins.html')).toBe(false);
    expect(isDraftOrTest('Custody Note — cert 012 test coins — signed by $boase.html')).toBe(false);
    expect(isDraftOrTest('a-test-b')).toBe(false);
    expect(isDraftOrTest('CUSTODY NOTE — CERT 012 TEST COINS')).toBe(false);
    expect(isDraftOrTest('CUSTODY NOTE (TEST)')).toBe(true);
    expect(isDraftOrTest('test-contract.pdf') && isDraftOrTest('Draft')).toBe(true);
    for (const t of ['signing testing notes', 'Contest rules', 'DRAFTS', 'practiced'])
      expect(isDraftOrTest(t)).toBe(false);
    expect(
      isDraftOrTest('Board Minute — August 2026 Allotment and Waiver of Pre-emption', 'BCORP-BM-2026-08-20-002'),
    ).toBe(false);
  });

  const custody = row(
    'c0ffee12',
    'SEALED_DOCUMENT',
    {
      fileName: 'Custody Note — cert 012 test coins — signed by $boase.html',
      ndsSignedFields: ['depositor'],
      ndsManifest: man('BCORP-CN-2026-11-012', 'Custody Note — cert 012 test coins', [
        ['depositor', 'boase'],
        ['custodian', 'bailey'],
      ]),
    },
    { txid: TX },
  );
  const m002 = row(
    '04a63eaa',
    'SEALED_DOCUMENT',
    {
      fileName: 'Board_Minute_Round_2026-08_NDS — SEALED.html',
      ndsComplete: true,
      ndsSignedFields: ['director'],
      ndsManifest: man('BCORP-BM-2026-08-20-002', 'Board Minute — August 2026 Allotment and Waiver of Pre-emption', [
        ['director', 'boase'],
      ]),
    },
    { txid: 'pending-mt1ec5ca-nz5' },
  );
  const offer = row(
    'e8e7e0f6',
    'DOCUMENT',
    {
      fileName: 'Offer_Connor_2026-10-30_cert012_NDS.html',
      ndsManifest: man('BCORP-OFF-2026-10-002', 'Offer — cert 012', [
        ['company', 'boase'],
        ['subscriber', 'bailey'],
      ]),
    },
    { user_handle: 'DRAFTS' },
  );
  const partOffer = row('929299d6', 'DOCUMENT', {
    fileName: 'Offer_Connor_2026-09-21_NDS — part-signed.html',
    ndsComplete: false,
    partiallySigned: true,
    ndsSignedFields: ['company'],
    ndsManifest: man('BCORP-OFF-2026-09-001', 'Share Subscription Offer — Bailey Connor', [
      ['company', 'boase'],
      ['subscriber', 'bailey'],
    ]),
  });
  const upload = row('4ddce6ee', 'DOCUMENT', {
    fileName: 'Preemption_Offer_s561_Massey_2026-10-30_NDS.html',
    from_room: 'DRAFTS',
  });

  test('one row at a time', () => {
    const sCustody = cls(custody);
    expect([sCustody.bucket, sCustody.waitingOn.join()]).toEqual(['waiting', 'bailey']);
    expect(cls(m002).bucket).toBe('signed_offchain');
    expect(cls({ ...m002, txid: TX }).bucket).toBe('signed');
    const sOffer = cls(offer);
    expect([sOffer.bucket, sOffer.room]).toEqual(['to_sign', 'DRAFTS']);
    expect(cls(row('k', 'DOCUMENT', { ndsManifest: man('R', 'T', [['d', 'b0asex']]) })).bucket).toBe('to_sign');
    const sPart = cls(partOffer);
    expect([sPart.bucket, sPart.waitingOn.join()]).toEqual(['waiting', 'bailey']);
    expect(
      cls(
        row('x', 'DOCUMENT', {
          partiallySigned: true,
          ndsManifest: man('M', 'NDA', [
            ['a', 'marekkplw'],
            ['b', 'boase'],
          ]),
        }),
      ).bucket,
    ).toBe('waiting');
    expect(
      cls(
        row('w', 'SEALED_DOCUMENT', {
          ndsSignedFields: ['company'],
          ndsManifest: man('L', 'Licence', [
            ['company', 'boase'],
            ['witness', null],
          ]),
        }),
      ).bucket,
    ).toBe('signed_offchain');
    expect(
      cls(row('l', 'SEALED_DOCUMENT', { ndsManifest: man('V', 'TDA', [['p', 'boase']]) }, { txid: TX })).bucket,
    ).toBe('signed');
  });

  test('files never say "Unsealed"', () => {
    expect(cls(upload).bucket).toBe('files');
    expect(
      cls(
        row('f35262ed', 'DOCUMENT', {
          fileName: 'Minute_013_VexVoid_Direct_Trial_SIGNED_SEALED.html',
          from_room: 'BCORPBOARD',
        }),
      ).bucket,
    ).toBe('files');
    expect(
      cls(row('7693515b', 'SEALED_DOCUMENT', { fileName: 'J30 Stock Transfer Form - Bailey Connor.pdf' }, { txid: TX }))
        .bucket,
    ).toBe('signed');
    expect(cls(row('t', 'TLDRAW', {})).bucket).toBe('other');
  });

  test('drafts & tests and review copies', () => {
    expect(
      cls(
        row(
          '8367e863',
          'SEALED_DOCUMENT',
          {
            fileName: 'Practice Doc A — signed by $b0asex.html',
            ndsComplete: true,
            ndsManifest: man('ROOM', 'Practice Doc A', [['p', 'b0asex']]),
          },
          { txid: TX },
        ),
      ).bucket,
    ).toBe('drafts');
    expect(
      cls(
        row('26719421', 'DOCUMENT', {
          fileName: 'Token Sale Agreement — draft.html',
          ndsManifest: man('AGREEMENT', 'Token Sale Agreement', [['p', 'b0asex']]),
        }),
      ).bucket,
    ).toBe('drafts');
    const draftsOrig = row(
      '19f772df',
      'DOCUMENT',
      {
        fileName: 'Board_Minute_Offer_Connor_2026-10-30-011_NDS.html',
        ndsManifest: man('BCORP-BM-2026-10-30-011', 'Board Minute — Offer to Bailey Connor', [['director', 'boase']]),
      },
      { user_handle: 'DRAFTS' },
    );
    const m011 = row('229c8ac7', 'SEALED_DOCUMENT', {
      originalDocumentId: '19f772df',
      ndsComplete: true,
      ndsSignedFields: ['director'],
      fileName: 'Board_Minute_Offer_Connor_2026-10-30-011_NDS — signed by $boase.html',
      ndsManifest: man('BCORP-BM-2026-10-30-011', 'Board Minute — Offer to Bailey Connor', [['director', 'boase']]),
    });
    const s011 = cls(
      m011,
      new Map([
        [draftsOrig.id, draftsOrig],
        [m011.id, m011],
      ]),
    );
    expect([s011.bucket, s011.reviewCopy, s011.room]).toEqual(['to_sign', true, 'DRAFTS']);
    // The wallet: a review copy I needn't sign is not listed (nothing for me to do), one that needs me is.
    expect(classifyServerRows([draftsOrig, m011], ME).map((r) => [r.signatureId, r.status])).toEqual([]);
    expect(classifyServerRows([offer], ME).map((r) => [r.signatureId, r.status])).toEqual([['e8e7e0f6', 'waiting']]);
  });

  test('the whole vault: one document, one count', () => {
    const later = { ...partOffer, id: 'af43ace0', created_at: '2026-10-02T11:00:00Z' };
    const sealedLeanne = row(
      '31bbf315',
      'SEALED_DOCUMENT',
      {
        ndsSignedFields: ['company', 'contributor'],
        ndsManifest: man('NPG-RSL-2026-07-001', 'Content Revenue-Share Licence Agreement', [
          ['company', 'boase'],
          ['contributor', 'leanne'],
        ]),
      },
      { txid: TX, created_at: '2026-07-24T10:00:00Z' },
    );
    const partLeanne = row(
      'c07aa519',
      'DOCUMENT',
      {
        partiallySigned: true,
        ndsManifest: man('NPG-RSL-2026-07-001', 'Content Revenue-Share Licence Agreement', [
          ['company', 'boase'],
          ['contributor', 'leanne'],
        ]),
      },
      { created_at: '2026-07-23T10:00:00Z' },
    );
    const original = row('a898ffbb', 'DOCUMENT', { fileName: 'Board_Minute_Round_2026-08_NDS.html' });
    const archived = row('arch', 'DOCUMENT', { fileName: 'old.pdf', archived_at: '2026-11-01T00:00:00Z' });
    const all = [
      m002,
      { ...m002, id: 'x2', metadata: { ...m002.metadata, originalDocumentId: undefined } },
      original,
      offer,
      partOffer,
      later,
      sealedLeanne,
      partLeanne,
      upload,
      archived,
      { ...m002, id: 'sup-child', metadata: { ...m002.metadata, originalDocumentId: 'a898ffbb' } },
    ];
    expect(latestGenerations(all).some((r) => r.id === 'a898ffbb' || r.id === 'arch')).toBe(false);
    const st = vaultBuckets(all, ME);
    const c = counts(st);
    expect(c.waiting).toBe(1);
    expect([st.get('929299d6'), st.get('af43ace0')].filter((s) => s?.earlierCopy)).toHaveLength(1);
    expect(st.get('c07aa519')?.earlierCopy).toBe(true);
    expect(st.get('31bbf315')).toMatchObject({ bucket: 'signed', earlierCopy: false });
    expect(c.signed_offchain).toBe(1);
    expect([c.to_sign, c.files, c.signed]).toEqual([1, 1, 1]);
    const founding = row(
      '88fac53f',
      'SEALED_DOCUMENT',
      {
        ndsSignedFields: ['party-a', 'party-b'],
        ndsManifest: man('BSF-2026-07-001', 'Founding Agreement', [
          ['party-a', null],
          ['party-b', null],
        ]),
      },
      { txid: TX, created_at: '2026-07-24T15:00:00Z' },
    );
    const foundingPart = row(
      '189072a9',
      'DOCUMENT',
      {
        partiallySigned: true,
        ndsManifest: man('BSF-2026-07-001', 'Founding Agreement', [
          ['party-a', 'boase'],
          ['party-b', 'signature'],
        ]),
      },
      { created_at: '2026-07-24T10:00:00Z' },
    );
    const st2 = vaultBuckets([founding, foundingPart], ME);
    expect(st2.get('189072a9')?.earlierCopy).toBe(true);
    expect(counts(st2).waiting).toBe(0);
  });
});
