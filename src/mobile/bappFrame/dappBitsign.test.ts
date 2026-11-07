/**
 * The card-back pad for a bChatX page in the full-screen dApp browser (frameBitsign.ts answerDappBitsign): the page
 * asks window.CWI.bitsign (dapp/provider.ts), the wallet answers with the drawing only. bChatX origins only (the origin
 * is the native WebView's), one pad at a time, Cancel = declined, and the browser steps aside while the pad is up.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { DrawRequest } from '../pair/bitsign';
import { answerDappBitsign } from './frameBitsign';
import { BITSIGN_CAPABILITIES, BITSIGN_DRAW, isBitsignAction } from '../pair/bitsignCalls';

const BCHAT = 'https://chat.bwalletx.com';
const H = 'ab'.repeat(32);
const args = (origin = BCHAT) => ({
  origin,
  docHash: H,
  title: 'Massey s561',
  fieldLabel: 'Director',
  signerHandle: '$boase',
});
const PATH = 'M10 10L200 120L400 60Z';

describe('answerDappBitsign', () => {
  test('anything but bitsign.* is not ours (null: the normal CWI path)', async () => {
    expect(await answerDappBitsign(BCHAT, 'createSignature', {})).toBeNull();
    expect(await answerDappBitsign(BCHAT, 'getPublicKey', {})).toBeNull();
  });

  test('bChatX origins only; the page cannot widen it', async () => {
    let asked = 0;
    const ask = async () => {
      asked++;
      return PATH;
    };
    for (const o of ['https://evil.example', 'https://web.bwalletx.com', 'http://chat.bwalletx.com'])
      expect(await answerDappBitsign(o, BITSIGN_DRAW, args(o), { ask })).toMatchObject({ success: false });
    expect(await answerDappBitsign('https://evil.example', BITSIGN_CAPABILITIES, {})).toMatchObject({
      success: false,
    });
    // args.origin must be the WebView's origin (the same rule as the frame and the paired relay).
    expect(await answerDappBitsign(BCHAT, BITSIGN_DRAW, args('https://www.bchatx.com'), { ask })).toMatchObject({
      success: false,
      code: 'INVALID_PARAMS',
    });
    expect(asked).toBe(0);
  });

  test('capabilities say it can draw', async () => {
    const r = await answerDappBitsign('https://www.bchatx.com', BITSIGN_CAPABILITIES, {});
    expect(r).toMatchObject({ success: true, data: { drawSignature: true } });
  });

  test('drawn → only the strict 1000 × 250 svg, the pad shown over a stepped-aside browser', async () => {
    const cover: boolean[] = [];
    let seen: DrawRequest | null = null;
    const r = await answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), {
      ask: async (req) => {
        seen = req;
        expect(cover).toEqual([true]);
        return PATH;
      },
      cover: (on) => cover.push(on),
    });
    expect(cover).toEqual([true, false]);
    expect(seen!).toMatchObject({ docHash: H, title: 'Massey s561', fieldLabel: 'Director', signerHandle: '$boase' });
    const data = (r as { success: true; data: { svg: string; width: number; height: number } }).data;
    expect(r).toMatchObject({ success: true });
    expect(data.width).toBe(1000);
    expect(data.height).toBe(250);
    expect(data.svg).toContain(`<path d="${PATH}"`);
    expect(Object.keys(data).sort()).toEqual(['height', 'svg', 'width']);
  });

  test('Cancel → declined (ERR_PERMISSION_DENIED); the browser comes back', async () => {
    const cover: boolean[] = [];
    const r = await answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), {
      ask: async () => null,
      cover: (on) => cover.push(on),
    });
    expect(r).toEqual({ success: false, error: 'declined', code: 'ERR_PERMISSION_DENIED' });
    expect(cover).toEqual([true, false]);
  });

  test('the pad failing still brings the browser back', async () => {
    const cover: boolean[] = [];
    const r = await answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), {
      ask: async () => {
        throw new Error('boom');
      },
      cover: (on) => cover.push(on),
    });
    expect(r).toMatchObject({ success: false });
    expect(cover).toEqual([true, false]);
  });

  test('one pad at a time: a second draw while one is open is refused, the first still answers', async () => {
    let finish: (p: string | null) => void = () => {};
    const first = answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), {
      ask: () => new Promise<string | null>((res) => (finish = res)),
    });
    let asked2 = 0;
    const second = await answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), {
      ask: async () => {
        asked2++;
        return PATH;
      },
    });
    expect(second).toMatchObject({ success: false, code: 'INVALID_PARAMS' });
    expect(asked2).toBe(0);
    finish(PATH);
    expect(await first).toMatchObject({ success: true });
    // Free again once answered.
    expect(await answerDappBitsign(BCHAT, BITSIGN_DRAW, args(), { ask: async () => PATH })).toMatchObject({
      success: true,
    });
  });
});

describe('the dApp browser wiring', () => {
  test('call names', () => {
    expect(isBitsignAction('bitsign.capabilities')).toBe(true);
    expect(isBitsignAction('bitsign.drawSignature')).toBe(true);
    expect(isBitsignAction('bitsign.sign')).toBe(false);
  });

  test('the native browser listener answers bitsign.* first, stepping the browser aside for the pad', () => {
    const src = readFileSync(new URL('../dappBrowser.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/answerDappBitsign\(req\.origin, type, params, \{ cover: sheetOverBrowser \}\)/);
  });

  test('the injected provider passes bitsign.* to the wallet and offers window.CWI.bitsign on bChatX only', () => {
    const src = readFileSync(new URL('../dapp/provider.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/isBitsignAction\(type\)/);
    expect(src).toMatch(/BCHAT_ORIGINS[\s\S]{0,80}location\.origin/);
    expect(src).toMatch(/\.bitsign = /);
  });
});
