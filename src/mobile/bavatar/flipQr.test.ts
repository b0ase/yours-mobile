import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  PAY_URI_RE,
  compactArtBackGroup,
  flipBackSvg,
  flipPayload,
  isPublicPayload,
  payUri,
  paymailPayload,
} from './flipQr';
import { jsqr, rasterise, zbar, zxing } from './flipQr.testkit';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ADDR2 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
const WIF_C = 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617';
const HEX = 'e9873d79c6d87dc0fb6a5778633389f4453213303da61f20bd67fc233aa33262';
const XPRV =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYMAIL_RE = /^[a-z0-9]([a-z0-9_.-]{0,30}[a-z0-9])?@[a-z0-9.-]+\.[a-z]{2,}$/;
const SECRET = [/[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/, /[xt]prv/];
const keyOf = (s: string) => '02' + createHash('sha256').update(s).digest('hex');
const KEY = keyOf('alice');

describe('flip pay code: public data only', () => {
  test('pay URI is bitcoin:<address> for a real address, nothing for anything else', () => {
    expect(payUri(ADDR)).toBe(`bitcoin:${ADDR}`);
    expect(payUri(` ${ADDR2} `)).toBe(`bitcoin:${ADDR2}`);
    for (const bad of ['', 'twetch:9', 'peck:abc', WIF, WIF_C, HEX, XPRV, SEED, '0OIl' + ADDR.slice(4)])
      expect(payUri(bad)).toBe('');
    expect(paymailPayload('Alice@bwalletx.com')).toBe('alice@bwalletx.com');
    expect(paymailPayload(SEED)).toBe('');
    expect(flipPayload(ADDR, 'alice@bwalletx.com')).toBe(`bitcoin:${ADDR}`);
    expect(flipPayload('', 'alice@bwalletx.com')).toBe('alice@bwalletx.com');
    expect(flipPayload(WIF, XPRV)).toBe('');
  });

  test('every payload matches the public pattern and never contains key-like strings', () => {
    for (const p of [flipPayload(ADDR), flipPayload(ADDR2), flipPayload('', 'b0asex@bwalletx.com')]) {
      expect(PAY_URI_RE.test(p) || PAYMAIL_RE.test(p)).toBe(true);
      expect(p).toMatch(/^bitcoin:[13][a-km-zA-HJ-NP-Z1-9]{25,34}(\?.*)?$|^[a-z0-9._-]+@[a-z0-9.-]+$/);
      for (const re of [...SECRET, /[0-9a-fA-F]{64}/]) expect(re.test(p)).toBe(false);
    }
    for (const s of [WIF, WIF_C, HEX, XPRV, SEED, `bitcoin:${ADDR}?k=${HEX}`, `bitcoin:${ADDR}?w=${WIF}`])
      expect(isPublicPayload(s)).toBe(false);
    expect(flipBackSvg(KEY, `bitcoin:${ADDR}?k=${HEX}`)).toBe('');
    expect(flipBackSvg(KEY, WIF)).toBe('');
    expect(flipBackSvg('', `bitcoin:${ADDR}`)).toBe('');
    expect(compactArtBackGroup(XPRV, 'a', 0, 0, 512)).toBe('');
  });

  test('the back SVG is the Art QR of the payload only: no key, WIF or xprv in it', () => {
    const svg = flipBackSvg(KEY, `bitcoin:${ADDR}`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('aria-label="Pay code"');
    expect(svg).not.toContain(KEY);
    for (const re of SECRET) expect(re.test(svg)).toBe(false);
  });
});

describe('flip back scans', () => {
  const cases: [string, string][] = [
    [keyOf('b0asex'), payUri(ADDR)],
    [keyOf('vexvoid'), payUri(ADDR2)],
    [keyOf('nova'), payUri('1CHiwGJirHMUtMZDj6rzAFVK49XHuVEWda')],
    [keyOf('sam'), payUri('19sy4Um7n8CXMcZoTr1QypjQWoS7GiFNoN')],
    [keyOf('mira'), 'b0asex@bwalletx.com'],
    [keyOf('a-longer_name.x'), 'a-longer_name.x@bwalletx.com'],
  ];
  // One test per back, not one test for all 18 renders + zbar spawns: the single test sat at ~5s and timed out
  // whenever the full suite ran under load. Rasters are memoised so the whole-set jsQR check reuses them in any
  // order (also under --concurrent / --randomize) instead of depending on the per-back tests running first.
  const rasters = new Map<string, ReturnType<typeof rasterise>>();
  const raster = (svg: string, px: number) => {
    const k = `${px}:${svg}`;
    if (!rasters.has(k)) rasters.set(k, rasterise(svg, px));
    return rasters.get(k)!;
  };
  for (const [key, p] of cases) {
    test(`ZXing and zbar read the back for ${p} at 512, 240 and 160 px`, async () => {
      const svg = flipBackSvg(key, p);
      for (const px of [512, 240, 160]) {
        expect(zxing(await raster(svg, px))).toBe(p);
        const r = await zbar(svg, px);
        if (r !== undefined) expect(r).toBe(p); // undefined: zbarimg not installed (CI), decoder skipped
      }
    });
  }
  test('jsQR reads most backs', async () => {
    let j = 0,
      total = 0;
    for (const [key, p] of cases) {
      const svg = flipBackSvg(key, p);
      for (const px of [512, 240, 160]) {
        total++;
        if (jsqr(await raster(svg, px)) === p) j++;
      }
    }
    // jsQR, the weakest decoder, cannot read the site's Art QR at all; the tuned back reads in most cases.
    expect(j / total).toBeGreaterThanOrEqual(0.6);
  });
});
