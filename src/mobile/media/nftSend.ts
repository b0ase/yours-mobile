/**
 * Two-step NFT send (owner, 12 Oct 2026: "three clicks could be two"): 1) pick the recipient, 2) one "Send to <name>"
 * button. Pure state → button, so the rules are testable.
 */
export type NftSendState = {
  /** Resolved destination address ('' until the name box resolves one). */
  to: string;
  /** Name the box resolved ($b0asey, a paymail, or the address itself). */
  name?: string;
  status: 'empty' | 'typing' | 'loading' | 'error' | 'ready';
  busy: boolean;
  /** false = the NFT's transaction never reached the network (unbroadcast.ts): it can't be sent. */
  onChain: boolean | null;
};

export type NftSendButton = { label: string; enabled: boolean };

const shortAddr = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

export const nftSendButton = (s: NftSendState): NftSendButton => {
  if (s.onChain === false) return { label: 'Not on the blockchain yet', enabled: false };
  if (s.busy) return { label: 'Sending…', enabled: false };
  if (s.status === 'loading') return { label: 'Finding…', enabled: false };
  if (s.status !== 'ready' || !s.to) return { label: 'Choose who gets it', enabled: false };
  const who = s.name && s.name !== s.to ? s.name : shortAddr(s.to);
  return { label: `Send to ${who}`, enabled: true };
};

export { shortAddr };
