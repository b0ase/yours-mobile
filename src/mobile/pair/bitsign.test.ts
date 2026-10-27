import { describe, expect, test } from 'bun:test';
import {
  BAD_REQUEST_CODE,
  BITSIGN_CAPABILITIES,
  BITSIGN_DRAW,
  DECLINED,
  checkStrictSvg,
  handleBitsignCall,
  shortHash,
  signatureSvg,
  validateDrawRequest,
  type DrawRequest,
} from './bitsign';
import { ReplyBook } from './replies';
import { USER_DENIED_CODE } from '../../services/userDenied';
import type { PairMessage } from '../../pair/protocol';

const ORIGIN = 'https://bchatx.com';
const HASH = 'ab'.repeat(32);
const good = {
  title: 'Lease',
  docHash: HASH,
  ref: 'NDS-1',
  fieldLabel: 'Tenant',
  signerHandle: '$b0asex',
  origin: ORIGIN,
};
const PATH = 'M10 10L200 100L300 50Z';
const W = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250"';

describe('bitsign.capabilities', () => {
  test('replies drawSignature:true without showing anything', async () => {
    let asked = false;
    const r = await handleBitsignCall(BITSIGN_CAPABILITIES, {}, ORIGIN, async () => ((asked = true), null));
    expect(r).toEqual({ result: { drawSignature: true } });
    expect(asked).toBe(false);
  });
});

describe('validateDrawRequest', () => {
  test('accepts a good request; optional fields default to empty', () => {
    expect(validateDrawRequest(good, ORIGIN)).toEqual(good);
    const { ref: _r, fieldLabel: _f, signerHandle: _s, ...min } = good;
    expect(validateDrawRequest(min, ORIGIN)).toEqual({ ...min, ref: '', fieldLabel: '', signerHandle: '' });
  });
  test.each([
    ['origin mismatch', { ...good, origin: 'https://evil.example' }],
    ['missing origin', { ...good, origin: undefined }],
    ['upper-case hash', { ...good, docHash: HASH.toUpperCase() }],
    ['short hash', { ...good, docHash: HASH.slice(2) }],
    ['title too long', { ...good, title: 'x'.repeat(121) }],
    ['title missing', { ...good, title: undefined }],
    ['ref too long', { ...good, ref: 'x'.repeat(61) }],
    ['fieldLabel too long', { ...good, fieldLabel: 'x'.repeat(61) }],
    ['signerHandle not text', { ...good, signerHandle: 5 }],
    ['control characters', { ...good, title: 'a\nb' }],
    ['bidi override', { ...good, ref: 'a‮b' }],
  ])('rejects %s', (_n, p) => {
    expect(typeof validateDrawRequest(p, ORIGIN)).toBe('string');
  });
  test('rejects non-objects', () => {
    for (const p of [null, undefined, 'x', [good]]) expect(typeof validateDrawRequest(p, ORIGIN)).toBe('string');
  });
  test('limits are inclusive', () => {
    const p = { ...good, title: 'x'.repeat(120), ref: 'y'.repeat(60) };
    expect(typeof validateDrawRequest(p, ORIGIN)).toBe('object');
  });
  test('a bad request errors and never shows the pad', async () => {
    let asked = false;
    const r = await handleBitsignCall(BITSIGN_DRAW, { ...good, origin: 'https://x.y' }, ORIGIN, async () => {
      asked = true;
      return PATH;
    });
    expect(asked).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe(BAD_REQUEST_CODE);
  });
  test('shortHash shows first 8 and last 8', () => {
    expect(shortHash('0123456789' + 'a'.repeat(44) + 'fedcba9876')).toBe('01234567…dcba9876');
  });
});

describe('drawSignature replies', () => {
  test('Done returns a strict 1000 × 250 svg', async () => {
    const r = (await handleBitsignCall(BITSIGN_DRAW, good, ORIGIN, async () => PATH)) as {
      result: { svg: string; width: number; height: number };
    };
    expect(r.result.width).toBe(1000);
    expect(r.result.height).toBe(250);
    expect(checkStrictSvg(r.result.svg)).toBeNull();
    expect(r.result.svg).toContain(`d="${PATH}"`);
  });
  test('Cancel is declined', async () => {
    expect(await handleBitsignCall(BITSIGN_DRAW, good, ORIGIN, async () => null)).toEqual({
      error: { code: USER_DENIED_CODE, message: DECLINED },
    });
  });
  test('a path that is not the pad format is never passed through', async () => {
    const r = await handleBitsignCall(BITSIGN_DRAW, good, ORIGIN, async () => 'M0 0"/><script>alert(1)</script>');
    expect(r).toEqual({ error: { code: USER_DENIED_CODE, message: DECLINED } });
    expect(signatureSvg('M0 0 onload=x')).toBe('');
  });
});

