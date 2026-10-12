import type { WalletInterface } from '@bsv/sdk';

/**
 * Transactions the network never saw: a mint or send that failed before broadcast. Their outputs are only in this
 * wallet's records, so an NFT from one of them isn't really owned yet and can't be sent (vexvoid, 12 Oct 2026: four
 * "NFTs" were failed mints and every send of them failed). Media lists hide them.
 */
export const NOT_ON_CHAIN = new Set(['nosend', 'unsigned', 'nonfinal', 'failed']);
/**
 * Signed and queued for the network, but not on chain yet ('sending': the broadcaster gave no verdict and the
 * Monitor keeps retrying; 'unprocessed': not yet handed over). Shown as "Pending, not on chain yet", never as owned
 * (vexvoid.com, 12 Oct 2026: a big video mint queued as 'sending' showed as an owned NFT).
 */
export const PENDING_ON_CHAIN = new Set(['sending', 'unprocessed']);

const PAGE = 500;
const MAX = 2000;

export type TxStates = { offChain: Set<string>; pending: Set<string> };

/** The wallet's own transactions that are not on chain: never broadcast (offChain) or still going out (pending). */
export async function walletTxStates(wallet: Pick<WalletInterface, 'listActions'>): Promise<TxStates> {
  const out: TxStates = { offChain: new Set(), pending: new Set() };
  for (let offset = 0; offset < MAX; offset += PAGE) {
    const r = await wallet.listActions({ labels: [], limit: PAGE, offset });
    for (const a of r.actions ?? []) {
      if (!a.txid) continue;
      if (NOT_ON_CHAIN.has(String(a.status))) out.offChain.add(a.txid);
      else if (PENDING_ON_CHAIN.has(String(a.status))) out.pending.add(a.txid);
    }
    if ((r.actions?.length ?? 0) < PAGE || offset + PAGE >= (r.totalActions ?? 0)) break;
  }
  return out;
}

export async function unbroadcastTxids(wallet: Pick<WalletInterface, 'listActions'>): Promise<Set<string>> {
  return (await walletTxStates(wallet)).offChain;
}

/** The txid of a wallet outpoint (`txid.vout` or `txid_vout`). */
export const txidOf = (outpoint: string) => outpoint.split(/[._]/)[0];
