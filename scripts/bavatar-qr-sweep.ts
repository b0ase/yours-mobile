// Broad sweep: many identity keys × addresses × styles at 512, sharp and blurred, three decoders.
import sharp from 'sharp'; import jsQR from 'jsqr'; import { execSync } from 'node:child_process'; import { writeFileSync } from 'node:fs';
import { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } from '@zxing/library';
import { bavatarQrSvg, BAVATAR_QR_STYLES, bitcoinUri } from '../src/mobile/bavatar/bavatarQr';
const addrs = ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '15ArtCgi3wmpQAAfYx4riaFmo4prJA4VsK'];
const tmp = process.env.TMPDIR + '/bq-sweep.png'; const tally: Record<string, [number, number]> = {};
for (let k = 0; k < 6; k++) { const key = '0' + (2 + (k % 2)) + (k * 7919).toString(16).padStart(4, '0').repeat(16);
 for (const a of addrs) for (const style of BAVATAR_QR_STYLES) for (const blur of [0, 1.2]) {
  let img = sharp(Buffer.from(bavatarQrSvg(key, a, { style, size: 512, circle: true }))).flatten({ background: '#1a1a1a' });
  const png = await (blur ? img.blur(blur) : img).png().toBuffer(); writeFileSync(tmp, png);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const want = bitcoinUri(a);
  const j = jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
  let z = ''; try { const lum = new Int32Array(info.width * info.height); for (let i = 0; i < lum.length; i++) lum[i] = (data[i*4] << 16) | (data[i*4+1] << 8) | data[i*4+2];
   z = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, info.width, info.height)))).getText(); } catch {}
  let zb = ''; try { zb = execSync(`zbarimg -q --raw ${tmp}`).toString().trim(); } catch {}
  for (const [d, v] of [['jsQR', j], ['zxing', z], ['zbar', zb]] as const) { const t = (tally[style + ' ' + d] ??= [0, 0]); t[1]++; if (v === want) t[0]++; }
 } }
for (const [k, [ok, n]] of Object.entries(tally)) console.log(k.padEnd(16), `${ok}/${n}`);
