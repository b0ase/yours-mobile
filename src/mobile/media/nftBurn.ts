import { buildBurnOrdinals, executeTrackedAction, prepareP1SatArgs, type OneSatContext } from '@1sat/actions';
import { MAP } from '@1sat/templates';
import { ORDINALS_BASKET, ORDLOCK_V2_TAG, readAssetIdTag } from '@1sat/types';
import { OP, Script, type WalletOutput } from '@bsv/sdk';
import { RepeatGuard, repeatRefusal } from '../../services/repeatGuard';
import { getTagValue } from '../../utils/format';

/**
 * Burn an NFT (BWALLETX-MEDIA-SPEC §1, owner 12 Oct 2026: duplicates from failed mints). The ordinal is spent into
 * the standard 1Sat burn output from @1sat/actions buildBurnOrdinals: a 0-sat `OP_FALSE OP_RETURN` MAP
 * `app=1sat type=ord op=burn`, which indexers read as burned. Nothing goes to an address; the fee comes from the
 * wallet, as for a send. Pure helpers here so the rules are testable; NftDetail draws the screens.
 */

export const BURN_WORD = 'BURN';
export const BURN_HOLD_MS = 2000;

/** The standard 1Sat burn script (same as buildBurnOrdinals). */
export const burnScriptHex = (): string =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeScript(MAP.set({ app: '1sat', type: 'ord', op: 'burn' }))
    .toHex();

/** Provably unspendable: starts OP_FALSE OP_RETURN (00 6a). */
export const isUnspendable = (hex: string): boolean => hex.toLowerCase().startsWith('006a');

/** `txid_vout` shortened for screens. */
export const shortOutpoint = (o: string): string => {
  const [txid, vout = '0'] = o.split(/[._]/);
  return txid.length > 16 ? `${txid.slice(0, 8)}…${txid.slice(-6)}_${vout}` : `${txid}_${vout}`;
};

export const toUnderscore = (o: string): string => o.replace('.', '_');

/** Listed (OrdLock) items can't be burned: cancel the listing first. */
export const isListed = (o: Pick<WalletOutput, 'tags'>): boolean =>
  (o.tags ?? []).some((t) => t === ORDLOCK_V2_TAG || t === 'ordlock' || t.startsWith('price:'));
/** Time-locked items (spec §1 Lock) can't be burned. */
export const isLocked = (o: Pick<WalletOutput, 'tags'>): boolean =>
  (o.tags ?? []).some((t) => t === 'lock' || t.startsWith('lock:') || t.startsWith('locked'));

type Copyish = { output: Pick<WalletOutput, 'outpoint' | 'tags'>; origin: string; name: string; type?: string };

/** What makes two held items "the same file": origin, content pointer, content hash, or same title + type. */
const keysOf = (i: Copyish): string[] => {
  const k = [`o:${toUnderscore(i.origin)}`];
  const content = getTagValue(i.output.tags, 'content');
  if (content) k.push(`c:${toUnderscore(content)}`);
  for (const t of ['hash', 'sha256', 'contentHash']) {
    const h = getTagValue(i.output.tags, t);
    if (h) k.push(`h:${h.toLowerCase()}`);
  }
  // Re-mints of the same file get a new origin each time; their title and type match (vexvoid's triple mint).
  if (i.name && i.name !== 'Inscription' && i.type) k.push(`n:${i.name}\u0000${i.type}`);
  return k;
};

/** Other items in the wallet that are copies of `item` (never `item` itself). */
export const copiesOf = <T extends Copyish>(item: Copyish, all: T[]): T[] => {
  const mine = new Set(keysOf(item));
  return all.filter((o) => o.output.outpoint !== item.output.outpoint && keysOf(o).some((k) => mine.has(k)));
};

export const isLastCopy = (item: Copyish, all: Copyish[]): boolean => copiesOf(item, all).length === 0;

/** Whether Burn is offered at all, and why not. `onChain` from unbroadcast.ts (null = still checking / unknown). */
export const burnAvailability = (s: {
  onChain: boolean | null;
  listed: boolean;
  locked: boolean;
}): { show: boolean; reason?: string } => {
  if (s.onChain === false)
    return { show: false, reason: "This NFT's mint never reached the network, so there is nothing on chain to burn." };
  if (s.onChain === null) return { show: false };
  if (s.listed) return { show: false, reason: 'Listed for sale. Cancel the listing before burning.' };
  if (s.locked) return { show: false, reason: 'Locked. It can be burned after it unlocks.' };
  return { show: true };
};

/** The confirm button: typing BURN (any case, trimmed) or a 2 s hold. */
export const burnConfirmEnabled = (s: { typed: string; held: boolean; busy: boolean; done: boolean }): boolean =>
  !s.busy && !s.done && (s.typed.trim().toUpperCase() === BURN_WORD || s.held);

// One burn per outpoint while it's going out: a slow broadcast must never build a second one.
const guard = new RepeatGuard();
export const burnGuard = () => guard;
const fp = (outpoint: string) => `burn:${toUnderscore(outpoint)}`;

/** Errors raised before anything is signed or broadcast: safe to try again. */
const NOT_SENT = /insufficient|not enough|no funds|user (denied|rejected|cancel)/i;

export type BurnResult = { txid: string } | { error: string };

export async function burnNft(ctx: OneSatContext, output: WalletOutput): Promise<BurnResult> {
  const id = readAssetIdTag(output.tags);
  if (!id) return { error: 'This NFT is missing a tracking id, so it cannot be burned yet. Try Refresh NFTs.' };
  const earlier = guard.check(fp(output.outpoint));
  if (earlier) return { error: repeatRefusal(earlier) };
  const built = await buildBurnOrdinals(ctx, { ids: [id] });
  if ('error' in built) return { error: `Not burned: ${String(built.error)}.` };
  const { sources, ...createArgs } = built;
  // Belt and braces: the only output we add is the unspendable burn (change is added by the wallet).
  if (!createArgs.outputs?.length || !createArgs.outputs.every((o) => isUnspendable(o.lockingScript)))
    return { error: 'Not burned: the burn transaction had an unexpected output.' };
  const args = await prepareP1SatArgs(ctx, {
    ...createArgs,
    description: `Burn ordinal ${shortOutpoint(output.outpoint)}`,
    options: { randomizeOutputs: false },
  });
  guard.record(fp(output.outpoint), {});
  const spends = sources
    .map((o) => readAssetIdTag(o.tags))
    .flatMap((x) => (x ? [{ basket: ORDINALS_BASKET, id: x }] : []));
  try {
    const res = await executeTrackedAction(
      ctx.wallet,
      args,
      undefined,
      built.inputBEEF as number[] | undefined,
      undefined,
      {
        spends,
        permissionScheme: '1sat',
      },
    );
    if (!res.txid) throw new Error('the wallet returned no transaction');
    guard.record(fp(output.outpoint), { txid: res.txid });
    return { txid: res.txid };
  } catch (e) {
    // It may have gone out: keep the guard entry and say so, never "try again".
    const m = e instanceof Error ? e.message : String(e);
    if (NOT_SENT.test(m)) {
      guard.record(fp(output.outpoint), { aborted: true });
      return { error: `Not burned: ${m}.` };
    }
    return { error: `Not confirmed: ${m}. It may still have been sent, so check History before burning again.` };
  }
}
