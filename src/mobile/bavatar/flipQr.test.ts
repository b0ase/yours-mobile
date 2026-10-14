import { describe, expect, test } from 'bun:test';
import { PAY_URI_RE, flipBackSvg, flipPayload, isPublicPayload, payUri, paymailPayload } from './flipQr';
import { decodeSvg, zxingSvg } from './flipQr.testkit';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ADDR2 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
const WIF_C = 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617';
const HEX = 'e9873d79c6d87dc0fb6a5778633389f4453213303da61f20bd67fc233aa33262';
const XPRV =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYMAIL_RE = /^[a-z0-9]([a-z0-9_.-]{0,30}[a-z0-9])?@[a-z0-9.-]+\.[a-z]{2,}$/;
const SECRET = [/[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/, /[0-9a-fA-F]{64}/, /[xt]prv/];

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
      for (const re of SECRET) expect(re.test(p)).toBe(false);
    }
    for (const s of [WIF, WIF_C, HEX, XPRV, SEED, `bitcoin:${ADDR}?k=${HEX}`, `bitcoin:${ADDR}?w=${WIF}`])
      expect(isPublicPayload(s)).toBe(false);
    expect(flipBackSvg(`bitcoin:${ADDR}?k=${HEX}`)).toBe('');
    expect(flipBackSvg(WIF)).toBe('');
  });

  test('the back SVG carries only the payload and the caption', () => {
    const svg = flipBackSvg(`bitcoin:${ADDR}`, { caption: '$alice' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('$alice');
    for (const re of SECRET) expect(re.test(svg)).toBe(false);
  });
});

describe('flip back scans (ZXing and jsQR agree)', () => {
  test('addresses and paymails at 512, 240, 160 px, with and without caption', async () => {
    const payloads = [payUri(ADDR), payUri(ADDR2), 'b0asex@bwalletx.com', 'a-longer_name.x@bwalletx.com'];
    let ok = 0,
      total = 0;
    for (const p of payloads)
      for (const caption of ['', '$a-longer_name.x'])
        for (const px of [512, 240, 160]) {
          total++;
          if ((await decodeSvg(flipBackSvg(p, { size: 512, caption }), px)) === p) ok++;
        }
    expect(ok).toBe(total);
  });

  test('ZXing reads at least 90% of the backs (it misses some matrices even as plain stock QR)', async () => {
    const addrs = [ADDR, ADDR2, '1CHiwGJirHMUtMZDj6rzAFVK49XHuVEWda', '19sy4Um7n8CXMcZoTr1QypjQWoS7GiFNoN'];
    const addrs2 = [
      '1Lv2GuNyHuG42PyyFWresKVLXuiawUjegq',
      '1HvwEBqUjBHReoA5PQbDsiY5tDEi1nkb7E',
      '1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp',
    ];
    let ok = 0,
      total = 0;
    for (const a of [...addrs, ...addrs2])
      for (const px of [512, 200]) {
        total++;
        if ((await zxingSvg(flipBackSvg(payUri(a), { caption: '$someone' }), px)) === payUri(a)) ok++;
      }
    expect(ok / total).toBeGreaterThanOrEqual(0.9);
  });
});
