import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_WINDOW_BLOCKS,
  isActiveOnMarket,
  lastTrades,
  listedIds,
  withTokenEvidence,
  type MarketActivity,
} from './marketActivity';

const id = (c: string) => `${c.repeat(64)}_0`;
const TIP = 971_000;

describe('1sat.market activity filter', () => {
  it('reads listed ids and the latest trade height per token', () => {
    expect([...listedIds([{ id: id('A') }, { id: id('a') }, {}, null])]).toEqual([id('a')]);
    expect(listedIds('nope').size).toBe(0);
    const m = lastTrades([
      { id: id('b'), spendHeight: 100 },
      { id: id('b'), spendHeight: 300 },
      { id: id('c'), height: 50 },
      { id: id('d') },
    ]);
    expect(m.get(id('b'))).toBe(300);
    expect(m.get(id('c'))).toBe(50);
    expect(m.has(id('d'))).toBe(false);
  });

  it('active = a live listing or a trade within 30 days', () => {
    const a: MarketActivity = {
      listed: new Set([id('a')]),
      lastTrade: new Map([
        [id('b'), TIP - 10],
        [id('c'), TIP - ACTIVE_WINDOW_BLOCKS],
        [id('d'), TIP - ACTIVE_WINDOW_BLOCKS - 1],
      ]),
      tip: TIP,
    };
    expect(isActiveOnMarket(id('A'), a)).toBe(true);
    expect(isActiveOnMarket(id('b'), a)).toBe(true);
    expect(isActiveOnMarket(id('c'), a)).toBe(true);
    expect(isActiveOnMarket(id('d'), a)).toBe(false);
    expect(isActiveOnMarket(id('e'), a)).toBe(false);
    expect(isActiveOnMarket(id('d'), { ...a, tip: 0 })).toBe(true);
  });

  it("adds a card's own evidence without changing identity when nothing is new", () => {
    const a: MarketActivity = { listed: new Set(), lastTrade: new Map(), tip: TIP };
    expect(withTokenEvidence(a, id('e'), { listed: false, lastTradeHeight: null })).toBe(a);
    const b = withTokenEvidence(a, id('e'), { listed: true, lastTradeHeight: null });
    expect(isActiveOnMarket(id('e'), b)).toBe(true);
    const c = withTokenEvidence(a, id('f'), { listed: false, lastTradeHeight: TIP - 5 });
    expect(isActiveOnMarket(id('f'), c)).toBe(true);
    expect(withTokenEvidence(c, id('f'), { listed: false, lastTradeHeight: TIP - 9 })).toBe(c);
  });
});
