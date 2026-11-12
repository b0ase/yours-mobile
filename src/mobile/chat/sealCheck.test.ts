import { describe, expect, test } from 'bun:test';
import { checkComposed, checkPrepared, sha256Hex, type SealExpect } from './sealCheck';

/**
 * A seal made with bit-sign's OWN code (nds-seal-record.ts buildSealRecord / canonicalSealRecord / buildSealPayloadV2,
 * seal-inscription.ts sealLockingScriptHex, nds.ts embeddedManifestText / recordFieldsFor), 12 Nov 2026. Non-ASCII
 * document, blocks out of order, a block not signed, a block with no party.
 */
const V = {
  html: '<!doctype html><html><head><title>t</title><script type="application/npg-sig-manifest+json">{"nds":"1","documentTitle":"Test \u00a3 deal \u2713","documentRef":"REF-7","signatureFields":[{"id":"sig-b","party":"Buyer","role":"buyer","signerHandle":"bob"},{"id":"sig-a","party":"Seller","role":"seller","signerHandle":"alice"},{"id":"sig-c","role":"witness"}]}</script></head><body><p>Deal \u00a31 \u2014 \u2713 \ud83d\ude00</p></body></html>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><path d="M 1.0 1.0 L 2.0 2.0" stroke="black" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  key: '02abababababababababababababababababababababababababababababababab',
  nonce: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  ts: '2026-11-12T10:00:00.000Z',
  docHash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  origHash: '269f9f8c8b350926fa19896c31c9b3eee417355e993b7716c6d1afe64a2a9225',
  recordCanonical:
    '{"doc":"269f9f8c8b350926fa19896c31c9b3eee417355e993b7716c6d1afe64a2a9225","fields":[{"id":"sig-a","party":"Seller","role":"seller"},{"id":"sig-b","party":"Buyer","role":"buyer"}],"handle":"boase","key":"02abababababababababababababababababababababababababababababababab","manifest":"f1ee533360d8ef40d191e7be940d089ff7566f26da95a63f22c50e86cad29aee","nonce":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","ref":"REF-7","svg":"20b769c133641a21ec796fa0ea7ff3644d7afad128fb9943824a11d4d28e0d73","ts":"2026-11-12T10:00:00.000Z","v":"bitsign-seal-2"}',
  lockingScriptHex:
    '006a4d0c027b2270726f746f636f6c223a2262306173652d6269747369676e222c2276657273696f6e223a22322e30222c2274797065223a226e64735f6669656c645f7365616c222c22646f6348617368223a2263646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364636463646364222c226f72696748617368223a2232363966396638633862333530393236666131393839366333316339623365656534313733353565393933623737313663366431616665363461326139323235222c227265636f726448617368223a2239623539623661323866336664616431326262323935633565316664623837346265373631643839313039623063333533353735613537343139623436623138222c2273766748617368223a2232306237363963313333363431613231656337393666613065613766663336343464376166616431323866623939343338323461313164346432386530643733222c226669656c6473223a227369672d612c7369672d62222c226b6579223a22303261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162222c22726566223a225245462d37222c227473223a22323032362d31312d31325431303a30303a30302e3030305a227d',
};

const expectFor = (over: Partial<SealExpect> = {}): SealExpect => ({
  documentId: 'DOC1',
  documentHtml: V.html,
  svg: V.svg,
  fieldIds: ['sig-b', 'sig-a'],
  identityKey: V.key,
  nonce: V.nonce,
  ts: V.ts,
  ...over,
});
const composed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  docHash: V.docHash,
  recordCanonical: V.recordCanonical,
  signing: { protocolID: [2, 'bitsign seal'], keyID: V.nonce, counterparty: 'anyone' },
  lockingScriptHex: V.lockingScriptHex,
  ...over,
});
const why = (c: ReturnType<typeof checkComposed>) => (c.ok ? 'ok' : c.why);

describe('checkComposed: byte for byte what bit-sign builds', () => {
  test("bit-sign's own seal is accepted, and the wallet's rebuilt record and output are identical to it", () => {
    expect(sha256Hex(V.html)).toBe(V.origHash);
    const c = checkComposed(composed(), expectFor());
    expect(c).toEqual({
      ok: true,
      signing: { protocolID: [2, 'bitsign seal'], keyID: V.nonce, counterparty: 'anyone' },
      recordCanonical: V.recordCanonical,
      lockingScriptHex: V.lockingScriptHex,
    });
  });
  test('upper-case script hex and an upper-case wallet key are the same seal', () => {
    expect(checkComposed(composed({ lockingScriptHex: V.lockingScriptHex.toUpperCase() }), expectFor()).ok).toBe(true);
    expect(checkComposed(composed(), expectFor({ identityKey: V.key.toUpperCase() })).ok).toBe(true);
  });
  test('prepare gave no ts: any well-formed ts is taken', () => {
    expect(checkComposed(composed(), expectFor({ ts: undefined })).ok).toBe(true);
  });
});

