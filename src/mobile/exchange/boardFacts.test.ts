import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { KNOWN_BURN_ADDRESSES } from '../../utils/constants';
import { returnsWords } from '../tokens/returnsWording';
import {
  SCORE_RULES,
  ageLabel,
  boardOrder,
  marketCap,
  MONTH_BLOCKS,
  showChange,
  capLabel,
  badges,
  deployFacts,
  deployerOf,
  derive,
  fairScore,
  parseTokenRow,
  shortAmount,
  type BoardFacts,
} from './boardFacts';

const BURN = KNOWN_BURN_ADDRESSES[0];
const addr = (n: number) => new PrivateKey(n + 1).toAddress();
const DEV = addr(0);

const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  supply: 1000n,
  dec: 0,
  height: 100,
  holders: 50,
  top: [],
  deployer: DEV,
  curve: false,
  ...over,
});

/** Ten equal holders of 10 each from 1000 supply → top 10 = 100%. */
const holders = (amts: number[]) => amts.map((a, i) => ({ address: addr(i + 1), amt: BigInt(a) }));

describe('parseTokenRow', () => {
  test('reads supply, decimals, height and holder count', () => {
    expect(parseTokenRow({ amt: '1000000000', dec: 0, height: 972588, accounts: 12 })).toEqual({
      supply: 1000000000n,
      dec: 0,
      height: 972588,
      holders: 12,
    });
  });
  test('malformed rows are dropped, odd fields fall back', () => {
    expect(parseTokenRow(null)).toBeNull();
    expect(parseTokenRow({ amt: '-5' })).toBeNull();
    expect(parseTokenRow({ amt: '10', dec: 99, height: -1, accounts: 'x' })).toEqual({
      supply: 10n,
      dec: 0,
      height: 0,
      holders: null,
    });
  });
});

describe('deploy tx', () => {
  const inscription = (addrTo: string) => {
    const env = new LockingScript([
      { op: 0 },
      { op: 0x63 },
      { op: 3, data: Utils.toArray('ord') },
      { op: 0x51 },
      { op: 18, data: Utils.toArray('application/bsv-20') },
      { op: 0 },
      { op: 10, data: Utils.toArray('{"p":"x"}') },
      { op: 0x68 },
    ]);
    return LockingScript.fromBinary([...env.toBinary(), ...new P2PKH().lock(addrTo).toBinary()]);
  };
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(addr(9)), satoshis: 1 });
  tx.addOutput({ lockingScript: inscription(DEV), satoshis: 1 });

  test('deployer = the P2PKH after the inscription envelope', () => {
    expect(deployerOf(tx, 1)).toBe(DEV);
    expect(deployerOf(tx, 5)).toBeNull();
  });
  test('a non-P2PKH deploy output has no deployer', () => {
    const t = new Transaction();
    t.addOutput({ lockingScript: new LockingScript([{ op: 0x51 }]), satoshis: 1 });
    expect(deployerOf(t, 0)).toBeNull();
  });
  test('deployFacts checks the bytes hash to the token id', () => {
    const raw = tx.toBinary();
    expect(deployFacts(raw, `${tx.id('hex')}_1`)).toEqual({ deployer: DEV, curve: false });
    expect(deployFacts(raw, `${'0'.repeat(64)}_1`)).toBeNull();
    expect(deployFacts([1, 2, 3], `${tx.id('hex')}_1`)).toBeNull();
  });
});

describe('derive', () => {
  test('burn addresses count as burned and are left out of the top 10', () => {
    const d = derive(facts({ top: [{ address: BURN, amt: 500n }, ...holders([100, 50])] }));
    expect(d.burned).toBe(500n);
    expect(d.burnedPct).toBe(0.5);
    expect(d.circulating).toBe(500n);
    expect(d.top10Pct).toBeCloseTo(0.3);
  });
  test('deployer share: exact when listed, 0 when the full list lacks them, bounded by the 20th holder otherwise', () => {
    expect(derive(facts({ top: [{ address: DEV, amt: 100n }, ...holders([10])] })).devPct).toBeCloseTo(0.1);
    expect(derive(facts({ top: holders([10, 10]) })).devPct).toBe(0);
    const twenty = holders(Array.from({ length: 20 }, (_, i) => 40 - i));
    expect(derive(facts({ top: twenty })).devPct).toBeCloseTo(21 / 1000);
  });
  test('unknown deployer or holders stays unknown', () => {
    expect(derive(facts({ deployer: null, top: holders([10]) })).devPct).toBeNull();
    expect(derive(facts({ top: [] })).top10Pct).toBeNull();
  });
});

describe('fairScore', () => {
  test('a perfectly spread, curve-committed, 10%-burned token with 1000 holders scores 100', () => {
    const top = [{ address: BURN, amt: 100n }, ...holders(Array.from({ length: 12 }, () => 1))];
    const s = fairScore(facts({ curve: true, holders: 1000, top }));
    expect(s.total).toBe(100);
    expect(s.parts.map((p) => p.points)).toEqual([30, 25, 20, 15, 10]);
  });
  test('one wallet holding everything, the deployer, scores only the holders part', () => {
    const s = fairScore(facts({ holders: 10, top: [{ address: DEV, amt: 1000n }] }));
    expect(s.parts.find((p) => p.id === 'spread')!.points).toBe(0);
    expect(s.parts.find((p) => p.id === 'dev')!.points).toBe(0);
    expect(s.parts.find((p) => p.id === 'holders')!.points).toBeCloseTo(6.7);
    expect(s.total).toBe(7);
  });
  test('unknown inputs score 0, never a guess', () => {
    const s = fairScore(facts({ deployer: null, holders: null, top: [] }));
    expect(s.total).toBe(0);
  });
  test('parts match the published rules and add to 100', () => {
    const s = fairScore(facts());
    expect(s.parts.map((p) => [p.id, p.max])).toEqual(SCORE_RULES.map((r) => [r.id, r.max]));
    expect(SCORE_RULES.reduce((n, r) => n + r.max, 0)).toBe(100);
  });
});

