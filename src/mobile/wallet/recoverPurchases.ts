import { PublicKey, type WalletInterface } from '@bsv/sdk';
import { BSV21_BASKET, P1SAT_PROTOCOL, bsv21FilterTags, buildBsv21CustomInstructions } from '@1sat/actions';
import { buildTokenLabel } from '@1sat/types';

/**
 * Find BSV-21 tokens this wallet bought on the market that its storage has no record of (owner,
 * 4 Oct 2026: purchases made while the 1Sat backup was failing never reached it, so a restore or a
 * second device didn't show them). A buy sends the tokens to a key the wallet derives from public data
 * — protocol P1SAT, keyID `${tokenId}-${listingOutpoint}` (@1sat/actions buyBsv21) — so each recent
 * market sale can be checked against this wallet's keys and, if it's ours and unspent, filed back
 * into the bsv21 basket with internalizeAction.
 */
const GP = 'https://ordinals.gorillapool.io/api';
const ONESAT = 'https://api.1sat.app/1sat';

type Sale = { id: string; outpoint: string; spend: string; amt: string; sym?: string; dec?: number; icon?: string };
type Txo = { outpoint: string; owner?: string; spend?: string };

export type RecoverResult = { checked: number; found: { sym: string; amt: string }[]; held: string[]; failed: string[] };

const sales = async (pages: number): Promise<Sale[]> => {
  const all: Sale[] = [];
  for (let p = 0; p < pages; p++) {
    const r = await fetch(`${GP}/bsv20/market/sales?limit=100&offset=${p * 100}&dir=desc&type=v2`);
    if (!r.ok) break;
    const rows = (await r.json()) as Sale[];
    all.push(...rows.filter((s) => s.id && s.outpoint && s.spend));
    if (rows.length < 100) break;
  }
  return all;
};

const txos = async (outpoints: string[]): Promise<Map<string, Txo>> => {
  const out = new Map<string, Txo>();
  for (let i = 0; i < outpoints.length; i += 100) {
    const r = await fetch(`${GP}/txos/outpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(outpoints.slice(i, i + 100)),
    });
    if (!r.ok) continue;
    for (const t of (await r.json()) as Txo[]) if (t?.outpoint) out.set(t.outpoint, t);
  }
  return out;
};

export async function recoverPurchases(wallet: WalletInterface, pages = 10): Promise<RecoverResult> {
  const list = await sales(pages);
  const owners = await txos(list.map((s) => `${s.spend}_0`));
  const result: RecoverResult = { checked: list.length, found: [], held: [], failed: [] };

  for (const s of list) {
    const txo = owners.get(`${s.spend}_0`);
    if (!txo?.owner || txo.spend) continue; // unknown, or already moved on
    // Our Market passes the listing as `txid.vout` (walletOutpoint); other callers may use `txid_vout`.
    let keyID = '';
    for (const op of [s.outpoint.replace(/_(\d+)$/, '.$1'), s.outpoint]) {
      const k = `${s.id}-${op}`;
      const { publicKey } = await wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID: k, counterparty: 'self', forSelf: true });
      if (PublicKey.fromString(publicKey).toAddress() === txo.owner) {
        keyID = k;
        break;
      }
    }
    if (!keyID) continue;

    const sym = s.sym || s.id.slice(0, 8);
    const held = await wallet.listOutputs({
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId: s.id }),
      includeTags: true,
      includeCustomInstructions: true,
      limit: 1000,
    });
    const mine = held.outputs.find((o) => o.outpoint === `${s.spend}.0`);
    if (mine) {
      // Already filed: say so, with what the balance code reads (diagnosing tokens that don't show).
      result.held.push(sym);
      console.warn('[recover] already in wallet', sym, JSON.stringify(mine));
      continue;
    }
    try {
      const r = await fetch(`${ONESAT}/beef/${s.spend}`);
      if (!r.ok) throw new Error(`transaction ${r.status}`);
      const tx = Array.from(new Uint8Array(await r.arrayBuffer()));
      await wallet.internalizeAction({
        tx,
        description: `Recovered ${sym} tokens`,
        labels: [buildTokenLabel(s.id)],
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: BSV21_BASKET,
              tags: bsv21FilterTags({ tokenId: s.id }),
              customInstructions: buildBsv21CustomInstructions({
                token: { id: s.id, amt: s.amt, op: 'transfer', sym: s.sym, dec: s.dec ?? 0, icon: s.icon },
                protocolID: P1SAT_PROTOCOL,
                keyID,
                counterparty: 'self',
              }),
            },
          },
        ],
      });
      result.found.push({ sym, amt: s.amt });
    } catch (e) {
      // Already in the wallet shows up here too; report, don't stop.
      result.failed.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

