import { describe, expect, test } from 'bun:test';
import {
  B_HOLD_MS,
  bHold,
  B_HOLD_IDLE,
  B_HOLD_SLOP,
  B_TALK_CANCEL_PX,
  type BHoldEvent,
  classifySwipe,
  edgeFade,
  fadeMask,
  lockAxis,
  longPressCancelled,
  LONG_PRESS_SLOP,
  pageRelease,
  pullProgress,
  pullReached,
  PULL_THRESHOLD,
  rubberBand,
} from './gesture';
import { backGoesHome } from './phoneBack';

describe('phone gestures', () => {
  test('long-press is cancelled by moving more than the slop', () => {
    expect(longPressCancelled(0, 0)).toBe(false);
    expect(longPressCancelled(LONG_PRESS_SLOP - 1, 0)).toBe(false);
    expect(longPressCancelled(6, 6)).toBe(true);
    expect(longPressCancelled(0, -20)).toBe(true);
  });

  test('page swipe: quick, far and mostly sideways', () => {
    expect(classifySwipe(-120, 10, 200)).toBe(1); // finger left → next page
    expect(classifySwipe(120, -10, 200)).toBe(-1); // finger right → previous page
    expect(classifySwipe(-40, 0, 200)).toBeNull(); // too short
    expect(classifySwipe(-120, 70, 200)).toBeNull(); // too diagonal (a scroll)
    expect(classifySwipe(-120, 0, 2000)).toBeNull(); // too slow (a drag)
  });

  test('edge fades only where more is hidden', () => {
    expect(edgeFade(0, 200, 200)).toEqual({ left: false, right: false }); // everything fits
    expect(edgeFade(0, 400, 200)).toEqual({ left: false, right: true });
    expect(edgeFade(100, 400, 200)).toEqual({ left: true, right: true });
    expect(edgeFade(200, 400, 200)).toEqual({ left: true, right: false });
    expect(fadeMask({ left: false, right: false })).toBeUndefined();
    expect(fadeMask({ left: false, right: true })).toContain('transparent)');
  });

  test('Android Back: off HOME goes HOME; HOME and non-strip pages keep the old behaviour', () => {
    expect(backGoesHome('chat')).toBe(true);
    expect(backGoesHome('wallet')).toBe(true);
    expect(backGoesHome('home')).toBe(false);
    expect(backGoesHome(null)).toBe(false);
  });
});

describe('iOS-style paging maths', () => {
  test('axis locks after 10px, by the larger component', () => {
    expect(lockAxis(5, 5)).toBe(null);
    expect(lockAxis(12, 3)).toBe('x');
    expect(lockAxis(3, -12)).toBe('y');
  });
  test('release: distance or flick commits, never past an end', () => {
    expect(pageRelease(-200, 0, 390, true, true)).toBe(1);
    expect(pageRelease(200, 0, 390, true, true)).toBe(-1);
    expect(pageRelease(-60, 0, 390, true, true)).toBe(0);
    expect(pageRelease(-60, -0.8, 390, true, true)).toBe(1);
    expect(pageRelease(-60, 0.8, 390, true, true)).toBe(0);
    expect(pageRelease(-300, -1, 390, true, false)).toBe(0);
    expect(pageRelease(300, 1, 390, false, true)).toBe(0);
  });
  test('rubber band moves less than the finger and keeps the sign', () => {
    expect(Math.abs(rubberBand(100, 390))).toBeLessThan(40);
    expect(rubberBand(-100, 390)).toBeLessThan(0);
    expect(rubberBand(0, 390)).toBe(0);
  });
});

describe('pull to the b agent', () => {
  test('progress fills to the 70px threshold; below it springs back', () => {
    expect(PULL_THRESHOLD).toBe(70);
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(35)).toBeCloseTo(0.5, 6);
    expect(pullProgress(200)).toBe(1);
    expect(pullReached(69)).toBe(false);
    expect(pullReached(70)).toBe(true);
  });
});

