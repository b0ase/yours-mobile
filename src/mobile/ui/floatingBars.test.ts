import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FLOAT_RESERVE_VAR, currentReserve, reserveFor, setReserve } from './floatingBars';

const fakeRoot = () => {
  const vars = new Map<string, string>();
  return {
    vars,
    style: {
      setProperty: (k: string, v: string) => void vars.set(k, v),
      removeProperty: (k: string) => void vars.delete(k),
    },
  };
};

describe('floating bar reserve', () => {
  test('covers from the bar top to the window bottom, plus a gap', () => {
    // Ask b bar: 44px tall, 64px up from the bottom of a 900px window → top at 792.
    expect(reserveFor(792, 900)).toBe(120);
    expect(reserveFor(900, 900)).toBe(0); // off screen
  });
  test('the layout gets the largest reserve, and none once every bar is gone', () => {
    const root = fakeRoot();
    const a = Symbol('a');
    const b = Symbol('b');
    setReserve(a, 120, root as never);
    setReserve(b, 80, root as never);
    expect(root.vars.get(FLOAT_RESERVE_VAR)).toBe('120px');
    setReserve(a, null, root as never);
    expect(root.vars.get(FLOAT_RESERVE_VAR)).toBe('80px');
    setReserve(b, null, root as never);
    expect(root.vars.has(FLOAT_RESERVE_VAR)).toBe(false);
    expect(currentReserve()).toBe(0);
  });
  test('the Ask b float publishes its bar, and every Desktop page pads its content by it', () => {
    const conv = readFileSync(new URL('../agent/AgentConversation.tsx', import.meta.url), 'utf8');
    expect(conv).toContain('useFloatingBarReserve(floatBar);');
    expect(conv).toContain("<div ref={floatBar}>{bar('float')}</div>");
    const css = readFileSync(new URL('../wide/wide.css', import.meta.url), 'utf8');
    // Every rule that sets the content's padding (base, compact, framed pages, full-bleed pages).
    const blocks = (css.match(/\.ww-content \{[^}]*\}/g) ?? []).filter((b) => /padding:/.test(b));
    expect(blocks.length).toBe(4);
    for (const b of blocks) expect(b).toContain('var(--float-bar-reserve, 0px)');
  });
});
