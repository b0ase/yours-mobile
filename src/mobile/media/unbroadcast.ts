import type { WalletInterface } from '@bsv/sdk';

/**
 * Transactions the network never saw: a mint or send that failed before broadcast. Their outputs are only in this
 * wallet's records, so an NFT from one of them isn't really owned yet and can't be sent (vexvoid, 12 Oct 2026: four
 * "NFTs" were failed mints and every send of them failed). Media lists hide them.
 */
export const NOT_ON_CHAIN = new Set(['nosend', 'unsigned', 'nonfinal', 'failed']);

const PAGE = 500;
const MAX = 2000;

export async function unbroadcastTxids(wallet: Pick<WalletInterface, 'listActions'>): Promise<Set<string>> {
  const out = new Set<string>();
  for (let offset = 0; offset < MAX; offset += PAGE) {
    const r = await wallet.listActions({ labels: [], limit: PAGE, offset });
    for (const a of r.actions ?? []) if (a.txid && NOT_ON_CHAIN.has(String(a.status))) out.add(a.txid);
    if ((r.actions?.length ?? 0) < PAGE || offset + PAGE >= (r.totalActions ?? 0)) break;
  }
  return out;
}

/** The txid of a wallet outpoint (`txid.vout` or `txid_vout`). */
export const txidOf = (outpoint: string) => outpoint.split(/[._]/)[0];
