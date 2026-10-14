import sharp from 'sharp';
import jsQR from 'jsqr';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType, BarcodeFormat } from '@zxing/library';
import { bavatarQrSvg, BAVATAR_QR_STYLES, bitcoinUri } from '../src/mobile/bavatar/bavatarQr';
const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', KEY = '02' + 'ab'.repeat(32), want = bitcoinUri(ADDR);
const out = process.env.HOME + '/Desktop/bavatar-qr'; mkdirSync(out, { recursive: true });
let fails = 0;
for (const style of BAVATAR_QR_STYLES) for (const size of [256, 512, 1024]) {
  const svg = bavatarQrSvg(KEY, ADDR, { style, size, circle: true });
  // circle-cropped avatar placed on a dark UI background with padding, as a phone would see it
  const png = await sharp(Buffer.from(svg)).flatten({ background: '#1a1a1a' }).extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#1a1a1a' }).png().toBuffer();
  const file = `${out}/bavatar-qr-${style}-${size}.png`;
  if (size !== 256) writeFileSync(file, await sharp(Buffer.from(svg)).png().toBuffer());
  const tmp = process.env.TMPDIR + '/bavatar-qr-check.png'; writeFileSync(tmp, png);
  const res: string[] = [];
  for (const blur of [0, 1.5]) {
    const img = blur ? sharp(png).blur(blur * size / 512 + 0.3) : sharp(png);
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const j = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
    let z = '';
    try {
      const lum = new Int32Array(info.width * info.height);
      for (let i = 0; i < lum.length; i++) lum[i] = (data[i*4] << 16) | (data[i*4+1] << 8) | data[i*4+2];
      const r = new MultiFormatReader(); const h = new Map(); h.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]); h.set(DecodeHintType.TRY_HARDER, true);
      z = r.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, info.width, info.height))), h).getText();
    } catch {}
    if (blur) writeFileSync(tmp, await img.png().toBuffer());
    let zb = ''; try { zb = execSync(`zbarimg -q --raw ${tmp}`).toString().trim(); } catch {}
    const ok = (s?: string) => (s === want ? 'OK' : 'FAIL');
    res.push(`${blur ? 'blur' : 'sharp'}: jsQR ${ok(j?.data)} zxing ${ok(z)} zbar ${ok(zb)}`);
    if (j?.data !== want || z !== want || zb !== want) fails++;
  }
  console.log(style.padEnd(8), String(size).padEnd(5), res.join(' | '));
}
console.log('failures', fails);
