// bShares companies: any company, bCorp first. The company is a bChatX token room that chose to incorporate
// (token → rooms → Partnership shares → Incorporate → bShares). Directors contribute PUBLIC keys from their own
// wallet; nothing here sends or stores a private key.
//
// KEEP IN STEP with bit-sign src/lib/bshares-company.ts (consentMessage, signKeyID, protocols): the server
// verifies these exact strings.
import type { OneSatContext } from '@1sat/actions';

export const BSHARES_SIGN_PROTOCOL: [2, string] = [2, 'bshares director'];
export const BSHARES_TREASURY_PROTOCOL: [2, string] = [2, 'bshares treasury'];
export const JURISDICTIONS = ['GB', 'GB-SCT', 'GB-NIR', 'IE', 'US', 'CA', 'AU', 'NZ', 'SG', 'HK', 'OTHER'] as const;

export type CompanyListing = { ticker: string; name: string; role: 'director' | 'member'; bsharesReady: boolean };
export type BoardMember = { id: string; handle: string; name: string; office: string; hasKeys: boolean };

export type ConsentAct =
  | { kind: 'keys'; roomId: string; ticker: string; handle: string; treasuryPubkey: string; at: string }
  | { kind: 'appoint-director'; roomId: string; ticker: string; subject: string; at: string }
  | { kind: 'treasury'; roomId: string; ticker: string; m: number; pubkeys: string[]; at: string };

export function consentMessage(act: ConsentAct): string {
  const head = `bShares ${act.kind} · company room ${act.roomId} ($${act.ticker})`;
  switch (act.kind) {
    case 'keys':
      return `${head}\nI, $${act.handle}, consent to act as a director and contribute treasury key ${act.treasuryPubkey}.\n${act.at}`;
    case 'appoint-director':
      return `${head}\nI approve appointing $${act.subject} as a director.\n${act.at}`;
    case 'treasury':
      return `${head}\nI approve the treasury ${act.m}-of-${act.pubkeys.length}: ${act.pubkeys.join(',')}.\n${act.at}`;
  }
}
export const signKeyID = (roomId: string, subject: string) => `${roomId}:${subject}`.slice(0, 200);
/** The subject each act is signed under (server: keys route, directors route, treasury route). */
export const actSubject = (act: ConsentAct) =>
  act.kind === 'keys'
    ? `keys:${act.handle}`
    : act.kind === 'appoint-director'
      ? `appoint:${act.subject}`
      : `treasury:${act.m}:${act.pubkeys.join(',')}`;

const toHex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

/** One wallet approval sheet: sign this act with the identity-linked director key. */
export async function signAct(ctx: OneSatContext, act: ConsentAct): Promise<string> {
  const { signature } = await ctx.wallet.createSignature({
    protocolID: BSHARES_SIGN_PROTOCOL,
    keyID: signKeyID(act.roomId, actSubject(act)),
    counterparty: 'anyone',
    data: Array.from(new TextEncoder().encode(consentMessage(act))),
  });
  return toHex(signature);
}

export async function identityKey(ctx: OneSatContext): Promise<string> {
  return (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey;
}

/**
 * The director's treasury key for this company: derived from the seed (protocol + room id), so the slot is
 * recoverable from the backup alone. Same derivation every time.
 */
export async function treasuryKey(ctx: OneSatContext, roomId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: BSHARES_TREASURY_PROTOCOL,
    keyID: roomId,
    counterparty: 'self',
  });
  return publicKey;
}

/** M choices for N directors: every M from 1..N, with a sensible default (majority). */
export const treasuryChoices = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
export const defaultM = (n: number) => (n <= 1 ? 1 : Math.floor(n / 2) + 1);

/** Pence/nano helpers for the share-class form: "£0.000001" → nano-pounds. */
export function poundsToNano(input: string): number {
  const v = input.trim().replace(/^£/, '');
  if (!/^\d+(\.\d{1,9})?$/.test(v)) throw new Error('Nominal value like 0.000001');
  const [w, f = ''] = v.split('.');
  const nano = Number(w) * 1e9 + Number((f + '000000000').slice(0, 9));
  if (!Number.isSafeInteger(nano) || nano <= 0) throw new Error('Nominal value must be above £0');
  return nano;
}
