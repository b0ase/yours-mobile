import { describe, expect, it } from 'bun:test';
import { REEL_RADIUS, inReelWindow, phonePoster, releaseVideo } from './reelMemory';

describe('reel window', () => {
  it('mounts media only for the active slide and one each side', () => {
    const mounted = Array.from({ length: 50 }, (_, i) => i).filter((i) => inReelWindow(i, 20));
    expect(REEL_RADIUS).toBe(1);
    expect(mounted).toEqual([19, 20, 21]);
  });
  it('never more than three, at either end too', () => {
    for (const active of [0, 1, 25, 49])
      expect(Array.from({ length: 50 }, (_, i) => i).filter((i) => inReelWindow(i, active)).length).toBeLessThanOrEqual(
        3,
      );
    expect([0, 1, 2].filter((i) => inReelWindow(i, 0))).toEqual([0, 1]);
  });
  it('mounts nothing while the reel is hidden', () => {
    expect([19, 20, 21].some((i) => inReelWindow(i, 20, false))).toBe(false);
  });
});

describe('releaseVideo', () => {
  it('pauses, drops the source and reloads the empty element', () => {
    const calls: string[] = [];
    releaseVideo({
      pause: () => calls.push('pause'),
      removeAttribute: (n: string) => calls.push(`remove:${n}`),
      load: () => calls.push('load'),
    });
    expect(calls).toEqual(['pause', 'remove:src', 'load']);
  });
  it('ignores a missing or throwing element', () => {
    expect(() => releaseVideo(null)).not.toThrow();
    expect(() =>
      releaseVideo({
        pause: () => {
          throw new Error('detached');
        },
        removeAttribute: () => undefined,
        load: () => undefined,
      }),
    ).not.toThrow();
  });
});

describe('phonePoster', () => {
  it('asks X for the phone-sized image', () => {
    expect(phonePoster('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg')).toBe(
      'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg?name=medium',
    );
    expect(phonePoster('https://pbs.twimg.com/media/a?format=jpg&name=orig')).toBe(
      'https://pbs.twimg.com/media/a?format=jpg&name=medium',
    );
  });
  it('leaves other URLs alone', () => {
    expect(phonePoster('https://bmovies.app/art/x.jpg')).toBe('https://bmovies.app/art/x.jpg');
    expect(phonePoster('not a url')).toBe('not a url');
  });
});
