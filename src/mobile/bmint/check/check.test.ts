import { describe, expect, test } from 'bun:test';
import { Beef, Hash, Script, Transaction, Utils } from '@bsv/sdk';
import fx from './fixtures/mint-971558.json';
import { checkBeef, checkBump, checkTx, GuardError } from './guard';
import { checkMint, type HeaderSource } from './sources';
import {
  FLOOR_BITS,
  headerFromFields,
  parseHeader,
  parseOutpoint,
  powOk,
  verifyMintEvidence,
  type HeaderAnswer,
  type Verdict,
} from './verify';
import { parseIssueScript } from '../../issuer/issuer';
import { guestCheckRoute } from './guestRoute';

// A real bMint mint (bWalletX "mint test: picture", 31 KB PNG) in block 971,558, recorded from
// WhatsOnChain (BEEF + block fields) and Bitails (raw header) on 19 Oct 2026.
const { toArray, toHex } = Utils;
const OUT = fx.outpoint;
const TXID = OUT.split('_')[0];
const BEEF = toArray(fx.beef, 'hex');
const WOC_RAW = headerFromFields(fx.woc);
const BIT_RAW = toArray(fx.bitails.header, 'hex');
const H = fx.woc.height;
const headers = (a = WOC_RAW, b = BIT_RAW, ha = H, hb = H): HeaderAnswer[] => [
  { source: 'WhatsOnChain', height: ha, raw: a },
  { source: 'Bitails', height: hb, raw: b },
];
const mintTx = () => Beef.fromBinary(BEEF).findTxid(TXID)!.tx!;
const tx = mintTx();
const bodyHash = () => {
  const v = verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers() });
  if (v.status !== 'VERIFIED') throw new Error('fixture does not verify');
  return v.contentSha256;
};
const refused = (v: Verdict, code: string) => {
  expect(v.status).toBe('REFUSED');
  if (v.status === 'REFUSED') expect(v.code).toBe(code as never);
};
/** A BEEF holding only `t` (no BUMP), as a mempool tx would come. */
const unminedBeef = (t: Transaction) => {
  const b = new Beef();
  b.mergeRawTx(t.toBinary());
  return b.toBinary();
};
const issuerVout = () => tx.outputs.findIndex((o) => parseIssueScript(o.lockingScript));

describe('the recorded mint', () => {
  test('VERIFIED: signature, merkle proof, header work, two sources, height', () => {
    const v = verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers() });
    expect(v.status).toBe('VERIFIED');
    if (v.status !== 'VERIFIED') return;
    expect(v.height).toBe(971558);
    expect(v.blockHash).toBe(fx.woc.hash);
    expect(v.blockTime).toBe(fx.woc.time);
    expect(v.identityKey).toBe('024f45f45e453012cf8da78f53e01dd933b122af290cf093cd13009c698211fb7a');
    expect(v.contentType).toBe('image/png');
    expect(v.contentBytes).toBe(31464);
    expect(v.headerSources).toEqual(['WhatsOnChain', 'Bitails']);
    expect(v.fileMatch).toBeNull();
  });
  test('the two recorded sources really are the same 80 bytes', () => {
    expect(toHex(WOC_RAW)).toBe(fx.bitails.header);
    expect(parseHeader(WOC_RAW)!.hash).toBe(fx.woc.hash);
  });
  test('a matching file: fileMatch true', () => {
    const v = verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers(), fileSha256: bodyHash() });
    expect(v.status).toBe('VERIFIED');
    if (v.status === 'VERIFIED') expect(v.fileMatch).toBe(true);
  });
});

