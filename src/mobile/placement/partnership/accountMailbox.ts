// Wire types and pure helpers for bit-sign's shared-account mailbox (/api/bitsign/bshares/partnership/<ticker>/account).
// The mailbox only carries requests: the wallet still checks every request against the account's keys
// (checkAccountProposal) and keeps only signatures that verify, so a wrong or tampered server copy adds nothing.
import { mergeSignatures } from './multisig';
import type { Keyset } from './partnerLock';
import { checkAccountProposal, type AccountProposal } from './accountRules';

export type AccountMailboxState = {
  ticker: string;
  partnershipId: string;
  agreementVersion: number | null;
  rule: { kind: 'majority'; m: number } | { kind: 'unanimous' } | null;
  keyset: { complete: boolean; m: number; pubKeys: string[] } | null;
  myKey: string | null;
  accountScript: string | null;
  proposals: {
    id: string;
    summary: string;
    proposedBy: string;
    createdAt: string;
    proposal: AccountProposal;
    ready: boolean;
    stale: boolean;
    signatureNeeded: boolean;
  }[];
};

export type AccountMailboxAction =
  | { action: 'propose'; proposal: AccountProposal }
  | { action: 'sign'; id: string; sigs: Record<string, Record<string, string>> }
  | { action: 'broadcast'; id: string; txid: string }
  | { action: 'withdraw'; id: string };

/** A request as the wallet shows it: the checked proposal plus where it lives on the mailbox (if it does). */
export type MailboxRequest = { proposal: AccountProposal; mailboxId: string | null; stale: boolean; from: string };

/** Only this partner's signatures, in the shape the 'sign' action takes. Empty when there are none. */
export function mySigs(p: AccountProposal, myKey: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [i, byKey] of Object.entries(p.sigs)) {
    const s = byKey?.[myKey];
    if (s) out[i] = { [myKey]: s };
  }
  return out;
}

/**
 * Mailbox requests → what this wallet will show. Each is checked against the account's keys (a request that fails is
 * dropped) and starts from no signatures, gaining only the ones that verify. Requests for another partnership are
 * dropped too.
 */
export function fromMailbox(state: AccountMailboxState, keyset: Keyset, partnershipId: string): MailboxRequest[] {
  const out: MailboxRequest[] = [];
  for (const r of state.proposals ?? []) {
    const p = r.proposal;
    if (!p || p.partnershipId !== partnershipId) continue;
    try {
      checkAccountProposal(p, keyset);
      out.push({
        proposal: mergeSignatures({ ...p, sigs: {} } as AccountProposal, p),
        mailboxId: r.id,
        stale: !!r.stale,
        from: r.proposedBy,
      });
    } catch {
      /* not a payment this account would make: never shown */
    }
  }
  return out;
}

/**
 * Local requests (pasted, or proposed while the mailbox was down) plus mailbox ones, one entry per proposalId.
 * Signatures from both copies are combined (verified only); the mailbox id is kept when the mailbox has it.
 */
export function combineRequests(local: AccountProposal[], remote: MailboxRequest[]): MailboxRequest[] {
  const out: MailboxRequest[] = remote.map((r) => ({ ...r }));
  for (const p of local) {
    const i = out.findIndex((r) => r.proposal.proposalId === p.proposalId);
    if (i < 0) {
      out.push({ proposal: p, mailboxId: null, stale: false, from: p.proposedBy });
      continue;
    }
    try {
      out[i] = { ...out[i], proposal: mergeSignatures(out[i].proposal, p) };
    } catch {
      /* same id, different transaction: keep the mailbox copy */
    }
  }
  return out;
}

/** No answer, signed out of bChatX, no mailbox (404) or a server error: the wallet offers sharing by message instead. */
export const isMailboxUnavailable = (status: number | undefined) =>
  status === undefined || status === 0 || status === 401 || status === 404 || status >= 500;
