// Round 2 gate: every variant × 6 keys × 3 addresses × {512,1024} × {sharp, mild blur}; jsQR, zbar, ZXing.
import sharp from 'sharp'; import jsQR from 'jsqr'; import { execSync } from 'node:child_process'; import { mkdirSync, writeFileSync } from 'node:fs';
import { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } from '@zxing/library';
import { bavatarArtCodeSvg, ART_CODE_VARIANTS } from '../src/mobile/bavatar/bavatarArtCode';
import { bitcoinUri } from '../src/mobile/bavatar/bavatarQr';
const addrs = ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '15ArtCgi3wmpQAAfYx4riaFmo4prJA4VsK'];
const out = process.env.HOME + '/Desktop/bavatar-qr/round2'; mkdirSync(out, { recursive: true });
const tmp = process.env.TMPDIR + '/bq-r2.png'; const only = process.argv[2];
for (const v of ART_CODE_VARIANTS) { if (only && v !== only) continue;
 const tally: Record<string, [number, number]> = {}; let maxBytes = 0;
 for (let k = 0; k < 6; k++) { const key = k === 0 ? '02' + 'ab'.repeat(32) : '0' + (2 + (k % 2)) + (k * 7919).toString(16).padStart(4, '0').repeat(16);
  for (const a of addrs) for (const size of [512, 1024]) {
   const svg = bavatarArtCodeSvg(key, a, { variant: v, size, circle: true, fringe: process.env.NOF ? false : undefined, halo: process.env.NOH ? false : undefined, logo: !!process.env.LOGO }); maxBytes = Math.max(maxBytes, new TextEncoder().encode(svg).length);
   if (k === 0 && a === addrs[0]) writeFileSync(`${out}/bavatar-art-${v}-${size}.png`, await sharp(Buffer.from(svg)).png().toBuffer());
   for (const blur of [0, size / 512]) {
    const base = sharp(Buffer.from(svg)).flatten({ background: '#1a1a1a' });
    const png = await (blur ? base.blur(blur) : base).png().toBuffer(); writeFileSync(tmp, png);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const want = bitcoinUri(a);
    const j = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' })?.data;
    let z = ''; try { const lum = new Int32Array(info.width * info.height); for (let i = 0; i < lum.length; i++) lum[i] = (data[i*4] << 16) | (data[i*4+1] << 8) | data[i*4+2];
     z = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, info.width, info.height)))).getText(); } catch {}
    let zb = ''; try { zb = execSync(`zbarimg -q --raw ${tmp}`).toString().trim(); } catch {}
    let zc = ''; if (process.env.ZXPY) try { zc = execSync(`${process.env.ZXPY} scripts/zxdec.py ${tmp}`).toString().trim(); } catch {}
    for (const [d, val] of [['jsQR', j], ['zbar', zb], ['zxing-cpp', zc], ['zxing-js', z]] as const) { const t = (tally[d] ??= [0, 0]); t[1]++; if (val === want) t[0]++; else if (process.env.V) console.log("  fail", d, k, a.slice(0,5), size, blur); }
   } } }
 console.log(v.padEnd(9), Object.entries(tally).map(([d, [o, n]]) => `${d} ${o}/${n}`).join('  '), ` maxBytes ${maxBytes}`);
}
