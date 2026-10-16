/**
 * bit-sign phone numbers + SMS (feat/sms): every server call for Settings › Phone, Send by text
 * and contacts matching. While SMS is off on the server every route answers 503 `sms_disabled`;
 * `available()` turns that into "hide the feature", nothing is faked.
 *
 * Keys never go to the server except the one-time claim key inside the texted link's fragment,
 * which bit-sign passes to the SMS provider and does not store (see sendByText.ts).
 */
import { ChatApiError } from '../chat/api';

export type Caller = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  auth?: boolean,
) => Promise<unknown>;

export interface MyPhone {
  last4: string;
  masked: string;
  discoverable: boolean;
}

export interface TextDrop {
  code: string;
  to: string;
  funded_address: string;
  amount_sats: number;
  status: 'sent' | 'claimed' | 'reclaimed' | 'failed';
  expires_at: string;
}

export const PHONE = '/api/bitsign/me/phone';
export const DROPS = '/api/bitsign/sms/drops';
/** Estimate shown before Send by text (Telnyx UK list price, rounded up). */
export const TEXT_COST_LABEL = '≈ 4p per text';

const E164 = /^\+[1-9]\d{7,14}$/;

/** "+44 7700 900123" / "07700 900123" / "0044…" → "+447700900123"; null otherwise. Same rules as bit-sign. */
export function normE164(input: string | null | undefined): string | null {
  let s = (input || '').trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^07\d{9}$/.test(s)) s = `+44${s.slice(1)}`;
  return E164.test(s) ? s : null;
}

export const isSmsDisabled = (e: unknown) => e instanceof ChatApiError && e.status === 503;

export function parsePhone(v: unknown): MyPhone | null {
  const p = (v as { phone?: Record<string, unknown> | null })?.phone;
  if (!p || typeof p.last4 !== 'string' || !/^\d{4}$/.test(p.last4)) return null;
  return {
    last4: p.last4,
    masked: typeof p.masked === 'string' ? p.masked : `•••• ${p.last4}`,
    discoverable: p.discoverable !== false,
  };
}

export function parseMatches(v: unknown): { e164: string; paymail: string }[] {
  const list = (v as { matches?: unknown })?.matches;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => m as Record<string, unknown>)
    .filter(
      (m) =>
        typeof m.e164 === 'string' && typeof m.paymail === 'string' && /^[a-z0-9._-]+@bwalletx\.com$/.test(m.paymail),
    )
    .map((m) => ({ e164: m.e164 as string, paymail: m.paymail as string }));
}

/** GET /api/bitsign/sms/drops → the sender's texts (bit-sign PR #304). Bad rows are dropped. */
export function parseDrops(v: unknown): TextDrop[] {
  const list = (v as { drops?: unknown })?.drops;
  if (!Array.isArray(list)) return [];
  const ok = new Set(['sent', 'claimed', 'reclaimed', 'failed']);
  return list
    .map((d) => d as Record<string, unknown>)
    .filter(
      (d) =>
        typeof d.code === 'string' &&
        typeof d.amount_sats === 'number' &&
        typeof d.expires_at === 'string' &&
        ok.has(d.status as string),
    )
    .map((d) => ({
      code: d.code as string,
      to: typeof d.to === 'string' ? d.to : '',
      funded_address: typeof d.funded_address === 'string' ? d.funded_address : '',
      amount_sats: d.amount_sats as number,
      status: d.status as TextDrop['status'],
      expires_at: d.expires_at as string,
    }));
}

/** Same rule as bit-sign mayReclaim: after expiry, or at once when the text failed to send. */
export const mayReclaim = (d: Pick<TextDrop, 'status' | 'expires_at'>, now = Date.now()) =>
  d.status === 'failed' || (d.status === 'sent' && Date.parse(d.expires_at) <= now);

export class PhoneApi {
  constructor(private readonly call: Caller) {}

  /** null = SMS is switched off on the server (hide every phone feature). */
  async available(): Promise<{ phone: MyPhone | null } | null> {
    try {
      return { phone: parsePhone(await this.call('GET', PHONE)) };
    } catch (e) {
      if (isSmsDisabled(e) || (e instanceof ChatApiError && e.status === 404)) return null;
      throw e;
    }
  }

  start(e164: string) {
    return this.call('POST', `${PHONE}/start`, { e164 });
  }

  async verify(code: string): Promise<MyPhone | null> {
    return parsePhone(await this.call('POST', `${PHONE}/verify`, { code: code.trim() }));
  }

  remove() {
    return this.call('DELETE', PHONE);
  }

  /** Numbers from the phone's own contacts (≤ 200 per call) → paymails of people who verified them. */
  async match(numbers: string[]): Promise<{ e164: string; paymail: string }[]> {
    const list = [...new Set(numbers.map(normE164).filter((n): n is string => !!n))].slice(0, 200);
    if (!list.length) return [];
    return parseMatches(await this.call('POST', `${PHONE}/lookup`, { numbers: list }));
  }

  /** Body built field by field: never spread a local record (it holds the WIF). */
  createDrop(d: {
    to: string;
    funded_address: string;
    funding_txid: string;
    beef: string;
    amount_sats: number;
    wif: string;
  }) {
    return this.call('POST', DROPS, {
      to: d.to,
      funded_address: d.funded_address,
      funding_txid: d.funding_txid,
      beef: d.beef,
      amount_sats: d.amount_sats,
      fragment: `k=${d.wif}&t=${d.funding_txid}`,
    }) as Promise<{ ok?: boolean; code?: string; to?: string; expires_at?: string }>;
  }

  async myDrops(): Promise<TextDrop[]> {
    return parseDrops(await this.call('GET', DROPS));
  }

  reclaimed(code: string, sweepTxid: string) {
    return this.call('POST', `${DROPS}/${encodeURIComponent(code)}/reclaimed`, { sweep_txid: sweepTxid });
  }

  claimed(code: string, sweepTxid: string) {
    return this.call('POST', `${DROPS}/${encodeURIComponent(code)}/claimed`, { sweep_txid: sweepTxid });
  }
}
