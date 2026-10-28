import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { SheetFirstGate } from './sheetFirst';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const clock = () => {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
};

const gateWith = (c: ReturnType<typeof clock>) =>
  new SheetFirstGate({
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    recentMs: 2000,
    quietMs: 1000,
    capMs: 3000,
  });

const settled = async (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe('SheetFirstGate', () => {
  test('no site waiting: opens at once (popup open, alarm wake)', async () => {
    const c = clock();
    expect(await settled(gateWith(c).wait())).toBe(true);
    expect(c.pending()).toBe(0);
  });

  test('an old site request does not hold the work', async () => {
    const c = clock();
    const g = gateWith(c);
    g.noteSiteRequest();
    c.advance(2500);
    expect(await settled(g.wait())).toBe(true);
  });

  test('a site waiting: holds until its sheet shows', async () => {
    const c = clock();
    const g = gateWith(c);
    g.noteSiteRequest();
    c.advance(600);
    const p = g.wait();
    c.advance(200);
    g.noteSiteRequest();
    c.advance(200);
    expect(await settled(p)).toBe(false);
    g.notePromptShown();
    expect(await settled(p)).toBe(true);
    expect(c.pending()).toBe(0);
  });

  test('calls that need no sheet: opens once the site is quiet', async () => {
    const c = clock();
    const g = gateWith(c);
    g.noteSiteRequest();
    const p = g.wait();
    c.advance(999);
    expect(await settled(p)).toBe(false);
    c.advance(1);
    expect(await settled(p)).toBe(true);
  });

  test('quiet counts from the wallet being ready, not from the call that woke the worker', async () => {
    const c = clock();
    const g = gateWith(c);
    g.noteSiteRequest();
    c.advance(1500); // the wallet took 1.5 s to open
    const p = g.wait();
    c.advance(500);
    expect(await settled(p)).toBe(false);
    c.advance(500);
    expect(await settled(p)).toBe(true);
  });

  test('a busy site never holds the work past the cap', async () => {
    const c = clock();
    const g = gateWith(c);
    g.noteSiteRequest();
    const p = g.wait();
    for (let i = 0; i < 7; i++) {
      c.advance(500);
      g.noteSiteRequest();
    }
    expect(await settled(p)).toBe(true);
    expect(c.pending()).toBe(0);
  });

  test('the unlock screen counts as on screen', () => {
    const bg = src('../background.ts');
    expect(bg).toMatch(/showUnlockUi = \(\) => \{\s*sheetFirst\.notePromptShown\(\);/);
    expect(bg).toMatch(/showPromptUi = \(kind, requestID\) => \{[\s\S]{0,120}sheetFirst\.notePromptShown\(\);/);
  });

  test('the syncs and the storage switch wait for the gate', () => {
    const bg = src('../background.ts');
    expect(bg).toContain('startSyncsAfter: heavyWorkMayStart');
    expect(bg).toMatch(/const localReady = heavyWorkMayStart\(\)\.then\(/);
    const iw = src('../initWallet.ts');
    expect(iw).toMatch(/syncsMayStart\.then\(\s*\(\) => resyncAddresses\(\)/);
    expect(iw).toMatch(/syncsMayStart\s*\.then\(\(\) => syncMessages\.execute/);
  });
});
