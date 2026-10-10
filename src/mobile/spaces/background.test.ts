import { describe, expect, test } from 'bun:test';
import { SpaceBackground, isPortrait, noticeText, pipFocus, type SpaceSessionPlugin } from './background';
import type { Participant } from './model';

const p = (handle: string, role: Participant['role'] = 'speaker') => ({ handle, role }) as Participant;

describe('noticeText', () => {
  test('listener: listening, Leave only', () => {
    expect(noticeText({ title: 'Morning', onStage: false, micOn: false })).toEqual({
      title: 'Listening to Morning',
      text: 'Live Space',
      actions: ['Leave'],
    });
  });
  test('speaker: speaking, Mute/Unmute + Leave', () => {
    expect(noticeText({ title: 'Morning', onStage: true, micOn: true }).actions).toEqual(['Mute', 'Leave']);
    const off = noticeText({ title: '', onStage: true, micOn: false });
    expect(off.title).toBe('Speaking in a Space');
    expect(off.actions).toEqual(['Unmute', 'Leave']);
  });
});

describe('pipFocus', () => {
  const stage = [p('host', 'host'), p('a'), p('b'), p('me')];
  test('speaking with camera wins', () => {
    expect(pipFocus({ stage, videos: ['host', 'b'], speaking: ['b'], me: 'me' })).toBe('b');
  });
  test('else the host on camera', () => {
    expect(pipFocus({ stage, videos: ['a', 'host'], speaking: ['b'], me: 'me' })).toBe('host');
  });
  test('else any other camera', () => {
    expect(pipFocus({ stage, videos: ['a'], speaking: [], me: 'me' })).toBe('a');
  });
  test('never my own camera; null with no video', () => {
    expect(pipFocus({ stage, videos: ['me'], speaking: ['me'], me: 'me' })).toBeNull();
    expect(pipFocus({ stage, videos: [], speaking: ['a'], me: 'me' })).toBeNull();
  });
});

test('isPortrait', () => {
  expect(isPortrait(720, 1280)).toBe(true);
  expect(isPortrait(1280, 720)).toBe(false);
  expect(isPortrait(0, 0)).toBe(false);
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const fakePlugin = (granted = true) => {
  const calls: [string, unknown][] = [];
  const handlers: Record<string, (e: never) => void> = {};
  const plugin = {
    start: async (o: unknown) => void calls.push(['start', o]),
    stop: async () => void calls.push(['stop', null]),
    setPip: async (o: unknown) => void calls.push(['setPip', o]),
    requestNotifications: async () => {
      calls.push(['notify', null]);
      return { granted };
    },
    addListener: async (ev: string, fn: (e: never) => void) => {
      handlers[ev] = fn;
      return { remove: async () => void delete handlers[ev] };
    },
  } as unknown as SpaceSessionPlugin;
  return { plugin, calls, handlers };
};

describe('SpaceBackground (android)', () => {
  const live = { live: true, title: 'T', onStage: false, micOn: false, focus: null };
  test('starts once when live, refreshes on role/mic change, stops on leave', async () => {
    const f = fakePlugin();
    const bg = new SpaceBackground({ onMute: () => {}, onLeave: () => {}, onPip: () => {} }, f.plugin, 'android');
    bg.update({ ...live, live: false });
    expect(f.calls.filter((c) => c[0] === 'start')).toHaveLength(0);
    bg.update(live);
    bg.update(live);
    await flush();
    expect(f.calls.filter((c) => c[0] === 'start')).toHaveLength(1);
    bg.update({ ...live, onStage: true, micOn: true });
    await flush();
    expect(f.calls.filter((c) => c[0] === 'start')).toHaveLength(2);
    expect(f.calls.filter((c) => c[0] === 'notify')).toHaveLength(1);
    bg.close();
    expect(f.calls.at(-1)?.[0]).toBe('stop');
  });
  test('notification actions reach mute/leave; pip events reach onPip', async () => {
    const f = fakePlugin();
    const got: string[] = [];
    new SpaceBackground(
      { onMute: () => got.push('mute'), onLeave: () => got.push('leave'), onPip: (a) => got.push(`pip:${a}`) },
      f.plugin,
      'android',
    );
    await Promise.resolve();
    (f.handlers.action as (e: { action: string }) => void)({ action: 'mute' });
    (f.handlers.action as (e: { action: string }) => void)({ action: 'leave' });
    (f.handlers.pip as (e: { active: boolean }) => void)({ active: true });
    expect(got).toEqual(['mute', 'leave', 'pip:true']);
  });
  test('a listener: notification permission asked first, service starts even if denied', async () => {
    const f = fakePlugin(false);
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a[0]);
    try {
      const bg = new SpaceBackground({ onMute: () => {}, onLeave: () => {}, onPip: () => {} }, f.plugin, 'android');
      bg.update(live);
      await flush();
      expect(f.calls.map((c) => c[0]).filter((c) => c !== 'setPip').slice(0, 2)).toEqual(['notify', 'start']);
      expect((f.calls.find((c) => c[0] === 'start')?.[1] as { onStage: boolean }).onStage).toBe(false);
      expect(String(warned[0])).toContain('notification permission denied');
      bg.close();
    } finally {
      console.warn = warn;
    }
  });
  test('web: never touches the native plugin', () => {
    const f = fakePlugin();
    const bg = new SpaceBackground({ onMute: () => {}, onLeave: () => {}, onPip: () => {} }, f.plugin, 'web');
    bg.update(live);
    bg.close();
    expect(f.calls).toHaveLength(0);
  });
});
