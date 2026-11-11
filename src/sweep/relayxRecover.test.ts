import { describe, expect, test } from 'bun:test';
import { Mnemonic } from '@bsv/sdk';
import type { ChainReader } from './chainReads';
import {
  cleanWords,
  createJigMemo,
  groupFound,
  keyAt,
  relayxAccount,
  relayxXpub,
  wifAt,
  scanRelayx,
  wordsProblem,
  type Found,
} from './relayxRecover';
import type { NpgMap } from './runIdentify';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { LISTING_HEX, MINT_TXID } from './relayxListing.fixtures';

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
    // The address taken from the HD node's public key is the private key's own address.
    expect(PrivateKey.fromWif(nft.wif).toAddress()).toBe(nft.address);
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
      scriptUnspent: async () => [],
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

    // From the saved xpub (a restored RelayX account): the same NFTs and addresses, and no private keys.
    const x = await scanRelayx({ xpub: relayxXpub(WORDS) }, reader, maps, () => {});
    expect(x.nfts.map((n) => [n.title, n.address, n.wif])).toEqual([['NPG #2730', nft.address, '']]);
    expect(x.addresses).toBe(2);
    expect(relayxXpub(WORDS).startsWith('xpub')).toBe(true);
    // The account's words give back each NFT's key from its path, for melting from a restored account.
    expect(x.nfts[0].path).toBe("m/44'/236'/0'/2/0");
    expect(wifAt(WORDS, x.nfts[0].path!)).toBe(nft.wif);
    expect(() => wifAt(WORDS, "m/44'/0'/0'/0/0")).toThrow();
  });

  test('remembers what each output is, so a second search downloads nothing', async () => {
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const jig = { location: `${'e'.repeat(64)}_o1`, origin: 'o', title: 'NPG #0001', collection: 'S1', n: 1 };
    const m1 = createJigMemo(ls);
    m1.set(jig.location, jig);
    m1.set('x_o0', null);
    await new Promise((r) => setTimeout(r, 1100));
    const m2 = createJigMemo(ls);
    expect(m2.get(jig.location)).toEqual(jig);
    expect(m2.get('x_o0')).toBeNull();
    expect(m2.get('y_o0')).toBeUndefined();
  });

  test('finds an NFT still listed on RelayX from its cancel output, apart from the held ones', async () => {
    const acct = relayxAccount(WORDS);
    const pay = keyAt(acct, 0, 0);
    // The real listing of NPG S2 #2506, with its cancel output paid to this test account.
    const listing = Transaction.fromHex(LISTING_HEX);
    listing.outputs[0].lockingScript = new P2PKH().lock(pay.address);
    const txid = listing.id('hex');
    const maps: NpgMap[] = [
      {
        class: '393b1c2a',
        collection: 'Ninja Punk Girls Vs The Evil Erobotz Series 2',
        jigs: { [`${MINT_TXID}_o3`]: { i: 0, n: 2506 } },
      },
    ];
    let open = true;
    const reader: ChainReader = {
      holding: async (as) => new Map(as.map((a) => [a, a === pay.address ? 1 : 0])),
      unspent: async (a) => (a === pay.address ? [{ txid, vout: 0, sats: 546, address: a }] : []),
      scriptUnspent: async (hex) =>
        open && hex === listing.outputs[2].lockingScript.toHex() ? [{ txid, vout: 2, sats: 1415, address: '' }] : [],
      txHex: async () => listing.toHex(),
      getTx: async (t) => {
        if (t === txid) return listing;
        throw new Error(`unexpected fetch ${t}`);
      },
    };
    const r = await scanRelayx(WORDS, reader, maps, () => {});
    expect(r.nfts.map((n) => [n.title, n.location, n.address, n.wif === pay.wif, n.listed?.price])).toEqual([
      ['NPG #2506', `${txid}_o2`, pay.address, true, 10_000_000],
    ]);
    expect(r.otherSats).toBe(0); // the baton is never counted as spare BSV
    expect(groupFound(r.nfts).map((g) => g.title)).toEqual(['Listed for sale on RelayX']);

    // Bought or cancelled since: the order is spent, so it isn't shown as listed.
    open = false;
    const gone = await scanRelayx(WORDS, reader, maps, () => {});
    expect(gone.nfts).toEqual([]);
  });
});
