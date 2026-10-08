/**
 * Lock receipts: an optional 1Sat inscription in the SAME transaction as the lock outputs.
 *
 * The receipt is an SVG card (bWalletX gold) with the machine-readable JSON inside a <metadata> element
 * and in the inscription's MAP. It proves nothing by itself, since anyone can inscribe a picture. Its
 * value is that the verifier (verify.ts) reads the transaction it lives in and checks the lock outputs
 * there. The receipt cannot carry its own txid (that is a hash of the transaction containing it), so it
 * names outputs by vout and the verifier uses the receipt's own txid.
 */
import { Script, Utils } from '@bsv/sdk';
import { curveLabel, type Curve } from './curves';
import { fmtBsv, fmtUsd, type Piece } from './schedule';

export const RECEIPT_TYPE = 'lock-receipt';
export const VERIFY_URL = 'https://bwalletx.com/lock/verify';

export type ReceiptMode = 'date' | 'bsv' | 'usd-target' | 'percent';
export type ReceiptIdentity = { handle?: string; paymail?: string; idKey?: string; address: string };
export type Receipt = {
  app: 'bwalletx';
  type: typeof RECEIPT_TYPE;
  v: 1;
  mode: ReceiptMode;
  amountSats: number;
  /** USD value at lock time (the wallet's rate then), for display only. */
  usdAtLock?: number;
  usdPerPayout?: number;
  bufferPct?: number;
  /** Percent mode: X% per payout, of the original amount or of what is left. */
  pct?: number;
  pctBase?: 'original' | 'remaining';
  /** Gradual schedules shaped by an unlock curve (absent = linear). */
  curve?: Curve;
  /** The address whose key can claim the locks (inside every lock script). */
  lockAddress: string;
  schedule: { vout: number; height: number; sats: number }[];
  identity: ReceiptIdentity;
  lockedAt: string;
  verify: string;
};