describe('badges', () => {
  test('only proven facts become badges', () => {
    expect(badges(facts({ top: [{ address: DEV, amt: 900n }, ...holders([100])] }))).toEqual([]);
    const ids = badges(
      facts({
        curve: true,
        top: [{ address: BURN, amt: 316n }, ...holders(Array.from({ length: 19 }, () => 5))],
      }),
    ).map((b) => b.id);
    expect(ids).toEqual(['curve', 'burned', 'devlow', 'spread']);
  });
  test('deployer badges', () => {
    expect(badges(facts({ top: holders([10]) })).map((b) => b.id)).toContain('dev0');
    expect(badges(facts({ top: [{ address: DEV, amt: 30n }, ...holders([10])] })).map((b) => b.id)).toContain('devlow');
  });
  test('no investment wording in any badge, rule or note', () => {
    const top = [{ address: BURN, amt: 100n }, { address: DEV, amt: 1n }, ...holders([5, 5])];
    const f = facts({ curve: true, top });
    const text = [
      ...badges(f).flatMap((b) => [b.label, b.detail]),
      ...SCORE_RULES.flatMap((r) => [r.label, r.rule]),
      ...fairScore(f).parts.map((p) => p.note),
    ].join(' ');
    expect(returnsWords(text)).toEqual([]);
    expect(text).not.toMatch(/\bmoon\b|\bearn\b/i);
  });
});

describe('labels', () => {
  test('shortAmount', () => {
    expect(shortAmount(316_000_000n, 0)).toBe('316M');
    expect(shortAmount(1_250_000_000n, 0)).toBe('1.3B');
    expect(shortAmount(12345n, 2)).toBe('123.45');
  });
  test('capLabel', () => {
    expect(capLabel(1e8, 54_180)).toBe('$54.2K');
    expect(capLabel(147_000_000e8, 17.2)).toBe('$2.5B');
    expect(capLabel(3250e8, 0)).toBe('3.3K BSV');
    expect(capLabel(5e7, 0)).toBe('0.50 BSV');
  });
  test('ageLabel', () => {
    expect(ageLabel(3)).toBe('30m');
    expect(ageLabel(12)).toBe('2h');
    expect(ageLabel(432)).toBe('3d');
  });
});

describe('market cap', () => {
  const t = (height: number, satsPerToken = 10, totalSats = 2_000_000) => ({ height, satsPerToken, totalSats });
  test('3+ trades in 30 days and a fresh last trade: a market cap', () => {
    expect(marketCap([t(900), t(950), t(990, 20)], 1000, 1000n, 0)).toEqual({ kind: 'cap', sats: 20000 });
  });
  test('one stale trade is a thin market with its age, never a cap', () => {
    expect(marketCap([t(100, 5)], 100 + 4 * MONTH_BLOCKS, 1000n, 0)).toEqual({
      kind: 'thin',
      lastSatsPerToken: 5,
      ageBlocks: 4 * MONTH_BLOCKS,
    });
  });
  test('only 2 recent trades, or a last trade 30+ days old: thin', () => {
    expect(marketCap([t(900), t(990)], 1000, 1000n, 0).kind).toBe('thin');
    const tip = 10_000 + MONTH_BLOCKS;
    expect(marketCap([t(9_990), t(9_995), t(10_000)], tip, 1000n, 0).kind).toBe('thin');
  });
  test('under 0.05 BSV traded in 30 days: thin', () => {
    const tiny = [t(900, 10, 1000), t(950, 10, 1000), t(990, 20, 1000)];
    expect(marketCap(tiny, 1000, 1000n, 0).kind).toBe('thin');
  });
  test('a market cap above 1,000,000 BSV is never shown', () => {
    // 1 BSV/token × 1.1M tokens = 1.1M BSV
    expect(marketCap([t(900, 1e8), t(950, 1e8), t(990, 1e8)], 1000, 1_100_000n, 0).kind).toBe('thin');
    expect(marketCap([t(900, 1e8), t(950, 1e8), t(990, 1e8)], 1000, 1_000_000n, 0).kind).toBe('cap');
  });
  test('no tip: thin; no trades: none', () => {
    expect(marketCap([t(1), t(2), t(3)], 0, 1000n, 0)).toEqual({ kind: 'thin', lastSatsPerToken: 10, ageBlocks: null });
    expect(marketCap([], 1000, 1000n, 0).kind).toBe('none');
  });
});

describe('24h change and order', () => {
  test('the % shows only with 2+ trades in 24h', () => {
    expect(showChange(0, 1)).toBe(false);
    expect(showChange(null, 5)).toBe(false);
    expect(showChange(0.1, 2)).toBe(true);
  });
  test('board order: 24h volume, then holders', () => {
    const rows = [
      { id: 'a', volume: 0, holders: 900 },
      { id: 'b', volume: 500, holders: 3 },
      { id: 'c', volume: 0, holders: null },
      { id: 'd', volume: 0, holders: 1200 },
    ];
    expect([...rows].sort(boardOrder).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
