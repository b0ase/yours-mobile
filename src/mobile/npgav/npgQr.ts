import * as qr from 'qrcode';

/** A plain QR (dark on white, quiet zone) as an SVG data URI. Public data only: a web link. */
export function qrDataUri(text: string): string {
  if (!/^https:\/\/[^\s]{1,400}$/.test(text)) return '';
  const m = qr.create(text, { errorCorrectionLevel: 'M' }).modules;
  const n = m.size;
  const q = 4;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(x, y)) d += `M${x + q} ${y + q}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0b0a08"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