describe('checkComposed: anything else is refused', () => {
  test('signing parameters are fixed: protocol, key id (the session nonce), counterparty', () => {
    const s = (signing: unknown) => why(checkComposed(composed({ signing }), expectFor()));
    expect(s({ protocolID: [2, 'auth message signature'], keyID: V.nonce, counterparty: 'anyone' })).toMatch(
      /protocol/,
    );
    expect(s({ protocolID: [1, 'bitsign seal'], keyID: V.nonce, counterparty: 'anyone' })).toMatch(/protocol/);
    expect(s({ protocolID: [2, 'bitsign seal', 'x'], keyID: V.nonce, counterparty: 'anyone' })).toMatch(/protocol/);
    expect(s({ protocolID: [2, 'bitsign seal'], keyID: '1', counterparty: 'anyone' })).toMatch(/key id/);
    expect(s({ protocolID: [2, 'bitsign seal'], keyID: V.nonce, counterparty: 'self' })).toMatch(/counterparty/);
    expect(s({ protocolID: [2, 'bitsign seal'], keyID: V.nonce, counterparty: `03${'11'.repeat(32)}` })).toMatch(
      /counterparty/,
    );
    expect(s(undefined)).toMatch(/protocol/);
  });
  test('the record must be the record of THIS document, this signature, this wallet, these blocks, this session', () => {
    expect(why(checkComposed(composed(), expectFor({ documentHtml: V.html + ' ' })))).toMatch(
      /record differs \(doc, manifest\)|record differs \(doc\)/,
    );
    expect(why(checkComposed(composed(), expectFor({ svg: V.svg.replace('2.0 2.0', '3.0 3.0') })))).toMatch(/svg/);
    expect(why(checkComposed(composed(), expectFor({ identityKey: `03${'cd'.repeat(32)}` })))).toMatch(/key/);
    expect(why(checkComposed(composed(), expectFor({ fieldIds: ['sig-a'] })))).toMatch(/fields/);
    expect(why(checkComposed(composed(), expectFor({ fieldIds: ['sig-a', 'sig-x'] })))).toMatch(/sig-x/);
    expect(why(checkComposed(composed(), expectFor({ nonce: 'OtherNonce0123456789' })))).toMatch(/key id/);
    expect(why(checkComposed(composed(), expectFor({ ts: '2026-11-12T10:00:01.000Z' })))).toMatch(/time/);
  });
  test('a re-ordered, re-spaced or extended record is refused (the signature is over these exact bytes)', () => {
    const r = JSON.parse(V.recordCanonical) as Record<string, unknown>;
    expect(why(checkComposed(composed({ recordCanonical: JSON.stringify(r, null, 1) }), expectFor()))).toMatch(/form/);
    expect(
      why(checkComposed(composed({ recordCanonical: V.recordCanonical.replace('{', '{"amount":"1",') }), expectFor())),
    ).toMatch(/amount/);
    expect(why(checkComposed(composed({ recordCanonical: 'not json' }), expectFor()))).toMatch(/JSON/);
    expect(why(checkComposed(composed({ recordCanonical: '[]' }), expectFor()))).toMatch(/object|handle/);
    expect(why(checkComposed(composed({ recordCanonical: undefined }), expectFor()))).toMatch(/no record/);
  });
  test('the output must be the seal of this record: no other script, no payee', () => {
    const p2pkh = `76a914${'00'.repeat(20)}88ac`;
    expect(why(checkComposed(composed({ lockingScriptHex: p2pkh }), expectFor()))).toMatch(/output/);
    expect(why(checkComposed(composed({ lockingScriptHex: '006a' }), expectFor()))).toMatch(/output/);
    expect(why(checkComposed(composed({ lockingScriptHex: V.lockingScriptHex + '00' }), expectFor()))).toMatch(
      /output/,
    );
    expect(why(checkComposed(composed({ docHash: 'ef'.repeat(32) }), expectFor()))).toMatch(/output/);
    expect(why(checkComposed(composed({ docHash: 'xyz' }), expectFor()))).toMatch(/docHash/);
  });
  test('a document with no manifest, or no wallet key, is never signed', () => {
    expect(why(checkComposed(composed(), expectFor({ documentHtml: '<html>plain</html>' })))).toMatch(/manifest/);
    expect(why(checkComposed(composed(), expectFor({ identityKey: '' })))).toMatch(/identity key/);
  });
});

describe('checkPrepared: before the one approval', () => {
  const e = { documentHtml: V.html, identityKey: V.key };
  test("this document's hash and this wallet's key, or not named at all: fine", () => {
    expect(checkPrepared({ nonce: V.nonce, origHash: V.origHash, identityKey: V.key.toUpperCase() }, e)).toBeNull();
    expect(checkPrepared({ nonce: V.nonce }, e)).toBeNull();
  });
  test('another version of the document, another wallet, no nonce, or no wallet key: refused', () => {
    expect(checkPrepared({ nonce: V.nonce, origHash: 'ab'.repeat(32) }, e)).toMatch(/version/);
    expect(checkPrepared({ nonce: V.nonce, identityKey: `03${'cd'.repeat(32)}` }, e)).toMatch(/wallet/);
    expect(checkPrepared({ nonce: '' }, e)).toMatch(/nonce/);
    expect(checkPrepared({ nonce: V.nonce }, { ...e, identityKey: '' })).toMatch(/identity key/);
  });
});
