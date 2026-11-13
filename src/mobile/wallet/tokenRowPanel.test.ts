import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowPanelActions } from './TokenRowPanel';

const noop = () => undefined;

describe('wallet token row: tap to expand (owner, 13 Nov 2026)', () => {
  it('offers the swipe actions in panel order, leaving out what the row cannot do', () => {
    const all = rowPanelActions({
      onBuy: noop,
      onSell: noop,
      onSend: noop,
      onReceive: noop,
      onChat: noop,
      onLock: noop,
    });
    expect(all.map((a) => a.id)).toEqual(['buy', 'sell', 'send', 'receive', 'chat', 'lock']);
    // A store build (no trading): no Buy or Sell.
    expect(rowPanelActions({ onSend: noop, onReceive: noop }).map((a) => a.id)).toEqual(['send', 'receive']);
  });

  it('runs the action it was given', () => {
    let sold = 0;
    rowPanelActions({ onSell: () => sold++ })[0].onPress();
    expect(sold).toBe(1);
  });

  it('the wallet list toggles the panel on tap and keeps the swipe trays', () => {
    const src = readFileSync(join(import.meta.dir, '../../components/Bsv21TokensList.tsx'), 'utf8');
    expect(src).toContain('onClick={() => toggleRow(t)}');
    expect(src).toContain('aria-expanded={open}');
    expect(src).toContain('<TokenRowPanel');
    expect(src).toContain('<TokenSwipe');
  });
});
