import { describe, expect, it } from 'bun:test';
import {
  RESUME_KEY,
  RESUME_MAX_AGE_MS,
  crashedSession,
  markAlive,
  markClean,
  markResumed,
  noteFeed,
  noteRoute,
} from './crashResume';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('crash resume', () => {
  it('resumes the route and sub-feed after the web view died on screen', () => {
    const s = mem();
    noteRoute(s, '/m/feed', 1000);
    noteFeed(s, 'bmovies', 1100);
    expect(crashedSession(s, 2000)).toMatchObject({ route: '/m/feed', feed: 'bmovies', alive: true });
  });
  it('does not resume after a normal background / relaunch', () => {
    const s = mem();
    noteRoute(s, '/m/feed', 1000);
    markClean(s);
    expect(crashedSession(s, 2000)).toBeNull();
    markAlive(s, 3000);
    expect(crashedSession(s, 3500)?.route).toBe('/m/feed');
  });
  it('does not resume an old session, the start screen or onboarding', () => {
    const s = mem();
    noteRoute(s, '/m/feed', 1000);
    expect(crashedSession(s, 1000 + RESUME_MAX_AGE_MS + 1)).toBeNull();
    const t = mem();
    noteRoute(t, '/', 1000);
    noteRoute(t, '/create-wallet', 1000);
    expect(t.m.has(RESUME_KEY)).toBe(false);
    t.setItem(RESUME_KEY, JSON.stringify({ route: '/restore-wallet', alive: true, at: 1000 }));
    expect(crashedSession(t, 1500)).toBeNull();
  });
  it('resumes once: a second crash on the reopened route lands normally', () => {
    const s = mem();
    noteRoute(s, '/m/feed', 1000);
    markResumed(s, 2000);
    noteRoute(s, '/m/feed', 2001);
    expect(crashedSession(s, 2500)).toBeNull();
    noteRoute(s, '/m/chat', 3000);
    expect(crashedSession(s, 3500)?.route).toBe('/m/chat');
  });
  it('treats unreadable storage as nothing to resume', () => {
    const s = mem();
    s.setItem(RESUME_KEY, '{oops');
    expect(crashedSession(s, 1)).toBeNull();
    noteFeed(s, 'bmovies', 2);
    expect(crashedSession(s, 3)).toBeNull();
  });
});
