import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import {
  airdropPointer,
  emptyInbox,
  inWalletList,
  keep,
  keptNfts,
  toItems,
  visibleItems,
  type AirdropItem,
} from './inbox';
import { quarantinedNfts, trustIssuer } from './quarantine';
import { addressOfKey, deviceSender, pubkeyFromScriptSig, senderLabel, withSender } from './sender';
import { clipText, contentOutpoint, nftUrls, TEXT_MAX, viewKind } from './nftView';
import type { HistoryRow, RawTx } from '../wallet/txHistory';
import { toRawTx } from '../wallet/txHistoryFetch';

const key = PrivateKey.fromRandom().toPublicKey().toString();
const sig = '30' + '44' + 'ab'.repeat(68); // 70 bytes: a DER signature + sighash byte
const scriptSig = `46${sig}21${key}`;
const SRC = 'a'.repeat(64);
const TX = 'b'.repeat(64);

const nftRow = (p: Partial<HistoryRow> = {}): HistoryRow => ({
  txid: TX,
  time: 1000,
  direction: 'in',
  amountSats: 1,
  feeSats: 0,
  counterparty: '', // History has no counterparty for a transfer in (txHistory.ts classify)
  label: '',
  note: '',
  confirmations: 1,
  type: 'transfer-in',
  asset: { kind: 'nft', id: `${SRC}_0`, qty: '1' },
  ...p,
});
const tx: RawTx = {
  txid: TX,
  vin: [
    { txid: 'c'.repeat(64), vout: 1 },
    { txid: SRC, vout: 0, pubkey: key },
  ],
  vout: [
    { n: 0, sats: 1, addresses: ['1Mine'] },
    { n: 1, sats: 500, addresses: ['1Change'] },
  ],
};

describe('NFT airdrop sender', () => {
  it('reads the public key from a P2PKH unlocking script', () => {
    expect(pubkeyFromScriptSig(scriptSig)).toBe(key);
    expect(pubkeyFromScriptSig('')).toBeNull();
    expect(pubkeyFromScriptSig(`46${sig}`)).toBeNull(); // no key pushed
    expect(pubkeyFromScriptSig('76a914')).toBeNull(); // not push-only
  });

  it('keeps the key on the inputs History fetches (WhatsOnChain scriptSig)', () => {
    const raw = toRawTx({ txid: TX, vin: [{ txid: SRC, vout: 0, scriptSig: { hex: scriptSig } }], vout: [] });
    expect(raw.vin[0]).toEqual({ txid: SRC, vout: 0, pubkey: key });
  });

  it('fills in sender address, key, issuer and our outpoint from the tx', () => {
    const [item] = toItems([nftRow()], () => false);
    expect(item.from).toBe('');
    const w = withSender(item, tx, new Set(['1Mine']));
    expect(w.senderKey).toBe(key);
    expect(w.from).toBe(addressOfKey(key));
    expect(w.issuer).toBe(w.from); // Trust this sender = the sender, not the single NFT
    expect(w.outpoint).toBe(`${TX}_0`);
  });

  it('matches an account on this device by address or key', () => {
    const accounts = [{ identityAddress: 'idV', addresses: ['1Other'], pubKeys: [key] }];
    expect(deviceSender({ from: '', senderKey: key }, accounts)).toBe('idV');
    expect(deviceSender({ from: '1Other' }, accounts)).toBe('idV');
    expect(deviceSender({ from: '1Nobody' }, accounts)).toBeNull();
  });

  it('labels with the $name, else a short address', () => {
    expect(senderLabel('vexvoid@bwallet.space', { from: '1abc', issuer: 'x' })).toBe('$vexvoid');
    expect(senderLabel('$vexvoid', { from: '', issuer: 'x' })).toBe('$vexvoid');
    expect(senderLabel(null, { from: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', issuer: 'x' })).toBe('1BvBMS…JaNVN2');
  });
});

describe('NFT airdrop viewer', () => {
  it('shows only image, video, audio and text; markup never', () => {
    expect(viewKind('video/mp4')).toBe('video');
    expect(viewKind('image/png')).toBe('image');
    expect(viewKind('audio/mpeg')).toBe('audio');
    expect(viewKind('text/plain; charset=utf-8')).toBe('text');
    expect(viewKind('text/html')).toBe('other');
    expect(viewKind('image/svg+xml')).toBe('other');
    expect(viewKind(undefined)).toBe('other');
  });

  it('reads content from where the NFT sits now, else where it came from', () => {
    const item = { outpoint: `${TX}_0`, asset: { kind: 'nft' as const, id: `${SRC}_0` } };
    expect(contentOutpoint(item)).toBe(`${TX}_0`);
    expect(contentOutpoint({ asset: item.asset })).toBe(`${SRC}_0`);
    expect(nftUrls(item).content).toContain(`${TX}_0`);
    expect(nftUrls(item).thumb).toContain(`${TX}_0`);
  });

  it('clips long text', () => {
    expect(clipText('x'.repeat(TEXT_MAX + 5)).length).toBe(TEXT_MAX + 1);
  });
});

describe('Keep on an NFT airdrop', () => {
  const item = { ...withSender(toItems([nftRow()], () => false)[0], tx, new Set(['1Mine'])) } as AirdropItem;

  it('takes it out of Quarantine and into the kept NFTs the NFTs tab shows', () => {
    const s = keep(emptyInbox(), item.key);
    expect(visibleItems([item], s)).toEqual([]);
    expect(quarantinedNfts([item], s).size).toBe(0);
    expect(keptNfts([item], s)).toEqual([item]);
    expect(keptNfts([item], emptyInbox())).toEqual([]);
  });

  it('a trusted sender counts as kept too', () => {
    expect(keptNfts([item], trustIssuer(emptyInbox(), item.issuer))).toEqual([item]);
  });

  it('knows when the wallet list already holds it (by outpoint or tx)', () => {
    expect(inWalletList(item, [`${TX}.0`])).toBe(true);
    expect(inWalletList({ txid: TX }, [`${TX}_3`])).toBe(true);
    expect(inWalletList(item, [`${SRC}_0`])).toBe(false);
  });
});

describe('Inbox points at Quarantine', () => {
  it('describes what waits there', () => {
    const nft = { asset: { kind: 'nft' as const, id: 'n' } };
    const tok = { asset: { kind: 'token' as const, id: 't' } };
    expect(airdropPointer([])).toBeNull();
    expect(airdropPointer([nft])).toBe('1 NFT sent to you without asking waits in Quarantine.');
    expect(airdropPointer([nft, nft, tok])).toBe(
      '2 NFTs and 1 token airdrop sent to you without asking wait in Quarantine.',
    );
  });
});