describe('tamper → REFUSED', () => {
  test('a different file: content-mismatch', () => {
    const other = toHex(Hash.sha256(toArray('not the picture', 'utf8')));
    refused(
      verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers(), fileSha256: other }),
      'content-mismatch',
    );
  });
  test('a sibling hash in the BUMP changed: proof-mismatch', () => {
    // 0100beef | 01 bump | fe26d30e00 height | 07 tree | 02 leaves | 31 offset | 00 flags | <hash…>
    expect(fx.beef.slice(0, 28)).toBe('0100beef01fe26d30e0007023100');
    const hex = fx.beef.slice(0, 28) + (fx.beef[28] === '0' ? '1' : '0') + fx.beef.slice(29);
    refused(verifyMintEvidence({ outpoint: OUT, beef: toArray(hex, 'hex'), headers: headers() }), 'proof-mismatch');
  });
  test('header nonce changed (both sources): header-pow-invalid', () => {
    const bad = WOC_RAW.slice();
    bad[76] ^= 1;
    refused(verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers(bad, bad) }), 'header-pow-invalid');
  });
  test('header sources disagree: header-mismatch', () => {
    const bad = WOC_RAW.slice();
    bad[76] ^= 1;
    refused(verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers(WOC_RAW, bad) }), 'header-mismatch');
  });
  test('a header for another height: header-mismatch', () => {
    refused(
      verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers(WOC_RAW, BIT_RAW, H, H + 1) }),
      'header-mismatch',
    );
  });
  test('signature byte changed: bad-signature (before any block check)', () => {
    const t = mintTx();
    const i = issuerVout();
    const b = t.outputs[i].lockingScript.toBinary();
    b[b.length - 1] ^= 1;
    t.outputs[i].lockingScript = Script.fromBinary(b);
    refused(
      verifyMintEvidence({ outpoint: `${t.id('hex')}_0`, beef: unminedBeef(t), headers: headers() }),
      'bad-signature',
    );
  });
  test('issuer statement removed: unsigned', () => {
    const t = mintTx();
    t.outputs.splice(issuerVout(), 1);
    refused(verifyMintEvidence({ outpoint: `${t.id('hex')}_0`, beef: unminedBeef(t), headers: [] }), 'unsigned');
  });
  test('the inscribed bytes changed: bad-signature (the signature binds the whole output)', () => {
    const t = mintTx();
    const b = t.outputs[0].lockingScript.toBinary();
    b[200] ^= 1;
    t.outputs[0].lockingScript = Script.fromBinary(b);
    refused(verifyMintEvidence({ outpoint: `${t.id('hex')}_0`, beef: unminedBeef(t), headers: [] }), 'bad-signature');
  });
  test('an output that is not an inscription: not-a-mint', () => {
    refused(verifyMintEvidence({ outpoint: `${TXID}_${issuerVout()}`, beef: BEEF, headers: headers() }), 'not-a-mint');
  });
  test('no such output: no-output', () => {
    refused(verifyMintEvidence({ outpoint: `${TXID}_99`, beef: BEEF, headers: headers() }), 'no-output');
  });
  test('another txid: not-in-proof', () => {
    refused(verifyMintEvidence({ outpoint: `${'ab'.repeat(32)}_0`, beef: BEEF, headers: headers() }), 'not-in-proof');
  });
  test('truncated, padded and lying BEEF: malformed', () => {
    refused(verifyMintEvidence({ outpoint: OUT, beef: BEEF.slice(0, -5), headers: headers() }), 'malformed');
    refused(verifyMintEvidence({ outpoint: OUT, beef: [...BEEF, 0], headers: headers() }), 'malformed');
    // Declares 2^32 BUMPs in a few bytes.
    refused(
      verifyMintEvidence({ outpoint: OUT, beef: toArray('0100beeffeffffffff00', 'hex'), headers: headers() }),
      'malformed',
    );
  });
});

describe('never a quiet pass', () => {
  test('one header source: UNREACHABLE, not VERIFIED', () => {
    const v = verifyMintEvidence({ outpoint: OUT, beef: BEEF, headers: headers().slice(0, 1) });
    expect(v.status).toBe('UNREACHABLE');
  });
  test('not mined yet: PENDING with the signer, not VERIFIED', () => {
    const v = verifyMintEvidence({ outpoint: OUT, beef: unminedBeef(mintTx()), headers: [] });
    expect(v.status).toBe('PENDING');
    if (v.status === 'PENDING') expect(v.identityKey).toStartWith('024f45');
  });
});

describe('headers', () => {
  test('a header that meets its own easy target is still refused under the floor', () => {
    const base = WOC_RAW.slice();
    base[72] = 0xff; // bits 0x207fffff (regtest)
    base[73] = 0xff;
    base[74] = 0x7f;
    base[75] = 0x20;
    let h = parseHeader(base)!;
    for (let n = 0; BigInt('0x' + h.hash) >= 1n << 254n; n++) {
      base[76] = n & 0xff;
      base[77] = n >> 8;
      h = parseHeader(base)!;
    }
    expect(h.bits).toBe(0x207fffff);
    expect(h.bits > FLOOR_BITS).toBe(true);
    expect(powOk(h)).toBe(false);
    expect(powOk(parseHeader(WOC_RAW)!)).toBe(true);
  });
});

