import { describe, expect, test } from 'bun:test';
import { startInboxPoll, type InboxPollEnv } from './inboxPoll';

const env = (visible = { v: true }) => {
  const ticks: (() => void)[] = [];
  const vis: (() => void)[] = [];
  const e: InboxPollEnv = {
    setInterval: (cb) => ticks.push(cb),
    clearInterval: () => ticks.splice(0),
    isVisible: () => visible.v,
    onVisible: (cb) => {
      vis.push(cb);
      return () => vis.splice(0);
    },
  };
  return { e, ticks, vis, visible };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startInboxPoll', () => {
  test('collects at once and on each tick; refreshes only when something arrived', async () => {
    const { e, ticks } = env();
    let n = 0;
    let refreshed = 0;
    startInboxPoll(
      async () => ({ collected: n++ === 1 ? 1 : 0 }),
      () => refreshed++,
      e,
    );
    await flush();
    expect(n).toBe(1);
    expect(refreshed).toBe(0);
    ticks[0]();
    await flush();
    expect(n).toBe(2);
    expect(refreshed).toBe(1);
  });

  test('skips while hidden, collects when visible again', async () => {
    const h = env({ v: false });
    let n = 0;
    startInboxPoll(
      async () => ({ collected: n++ }),
      () => {},
      h.e,
    );
    await flush();
    h.ticks[0]();
    await flush();
    expect(n).toBe(0);
    h.visible.v = true;
    h.vis[0]();
    await flush();
    expect(n).toBe(1);
  });

  test('never overlaps, survives errors, stops cleanly', async () => {
    const { e, ticks } = env();
    let n = 0;
    let release: () => void = () => {};
    const stop = startInboxPoll(
      () => {
        n++;
        return new Promise((_, rej) => (release = () => rej(new Error('down'))));
      },
      () => {},
      e,
    );
    ticks[0]();
    expect(n).toBe(1);
    release();
    await flush();
    ticks[0]();
    expect(n).toBe(2);
    stop();
    expect(ticks.length).toBe(0);
  });
});