describe('b hold to talk', () => {
  const run = (events: BHoldEvent[]) => {
    let s = B_HOLD_IDLE;
    const effects: string[] = [];
    for (const e of events) {
      const r = bHold(s, e);
      s = r.state;
      if (r.effect !== 'none') effects.push(r.effect);
    }
    return { phase: s.phase, effects };
  };
  const down = { type: 'down', x: 100, y: 500 } as const;

  test('a tap is HOME', () => {
    expect(run([down, { type: 'up' }])).toEqual({ phase: 'idle', effects: ['home'] });
  });
  test('holding past the timer listens; release sends', () => {
    expect(run([down, { type: 'timer' }]).effects).toEqual(['listen']);
    expect(run([down, { type: 'timer' }, { type: 'move', x: 110, y: 490 }, { type: 'up' }])).toEqual({
      phase: 'idle',
      effects: ['listen', 'send'],
    });
  });
  test('moving before the hold starts cancels both tap and hold', () => {
    expect(run([down, { type: 'move', x: 100 + B_HOLD_SLOP + 1, y: 500 }, { type: 'timer' }, { type: 'up' }])).toEqual({
      phase: 'idle',
      effects: [],
    });
  });
  test('slide away then release cancels; sliding back keeps it', () => {
    const away = { type: 'move', x: 100, y: 500 - B_TALK_CANCEL_PX - 1 } as const;
    expect(run([down, { type: 'timer' }, away]).phase).toBe('cancelling');
    expect(run([down, { type: 'timer' }, away, { type: 'up' }]).effects).toEqual(['listen', 'cancel']);
    expect(run([down, { type: 'timer' }, away, { type: 'move', x: 100, y: 480 }, { type: 'up' }]).effects).toEqual([
      'listen',
      'send',
    ]);
  });
  test('abort while listening cancels; abort while pressing does nothing', () => {
    expect(run([down, { type: 'timer' }, { type: 'abort' }]).effects).toEqual(['listen', 'cancel']);
    expect(run([down, { type: 'abort' }, { type: 'up' }]).effects).toEqual([]);
  });
  test('a late timer or a second down is ignored', () => {
    expect(run([down, { type: 'up' }, { type: 'timer' }]).effects).toEqual(['home']);
    expect(run([down, { type: 'timer' }, down, { type: 'up' }]).effects).toEqual(['listen', 'send']);
  });
});

describe('b hold timing (owner, 10 Oct 2026)', () => {
  const at = (events: BHoldEvent[]) => events.reduce((acc, e) => {
    const r = bHold(acc.s, e);
    return { s: r.state, fx: r.effect === 'none' ? acc.fx : [...acc.fx, r.effect] };
  }, { s: B_HOLD_IDLE, fx: [] as string[] });
  test('the hold is about 400ms: long enough not to steal taps, short enough to feel instant', () => {
    expect(B_HOLD_MS).toBe(400);
  });
  test('release before the timer = tap = Apps (home)', () => {
    expect(at([{ type: 'down', x: 0, y: 0 }, { type: 'up' }]).fx).toEqual(['home']);
  });
  test('timer fires = listen (opens b + mic), release = send', () => {
    expect(at([{ type: 'down', x: 0, y: 0 }, { type: 'timer' }, { type: 'up' }]).fx).toEqual(['listen', 'send']);
  });
  test('slide away while listening, release = cancel; slide back = send', () => {
    const d = { type: 'down', x: 0, y: 0 } as const;
    expect(at([d, { type: 'timer' }, { type: 'move', x: 0, y: -200 }, { type: 'up' }]).fx).toEqual(['listen', 'cancel']);
    expect(at([d, { type: 'timer' }, { type: 'move', x: 0, y: -200 }, { type: 'move', x: 0, y: -5 }, { type: 'up' }]).fx).toEqual(['listen', 'send']);
  });
  test('a late timer after release does nothing', () => {
    expect(at([{ type: 'down', x: 0, y: 0 }, { type: 'up' }, { type: 'timer' }]).fx).toEqual(['home']);
  });
});
