// The $403 share token output: a 1Sat inscription (the share certificate) on top of the 2-of-2 / timelock lock.
import { buildInscriptionScript } from '@1sat/templates';
import { LockingScript, Utils } from '@bsv/sdk';
import { shareLock, type ShareLockParams } from './scripts';

export type ShareCertificate = {
  p: '403';
  op: 'allot';
  ticker: string;
  company: string;
  shareClass: string;
  shares: number;
  holder: string; // bit-sign handle on the register
  offerId: string;
  allottedAt: string; // ISO date of director approval
  register: string; // URL of the register entry (legal title lives there, not in this token)
};

export function certificateContent(c: ShareCertificate): Uint8Array {
  return Uint8Array.from(Utils.toArray(JSON.stringify(c), 'utf8'));
}

/** Locking script for the share token output (1 sat). */
export function shareTokenScript(c: ShareCertificate, lock: Omit<ShareLockParams, 'prefix'>): LockingScript {
  const s = buildInscriptionScript(shareLock(lock), certificateContent(c), 'application/json', {
    app: 'bshares',
    type: '403-share',
    ticker: c.ticker,
    offer: c.offerId,
  });
  return new LockingScript(s.chunks);
}
