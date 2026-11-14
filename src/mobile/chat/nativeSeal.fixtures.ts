/**
 * Tests only: a document and bit-sign's honest prepare / compose answers for it, built with the same definitions the
 * wallet checks against (sealCheck.ts; sealCheck.test.ts pins those to a vector made with bit-sign's own code).
 */
import { expectedSealRecord, canonicalJson, sealScriptHex, sha256Hex } from './sealCheck';

export const SEAL_KEY = `02${'ab'.repeat(32)}`;
export const SEAL_TS = '2026-11-12T10:00:00.000Z';
export const SEAL_DOC_HASH = 'cd'.repeat(32);

/** A room document whose manifest has the blocks the tests sign (f1, a, b, c). */
export const SEAL_HTML =
  '<!doctype html><html><head><script type="application/npg-sig-manifest+json">' +
  JSON.stringify({
    nds: '1',
    documentTitle: 'T',
    documentRef: 'R',
    signatureFields: ['f1', 'a', 'b', 'c'].map((id) => ({ id, party: `P-${id}`, role: 'signer' })),
  }) +
  '</script></head><body>Agreement</body></html>';

export const preparedFor = (nonce: string, identityKey = SEAL_KEY) => ({
  nonce,
  ref: 'R',
  title: 'T',
  identityKey,
  estFeeSats: 3,
  ts: SEAL_TS,
  origHash: sha256Hex(SEAL_HTML),
});

/** compose's honest answer for one seal (bit-sign composeSeal's shape). */
export function composedFor(o: {
  documentId: string;
  fieldIds: readonly string[];
  svg: string;
  nonce: string;
  identityKey?: string;
}) {
  const record = expectedSealRecord(
    {
      documentId: o.documentId,
      documentHtml: SEAL_HTML,
      svg: o.svg,
      fieldIds: o.fieldIds,
      identityKey: o.identityKey ?? SEAL_KEY,
      nonce: o.nonce,
    },
    'boase',
    SEAL_TS,
  );
  return {
    docHash: SEAL_DOC_HASH,
    record,
    recordCanonical: canonicalJson(record),
    signing: { protocolID: [2, 'bitsign seal'], keyID: o.nonce, counterparty: 'anyone' },
    lockingScriptHex: sealScriptHex(SEAL_DOC_HASH, record),
    estFeeSats: 3,
  };
}
