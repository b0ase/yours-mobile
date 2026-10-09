import { listOrdinals, sendAllBsv, sendBsv21, sendOrdinals, type OneSatContext } from '@1sat/actions';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { activeNftQuarantine } from '../airdrops/inbox';
import { normId } from '../airdrops/quarantine';
import { appendAgentLog } from './agentAccounts';

/**
 * Sweep back (docs/SMART-WALLET-SPEC.md §1): move everything in the CURRENT account (an agent account) to
 * another account: every BSV-21 token, every NFT that isn't listed for sale, then all BSV last (it pays the
 * fees of the earlier steps). Each step is logged; one failing step doesn't stop the others.
 */
export type SweepResult = { tokens: number; nfts: number; bsvTxid: string | null; errors: string[] };

export async function sweepBack(
  ctx: OneSatContext,
  agentId: string,
  to: { bsvAddress: string; ordAddress: string; label: string },
): Promise<SweepResult> {
  const out: SweepResult = { tokens: 0, nfts: 0, bsvTxid: null, errors: [] };
  const log = (action: string, detail: string, txid?: string) =>
    appendAgentLog(agentId, { at: Date.now(), action, detail, usd: 0, txid });

  const balances = await heldBsv21Balances(ctx).catch(() => []);
  for (const b of balances) {
    const amount = BigInt(b.all.confirmed);
    if (amount <= 0n || !b.id) continue;
    const r = await sendBsv21
      .execute(ctx, { tokenId: b.id, recipients: [{ amount, destination: { address: to.ordAddress } }] })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), txid: undefined }));
    if (r.txid) {
      out.tokens++;
      log('sweep', `Sent all $${b.sym ?? 'token'} to ${to.label}`, r.txid);
    } else out.errors.push(`$${b.sym ?? b.id}: ${r.error ?? 'failed'}`);
  }

  const { outputs } = await listOrdinals.execute(ctx, { limit: 500, offset: 0 }).catch(() => ({ outputs: [] }));
  // Quarantined NFTs stay put: sweeping them with yours would link your coins to their sender.
  const qNfts = activeNftQuarantine();
  const nfts = outputs.filter((o) => !o.tags?.includes('ordlock') && !qNfts.has(normId(o.outpoint)));
  if (nfts.length) {
    const r = await sendOrdinals
      .execute(ctx, { transfers: nfts.map((o) => ({ id: o.outpoint, address: to.ordAddress })) })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), txid: undefined }));
    if (r.txid) {
      out.nfts = nfts.length;
      log('sweep', `Sent ${nfts.length} NFT${nfts.length === 1 ? '' : 's'} to ${to.label}`, r.txid);
    } else out.errors.push(`NFTs: ${r.error ?? 'failed'}`);
  }

  const r = await sendAllBsv
    .execute(ctx, { destination: to.bsvAddress })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), txid: undefined }));
  if (r.txid) {
    out.bsvTxid = r.txid;
    log('sweep', `Sent all BSV to ${to.label}`, r.txid);
  } else if (r.error && !/no (utxos|funds)|insufficient|nothing/i.test(r.error)) out.errors.push(`BSV: ${r.error}`);

  return out;
}
