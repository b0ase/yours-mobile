/**
 * Token rooms — the wallet I/O: what this wallet holds, and proving the keys that hold it.
 *
 * bWallet is a BRC-100 wallet: every token output sits at its own derived key (change from a send
 * lands at `<tokenId>-<timestamp>`, receipts at the deposit keys `1sat <n>`), and none at the
 * identity address chat signs in with. So before bit-sign can see a holding, the wallet signs one
 * message with each key that holds room tokens (and with its deposit key, so inviters know where
 * to send) and posts the proofs. This is the wallet signing with its own keys — no transaction,
 * nothing spent.
 */
import { getBsv21Balances, type OneSatContext } from '@1sat/actions';
import { BSV21_BASKET, ONESAT_BASKET, ONESAT_PROTOCOL } from '@1sat/types';
import { Utils } from '@bsv/sdk';
import { roomMeta } from '../market/indexer';
import type { BchatClient } from './api';
import {
  addressProofMessage,
  derivationOf,
  normOutpoint,
  parseTokenKey,
  uniqueDerivations,
  type Derivation,
  type Holding,
} from './tokenRooms';

type Out = { outpoint: string; tags?: string[]; customInstructions?: string; spendable?: boolean };

async function basket(ctx: OneSatContext, name: string): Promise<Out[]> {
  const out: Out[] = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const res = await ctx.wallet
      .listOutputs({ basket: name, includeTags: true, includeCustomInstructions: true, limit: 500, offset })
      .catch(() => null);
    if (!res) break;
    out.push(...(res.outputs as Out[]).filter((o) => o.spendable !== false && o.outpoint));
    if (res.outputs.length < 500) break;
  }
  return out;
}

const collectionOf = (o: Out): string | null => {
  const t = o.tags?.find((x) => x.startsWith('collection:'));
  return t ? normOutpoint(t.slice('collection:'.length)) : null;
};

const bsv21IdOf = (o: Out): string | null => {
  try {
    const ci = o.customInstructions ? (JSON.parse(o.customInstructions) as { id?: string }) : null;
    if (ci?.id) return normOutpoint(ci.id);
  } catch {
    /* not JSON */
  }
  const t = o.tags?.find((x) => x.startsWith('bsv21:') && x !== 'bsv21:deploy' && x !== 'bsv21:auth');
  return t ? normOutpoint(t.slice(6)) : null;
};

/** BSV-21 balances (confirmed) and 1Sat collections (item counts) this wallet holds. */
export async function walletHoldings(ctx: OneSatContext): Promise<Holding[]> {
  const [tokens, items] = await Promise.all([
    getBsv21Balances.execute(ctx, {}).catch(() => []),
    basket(ctx, ONESAT_BASKET),
  ]);
  const out: Holding[] = [];
  for (const t of tokens) {
    const id = normOutpoint(t.id);
    const confirmed = String(t.all?.confirmed ?? 0);
    if (!id || confirmed === '0') continue;
    out.push({ kind: 'bsv21', id, symbol: (t.sym || id.slice(0, 6)).replace(/^\$/, ''), dec: t.dec || 0, amountRaw: confirmed, icon: t.icon ?? null });
  }
  const counts = new Map<string, number>();
  for (const o of items) {
    const c = collectionOf(o);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const colls = await Promise.all(
    [...counts].map(async ([id, n]) => {
      const meta = await roomMeta('coll', id).catch(() => null);
      return { kind: 'coll' as const, id, symbol: meta?.title || `Collection ${id.slice(0, 6)}`, dec: 0, amountRaw: String(n), icon: meta?.icon ?? null };
    }),
  );
  return out.concat(colls);
}

/**
 * Prove to bit-sign the keys that hold `key`'s token (or every room-token key, without a key),
 * plus the deposit key as this account's receive address. For a collection room, also name the
 * items so the server can verify them. Returns how many addresses were accepted.
 */
export async function proveHoldings(ctx: OneSatContext, client: BchatClient, key?: string): Promise<number> {
  const handle = client.handle;
  if (!handle) return 0;
  const want = key ? parseTokenKey(key) : null;
  const [tokenOuts, itemOuts] = await Promise.all([basket(ctx, BSV21_BASKET), basket(ctx, ONESAT_BASKET)]);
  const tokenSel = tokenOuts.filter((o) => !want || (want.kind === 'bsv21' && bsv21IdOf(o) === want.id));
  const itemSel = itemOuts.filter((o) => (want ? want.kind === 'coll' && collectionOf(o) === want.id : !!collectionOf(o)));

  const deposit: Derivation = { protocolID: ONESAT_PROTOCOL, keyID: '1sat 0', counterparty: 'self' };
  const derivations = uniqueDerivations([
    deposit,
    ...tokenSel.map((o) => derivationOf(o.customInstructions)),
    ...itemSel.map((o) => derivationOf(o.customInstructions)),
  ]);

  const message = addressProofMessage(handle, Date.now());
  const data = Utils.toArray(message, 'utf8');
  const proofs: { pubkey_hex: string; signature: string; role: 'receive' | 'token' }[] = [];
  for (const d of derivations) {
    try {
      const args = { protocolID: d.protocolID, keyID: d.keyID, counterparty: d.counterparty };
      const { publicKey } = await ctx.wallet.getPublicKey({ ...args, forSelf: true });
      const { signature } = await ctx.wallet.createSignature({ ...args, data });
      proofs.push({ pubkey_hex: publicKey, signature: Utils.toHex(signature), role: d === deposit ? 'receive' : 'token' });
    } catch {
      /* a key the wallet will not sign with is skipped, not fatal */
    }
  }
  const { accepted } = proofs.length ? await client.proveAddresses(message, proofs) : { accepted: [] };
  if (want?.kind === 'coll' && itemSel.length) {
    await client.proveItems(key!, itemSel.map((o) => o.outpoint)).catch(() => 0);
  }
  return accepted.length;
}