describe('dedupe by request id (ReplyBook + handler, as sessions.ts wires them)', () => {
  test('a re-sent id shows one pad and gets one answer', async () => {
    const book = new ReplyBook();
    const sent: PairMessage[] = [];
    let pads = 0;
    let finishPad!: (p: string | null) => void;
    const ask = (_r: DrawRequest) => {
      pads++;
      return new Promise<string | null>((res) => (finishPad = res));
    };
    const onRequest = async (id: string) => {
      const seen = book.begin('c', id);
      if (seen === 'busy') return;
      if (seen !== 'run') return void sent.push(seen.replay);
      const msg: PairMessage = { t: 'res', id, ...(await handleBitsignCall(BITSIGN_DRAW, good, ORIGIN, ask)) };
      book.finish('c', id, msg);
      sent.push(msg);
    };
    const first = onRequest('r1');
    await onRequest('r1'); // reconnect while the pad is open
    expect(pads).toBe(1);
    finishPad(PATH);
    await first;
    expect(sent.length).toBe(1);
    await onRequest('r1'); // reconnect after the answer: the same reply again, no new pad
    expect(pads).toBe(1);
    expect(sent[1]).toEqual(sent[0]);
  });
});

describe('checkStrictSvg', () => {
  test('accepts the allowlisted shapes', () => {
    expect(checkStrictSvg(signatureSvg(PATH))).toBeNull();
    expect(
      checkStrictSvg(
        `${W} viewBox="0 0 1000 250"><g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,2 3,4"/><line x1="0" y1="0" x2="5" y2="5"/></g></svg>`,
      ),
    ).toBeNull();
  });
  test.each([
    ['script', `${W}><script>alert(1)</script></svg>`],
    ['onload', `${W} onload="alert(1)"></svg>`],
    ['style attribute', `${W}><path d="M0 0" style="fill:red"/></svg>`],
    ['style element', `${W}><style>*{}</style></svg>`],
    ['href', `${W}><path d="M0 0" href="x"/></svg>`],
    ['xlink:href', `${W}><path d="M0 0" xlink:href="x"/></svg>`],
    ['foreignObject', `${W}><foreignObject/></svg>`],
    ['text node', `${W}>hi</svg>`],
    ['text element', `${W}><text>hi</text></svg>`],
    ['comment', `${W}><!-- x --></svg>`],
    ['CDATA', `${W}><![CDATA[x]]></svg>`],
    ['doctype', `<!DOCTYPE svg>${W}></svg>`],
    ['processing instruction', `<?xml version="1.0"?>${W}></svg>`],
    ['entity', `${W}><path d="M0 0&#x41;"/></svg>`],
    ['single quotes', `<svg xmlns='http://www.w3.org/2000/svg' width="1000" height="250"></svg>`],
    ['unquoted', `${W}><path d=M0/></svg>`],
    ['url()', `${W}><path d="M0 0" fill="url(#a)"/></svg>`],
    ['javascript:', `${W}><path d="M0 0" fill="javascript:x"/></svg>`],
    ['data:', `${W}><path d="M0 0" fill="data:x"/></svg>`],
    ['backslash', `${W}><path d="M0 0\\"/></svg>`],
    ['wrong width', `<svg xmlns="http://www.w3.org/2000/svg" width="999" height="250"></svg>`],
    ['missing height', `<svg xmlns="http://www.w3.org/2000/svg" width="1000"></svg>`],
    ['wrong xmlns', `<svg xmlns="http://evil" width="1000" height="250"></svg>`],
    ['two roots', `${W}></svg>${W}></svg>`],
    ['nested svg', `${W}>${W}></svg></svg>`],
    ['path outside svg', `<path d="M0 0"/>`],
    ['unbalanced', `${W}><g></svg>`],
    ['unclosed root', `${W}>`],
    ['duplicate attribute', `${W}><path d="M0 0" d="M1 1"/></svg>`],
    ['trailing text', `${W}></svg>x`],
    ['too large', `${W}><path d="${'M0 0'.repeat(60_000)}"/></svg>`],
  ])('rejects %s', (_n, svg) => {
    expect(checkStrictSvg(svg)).not.toBeNull();
  });
});
