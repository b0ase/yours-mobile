import { describe, expect, it } from 'vitest';
import { P2PKH } from '@bsv/sdk';
import { bsvDropItems, emptyInbox, hideItem, type AirdropItem } from './inbox';
import { bsvDropOutput, dropMarker, dropMarkerScript, noteScript } from './note';
import type { RawTx } from '../wallet/txHistory';

const ORD = '1J4TnSj94pNUNc2qCvjRLcb8xTcz6fit43'; // our ordinals (legacy) address
const DEP = '1LRSaaEYTqK5RNCMD3LCEeVnBW2NWa9vie'; // our receive (deposit) address
const ISSUER = '1KgPN7U5LbaigFUZbYm3AxQYavRBq4MY67';
const TOKEN = '429bf19906897c0444a53bdf236473b1b3965a95a03f20863de640f49241d929_0';
const p2pkh = (a: string) => new P2PKH().lock(a).toHex();

const tx = (txid: string, outs: RawTx['vout'], vin: RawTx['vin'] = [{ txid: 'f'.repeat(64), vout: 0 }]): RawTx => ({
  txid,
  vin,
  vout: outs,
});
const row = (txid: string) => ({ txid, time: 1000, direction: 'in' as const, counterparty: ISSUER });
const opts = (over: Partial<Parameters<typeof bsvDropItems>[2]> = {}) => ({
  own: new Set([ORD, DEP]),
  legacy: new Set([ORD]),
  funded: () => false,
  hasLocal: () => false,
  ...over,
});

describe('BSV airdrop marker', () => {
  it('reads the bare marker and the note, with the holders token', () => {
    expect(dropMarker([{ script: dropMarkerScript(TOKEN).toHex() }])).toEqual({ tokenId: TOKEN });
    expect(dropMarker([{ script: dropMarkerScript().toHex() }])).toEqual({});
    expect(dropMarker([{ script: noteScript('Thanks for holding', TOKEN).toHex() }])).toEqual({ tokenId: TOKEN });
    expect(bsvDropOutput(undefined, TOKEN).lockingScript).toBe(dropMarkerScript(TOKEN).toHex());
    expect(bsvDropOutput('hi', TOKEN).outputDescription).toBe('Airdrop note');
  });

  it('finds no marker in a plain payment or a foreign OP_RETURN', () => {
    expect(dropMarker([{ script: p2pkh(ORD) }])).toBeNull();
    expect(dropMarker([{ script: '006a0568656c6c6f' }])).toBeNull();
    expect(dropMarker(undefined)).toBeNull();
  });
});

describe('BSV airdrops in the inbox', () => {
  const marked = tx('a'.repeat(64), [
    { n: 0, sats: 5000, addresses: [ORD], script: p2pkh(ORD) },
    { n: 1, sats: 0, addresses: [], script: dropMarkerScript(TOKEN).toHex() },
  ]);
  const plain = tx('b'.repeat(64), [{ n: 0, sats: 7000, addresses: [DEP], script: p2pkh(DEP) }]);
  const toDeposit = tx('c'.repeat(64), [
    { n: 0, sats: 2500, addresses: [DEP], script: p2pkh(DEP) },
    { n: 1, sats: 0, addresses: [], script: bsvDropOutput('gm holders', TOKEN).lockingScript },
  ]);
  const txs = new Map([marked, plain, toDeposit].map((t) => [t.txid, t]));
  const rows = [row(marked.txid), row(plain.txid), row(toDeposit.txid)];

  it('shows an airdrop-marked BSV payment and never a plain one', () => {
    const items = bsvDropItems(rows, txs, opts());
    expect(items.map((i) => i.txid)).toEqual([marked.txid, toDeposit.txid]);
    expect(items[0]).toMatchObject({
      key: `${marked.txid}:bsv`,
      asset: { kind: 'bsv', id: 'bsv', qty: '5000' },
      issuer: TOKEN,
      holdersOf: TOKEN,
      from: ISSUER,
      needsMove: true,
    });
    // Paid to the receive address: already in the balance.
    expect(items[1]).toMatchObject({ asset: { qty: '2500' }, needsMove: false });
  });

  it('skips our own sends, payments with an action record, and token rows', () => {
    expect(bsvDropItems(rows, txs, opts({ funded: () => true }))).toEqual([]);
    expect(bsvDropItems(rows, txs, opts({ hasLocal: () => true }))).toEqual([]);
    const tokenRow = { ...row(marked.txid), asset: { kind: 'token' as const, id: TOKEN } };
    expect(bsvDropItems([tokenRow], txs, opts())).toEqual([]);
    expect(bsvDropItems([{ ...row(marked.txid), direction: 'out' as const }], txs, opts())).toEqual([]);
  });

  it('Hide on a BSV airdrop hides only that card, not the issuer', () => {
    const [item] = bsvDropItems(rows, txs, opts()) as AirdropItem[];
    const s = hideItem(emptyInbox(), item);
    expect(s.hidden).toEqual([item.key]);
    expect(s.hiddenIssuers).toEqual([]);
  });
});
