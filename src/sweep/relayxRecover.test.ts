import { describe, expect, test } from 'bun:test';
import { Mnemonic } from '@bsv/sdk';
import type { ChainReader } from './chainReads';
import { cleanWords, groupFound, keyAt, relayxAccount, scanRelayx, wordsProblem, type Found } from './relayxRecover';
import type { NpgMap } from './runIdentify';

const WORDS = Mnemonic.fromRandom().toString();

describe('words', () => {
  test('accepts numbered lists, commas and new lines', () => {
    const list = WORDS.split(' ')
      .map((w, i) => `${i + 1}. ${w},`)
      .join('\n');
    expect(cleanWords(list)).toBe(WORDS);
    expect(wordsProblem(list)).toBeNull();
    expect(wordsProblem('apple banana')).toContain('2 words');
    // abandon ×12 always fails the BIP39 checksum (a random wrong word passes ~1 in 16).
    expect(wordsProblem(Array(12).fill('abandon').join(' '))).toContain("don't check out");
  });
});

const found = (p: Partial<Found>): Found => ({
  location: `${'a'.repeat(64)}_o3`,
  origin: `${'a'.repeat(64)}_o3`,
  title: 'x',
  collection: '',
  address: '1A',
  wif: 'w',
  ...p,
});

describe('gallery groups', () => {
  test('Series 2 by number, Series 1, single girls, other, unread', () => {
    const g = groupFound([
      found({ n: 2730, title: 'NPG #2730', collection: 'Ninja Punk Girls Vs The Evil Erobotz Series 2' }),
      found({ n: 12, title: 'NPG #0012', collection: 'Ninja Punk Girls Vs The Evil Erobotz Series 2' }),
      found({ n: 1, title: 'Nao (NPG #0001)', collection: 'Ninja Punk Girls Vs The Evil Erobotz' }),
      found({ title: 'KAZUYO', collection: 'KAZUYO' }),
      found({ title: 'Some Art', collection: 'RelayX NFT' }),
      found({ title: "Couldn't read this one", unread: true }),
    ]);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([
      ['s2', 2],
      ['s1', 1],
      ['npg', 1],
      ['other', 1],
      ['unread', 1],
    ]);
    expect(g[0].items.map((i) => i.n)).toEqual([12, 2730]);
  });
});

describe('scan', () => {
  test('finds a held NPG jig at /2/0 without downloading its mint, and counts other BSV', async () => {
    const acct = relayxAccount(WORDS);
    const nft = keyAt(acct, 2, 0);
    const pay = keyAt(acct, 0, 0);
    const mint = 'c'.repeat(64);
    const maps: NpgMap[] = [
      {
        class: '393b1c2a',
        collection: 'Ninja Punk Girls Vs The Evil Erobotz Series 2',
        jigs: { [`${mint}_o3`]: { i: 0, n: 2730 } },
      },
    ];
    const reader: ChainReader = {
      holding: async (as) => new Map(as.map((a) => [a, a === nft.address || a === pay.address ? 1 : 0])),
      unspent: async (a) =>
        a === nft.address
          ? [{ txid: mint, vout: 3, sats: 273, address: a }]
          : [{ txid: 'd'.repeat(64), vout: 0, sats: 50_000, address: a }],
      txHex: async () => {
        throw new Error('no download expected');
      },
      getTx: async () => {
        throw new Error('no download expected');
      },
    };
    const r = await scanRelayx(WORDS, reader, maps, () => {});
    expect(r.nfts.map((n) => [n.title, n.n, n.address, n.wif === nft.wif])).toEqual([
      ['NPG #2730', 2730, nft.address, true],
    ]);
    expect(r.otherSats).toBe(50_000);
    expect(r.addresses).toBe(2);
  });
});
