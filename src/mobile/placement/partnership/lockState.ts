// Wire types for bit-sign's partner lock mailbox (/api/bitsign/bshares/partnership/<ticker>/lock).
import type { PartnerProposal, TransferRule } from './partnerLock';

export type PartnerLockState = {
  ticker: string;
  tokenId: string | null;
  supply: number | null;
  myShareBps: number | null;
  partnershipId: string;
  agreementVersion: number | null;
  rule: TransferRule | null;
  keys: { handle: string; partnerKey: string }[];
  keyset: { complete: boolean; m: number; pubKeys: string[] } | null;
  myKey: string | null;
  holdings: { outpoint: string; holder: string; amt: string; rawTx: string }[];
  proposals: {
    id: string;
    kind: PartnerProposal['kind'];
    summary: string;
    proposedBy: string;
    createdAt: string;
    proposal: PartnerProposal;
    signatureNeeded: boolean;
  }[];
};

export type PartnerLockAction =
  | { action: 'key'; partnerKey: string; identityKey: string; at: string; signature: string }
  | { action: 'holding'; outpoint: string; rawTx: string; holder: string; amt: string }
  | { action: 'propose'; proposal: PartnerProposal }
  | { action: 'sign'; id: string; sigs: PartnerProposal['sigs'] }
  | { action: 'broadcast'; id: string; txid: string }
  | { action: 'withdraw'; id: string };

/** What the identity key signs to bind this wallet's partner lock key. KEEP IN STEP with bit-sign partner-lock.ts. */
export const lockKeyMessage = (o: { roomId: string; handle: string; partnerKey: string; at: string }) =>
  `Partnership shares lock · room ${o.roomId}\nI, $${o.handle}, use partner key ${o.partnerKey} for our partnership shares lock.\n${o.at}`;
export const PARTNER_SIGN_PROTOCOL: [2, string] = [2, 'bshares partner'];
export const lockKeyKeyID = (roomId: string) => `${roomId}:lockkey`;