describe('guard', () => {
  test('the real tx, BUMP and BEEF walk cleanly', () => {
    expect(() => checkTx(tx.toBinary())).not.toThrow();
    expect(() => checkBump(Beef.fromBinary(BEEF).bumps[0].toBinary())).not.toThrow();
    expect(checkBeef(BEEF)).toBe(1);
  });
  test('overruns, trailing bytes, empty and zero-input txs are refused', () => {
    const raw = tx.toBinary();
    expect(() => checkTx(raw.slice(0, -1))).toThrow(GuardError);
    expect(() => checkTx([...raw, 0])).toThrow(GuardError);
    expect(() => checkTx([])).toThrow(GuardError);
    expect(() => checkTx(toArray('01000000' + '00' + '00' + '00000000', 'hex'))).toThrow(GuardError);
    expect(() => checkBump(toArray('0000', 'hex'))).toThrow(GuardError);
  });
  test('limits hold', () => {
    expect(() =>
      checkTx(tx.toBinary(), {
        bytes: 1 << 30,
        transactions: 1,
        bumps: 1,
        inputs: 1000,
        outputs: 1000,
        script: 100,
        treeHeight: 64,
        leaves: 10,
      }),
    ).toThrow(/limit/);
  });
});

describe('parseOutpoint', () => {
  test.each([
    [TXID, `${TXID}_0`],
    [`${TXID}_2`, `${TXID}_2`],
    [`${TXID}.3`, `${TXID}_3`],
    [`${TXID}:4`, `${TXID}_4`],
    [TXID.toUpperCase(), `${TXID}_0`],
    [`https://web.bwalletx.com/m/bmint/check?o=${TXID}_1`, `${TXID}_1`],
    [`https://ordfs.network/content/${TXID}_0`, `${TXID}_0`],
    [`https://whatsonchain.com/tx/${TXID}`, `${TXID}_0`],
  ])('%s', (input, want) => expect(parseOutpoint(input)).toBe(want));
  test.each(['', 'hello', 'abc_1', `${TXID}ff`])('rejects %p', (input) => expect(parseOutpoint(input)).toBeNull());
});

describe('checkMint (fetching)', () => {
  const src = (name: string, raw: number[]): HeaderSource => ({ name, get: async () => raw });
  const res = (body: string, status = 200) => new Response(body, { status });
  test('public sources → VERIFIED', async () => {
    const f = (async (url: string) => {
      if (url.includes('/block/height/')) return res(JSON.stringify(url.includes('bitails') ? fx.bitails : fx.woc));
      if (url.endsWith('/beef')) return res(fx.beef);
      return res('', 404);
    }) as typeof fetch;
    const v = await checkMint(`https://bmintx.com/check?o=${OUT}`, {}, { fetch: f });
    expect(v.status).toBe('VERIFIED');
  });
  test('network down → UNREACHABLE', async () => {
    const f = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect((await checkMint(OUT, {}, { fetch: f })).status).toBe('UNREACHABLE');
  });
  test('unknown tx → UNREACHABLE', async () => {
    const f = (async () => res('', 404)) as typeof fetch;
    expect((await checkMint(OUT, {}, { fetch: f })).status).toBe('UNREACHABLE');
  });
  test('a header source down → UNREACHABLE; a lying one → REFUSED', async () => {
    const getBeef = async () => fx.beef;
    const down: HeaderSource = { name: 'down', get: async () => Promise.reject(new Error('x')) };
    const v1 = await checkMint(OUT, {}, { getBeef, headerSources: [src('a', WOC_RAW), down] });
    expect(v1.status).toBe('UNREACHABLE');
    const liar = WOC_RAW.slice();
    liar[40] ^= 1;
    refused(
      await checkMint(OUT, {}, { getBeef, headerSources: [src('a', WOC_RAW), src('b', liar)] }),
      'header-mismatch',
    );
  });
  test('the beef source returning junk → REFUSED', async () => {
    refused(await checkMint(OUT, {}, { getBeef: async () => 'zz', headerSources: [] }), 'malformed');
  });
});

describe('guestCheckRoute', () => {
  test.each([
    ['/bmint/check', `?o=${OUT}`, `/m/bmint/check?o=${OUT}`],
    ['/check', `?o=${TXID}`, `/m/bmint/check?o=${TXID}_0`],
    ['/bmint/check', '', '/m/bmint/check'],
    ['/bmint/check', '?o=junk', '/m/bmint/check'],
    ['/names', '', null],
  ])('%s%s', (path, search, want) => expect(guestCheckRoute(path, search)).toBe(want));
});
