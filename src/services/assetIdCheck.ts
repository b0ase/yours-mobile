/**
 * "Send / list this NFT" loads the asset by its tracking id (`id:` tag, @1sat/actions loadBasketOutput: limit 1) and
 * spends whatever comes back. If two outputs ever carried the same id (a hostile backup moving one NFT's id onto
 * another: review 16b, R2), the wallet could send the other one. Before such a spend, the id must load exactly the
 * outpoint the user is looking at, and only that one. The inbound sync check (services/inboundSync.ts) is the main
 * guard; this is the second.
 */
import { ORDINALS_BASKET } from '@1sat/types';

export const ASSET_ID_MISMATCH =
  "This NFT's tracking id doesn't point at this NFT alone, so nothing was sent. Tap Refresh, then try again.";

type Lister = {
  listOutputs(args: {
    basket: string;
    tags: string[];
    tagQueryMode: 'all';
    limit: number;
  }): Promise<{ outputs: { outpoint: string }[]; totalOutputs?: number }>;
};

const norm = (op: string) =>
  (op.length > 64 && op[64] === '_' ? `${op.slice(0, 64)}.${op.slice(65)}` : op).toLowerCase();

/** Does tracking id `id` load exactly `outpoint` (and nothing else) from `basket`? */
export async function assetIdIsOnly(
  wallet: Lister,
  id: string,
  outpoint: string,
  basket: string = ORDINALS_BASKET,
): Promise<boolean> {
  const tag = id.startsWith('id:') ? id : `id:${id}`;
  const r = await wallet.listOutputs({ basket, tags: [tag], tagQueryMode: 'all', limit: 2 });
  const total = typeof r.totalOutputs === 'number' ? r.totalOutputs : r.outputs.length;
  return total === 1 && r.outputs.length === 1 && norm(r.outputs[0].outpoint) === norm(outpoint);
}