export function buildReceipt(o: {
  mode: ReceiptMode;
  pieces: Pick<Piece, 'height' | 'sats'>[];
  lockAddress: string;
  identity: ReceiptIdentity;
  rate?: number;
  usdPerPayout?: number;
  bufferPct?: number;
  pct?: number;
  pctBase?: 'original' | 'remaining';
  curve?: Curve;
  now?: Date;
}): Receipt {
  const amountSats = o.pieces.reduce((s, p) => s + p.sats, 0);
  return {
    app: 'bwalletx',
    type: RECEIPT_TYPE,
    v: 1,
    mode: o.mode,
    amountSats,
    ...(o.rate && o.rate > 0 ? { usdAtLock: Math.round((amountSats / 1e8) * o.rate * 100) / 100 } : {}),
    ...(o.mode === 'usd-target' ? { usdPerPayout: o.usdPerPayout, bufferPct: o.bufferPct } : {}),
    ...(o.mode === 'percent' ? { pct: o.pct, pctBase: o.pctBase } : {}),
    ...(o.curve && o.curve.kind !== 'linear' ? { curve: o.curve } : {}),
    lockAddress: o.lockAddress,
    // Lock outputs come first, in schedule order (vout 0..n-1); the receipt follows them.
    schedule: o.pieces.map((p, i) => ({ vout: i, height: p.height, sats: p.sats })),
    identity: o.identity,
    lockedAt: (o.now ?? new Date()).toISOString(),
    verify: VERIFY_URL,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One-line schedule summary for the card. */
export function scheduleLine(r: Receipt): string {
  const n = r.schedule.length;
  const first = r.schedule[0]?.height;
  const last = r.schedule[n - 1]?.height;
  if (n === 1) return `Unlocks at block ${first}`;
  if (r.curve) return `${n} payouts, blocks ${first}–${last}`;
  const per =
    r.mode === 'usd-target' && r.usdPerPayout ? `${fmtUsd(r.usdPerPayout)} target` : fmtBsv(r.schedule[0].sats);
  return `${n} payouts of ${per}, blocks ${first}–${last}`;
}

/** "curve: back-loaded ×2", or '' for a linear schedule. */
export const curveText = (r: Pick<Receipt, 'curve'>): string =>
  r.curve && r.curve.kind !== 'linear' ? `curve: ${curveLabel(r.curve)}` : '';

/** The verifier's one-line description of what a receipt claims. */
export const describeReceipt = (r: Receipt): string => [modeText(r), curveText(r)].filter(Boolean).join(' · ');

export const modeText = (r: Receipt): string =>
  r.mode === 'date'
    ? 'One unlock date'
    : r.mode === 'usd-target'
      ? `Dollar target ${fmtUsd(r.usdPerPayout ?? 0)} ${r.curve ? 'average ' : ''}per payout (${r.bufferPct ?? 0}% buffer)`
      : r.mode === 'percent'
        ? `${r.pct}% of ${r.pctBase === 'remaining' ? 'what is left' : 'the original'} per payout`
        : r.curve
          ? `${fmtBsv(Math.round(r.amountSats / Math.max(1, r.schedule.length)))} average per payout`
          : `${fmtBsv(r.schedule[0]?.sats ?? 0)} per payout`;

/** The card: amount, USD at lock time, mode and target, schedule, and every identity field the account has. */
export function receiptSvg(r: Receipt): string {
  const lines: [string, number, string][] = [];
  const add = (text: string, size = 17, color = '#F2F2F0') => lines.push([text, size, color]);
  if (r.usdAtLock != null) add(`≈ ${fmtUsd(r.usdAtLock)} at lock time`, 18, '#98A2B3');
  add(modeText(r));
  if (r.curve) add(curveText(r), 17, '#F5B800');
  add(scheduleLine(r));
  if (r.identity.handle) add(`Locked by ${r.identity.handle}`);
  if (r.identity.paymail) add(`Paymail ${r.identity.paymail}`, 15, '#98A2B3');
  if (r.identity.idKey) add(`Identity key ${r.identity.idKey}`, 11, '#98A2B3');
  add(`Address ${r.identity.address}`, 13, '#98A2B3');
  let y = 175;
  const body = lines
    .map(([t, size, color]) => {
      const out = `<text x="40" y="${y}" fill="${color}" font-size="${size}">${esc(t)}</text>`;
      y += size + 14;
      return out;
    })
    .join('');
  const h = y + 70;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${h}" viewBox="0 0 640 ${h}"><metadata id="lock-receipt">${esc(JSON.stringify(r))}</metadata><rect width="640" height="${h}" rx="28" fill="#0b0b0c"/><rect x="10" y="10" width="620" height="${h - 20}" rx="22" fill="none" stroke="#F5B800" stroke-width="2"/><g font-family="Helvetica,Arial,sans-serif"><text x="40" y="70" fill="#F5B800" font-size="22" font-weight="700">bWalletX · Lock receipt</text><text x="40" y="135" fill="#F2F2F0" font-size="46" font-weight="800">${esc(fmtBsv(r.amountSats))}</text>${body}<text x="40" y="${h - 50}" fill="#F5B800" font-size="16">Verify at bwalletx.com/lock/verify</text><text x="40" y="${h - 28}" fill="#667085" font-size="13">Nobody can unlock these coins before the heights in this receipt.</text></g></svg>`;
}

/** MAP fields for the inscription (MAP values are strings). */
export const receiptMap = (r: Receipt): Record<string, string> => ({
  app: 'bwalletx',
  type: RECEIPT_TYPE,
  name: 'bWalletX lock receipt',
  receipt: JSON.stringify(r),
});

/** The inscription content (`OP_FALSE OP_IF "ord" … OP_0 <content> OP_ENDIF`) of a locking script, if any. */
export function inscriptionOf(script: Script): { contentType: string; content: number[] } | null {
  const ch = script.chunks;
  for (let i = 0; i + 2 < ch.length; i++) {
    if (ch[i].op !== 0 || ch[i + 1].op !== 0x63) continue;
    const tag = ch[i + 2].data;
    if (!tag || Utils.toUTF8(tag) !== 'ord') continue;
    let contentType = '';
    for (let j = i + 3; j + 1 < ch.length && ch[j].op !== 0x68; j += 2) {
      const field = ch[j];
      const value = ch[j + 1].data ?? [];
      const key = field.op === 0x51 ? 1 : field.op === 0 ? 0 : field.data?.length === 1 ? field.data[0] : -1;
      if (key === 1) contentType = Utils.toUTF8(value);
      if (key === 0) return { contentType, content: value };
    }
  }
  return null;
}

/** Read a receipt from an inscription script; null if it is not one of ours. */
export function parseReceipt(script: Script): Receipt | null {
  const ins = inscriptionOf(script);
  if (!ins || !ins.contentType.startsWith('image/svg')) return null;
  const m = /<metadata id="lock-receipt">([\s\S]*?)<\/metadata>/.exec(Utils.toUTF8(ins.content));
  if (!m) return null;
  try {
    const json = m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const r = JSON.parse(json) as Receipt;
    return r && r.type === RECEIPT_TYPE && Array.isArray(r.schedule) ? r : null;
  } catch {
    return null;
  }
}
