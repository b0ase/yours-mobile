/**
 * Remote agents: agents that run on our server, with their keys there and never in this phone.
 *
 * Read-only for now: bAgents shows who owns each one, its limits and its on-chain balance. Approve, Reject
 * and Stop (signed by the owner's wallet) come later. Fill `identityKey` and `receiveAddress` once the
 * server agent is set up; until then the entry reads "Waiting for setup".
 */
export interface RemoteAgent {
  name: string;
  owner: string;
  /** Hard daily spending cap, in USD. */
  dailyCapUsd: number;
  /** Payments above this (USD) need the owner's approval. */
  approvalAboveUsd: number;
  identityKey: string;
  receiveAddress: string;
}

export const REMOTE_AGENTS: RemoteAgent[] = [
  {
    name: 'bmovies',
    owner: '@b0asex',
    dailyCapUsd: 1.3, // £1
    approvalAboveUsd: 0.13, // 10p
    identityKey: '',
    receiveAddress: '',
  },
];

export const isRemoteAgentReady = (a: RemoteAgent) => !!a.identityKey && !!a.receiveAddress;

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** Confirmed + unconfirmed satoshis at the agent's receive address, read from WhatsOnChain. */
export async function remoteAgentBalanceSats(address: string, fetcher: typeof fetch = fetch): Promise<number> {
  const res = await fetcher(`${WOC}/address/${encodeURIComponent(address)}/balance`);
  if (!res.ok) throw new Error(`balance ${res.status}`);
  const j = (await res.json()) as { confirmed?: number; unconfirmed?: number };
  return (j.confirmed ?? 0) + (j.unconfirmed ?? 0);
}
