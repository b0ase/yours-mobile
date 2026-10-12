import { describe, expect, test } from 'bun:test';
import { createHoldToTalk, type HoldToTalkOptions, type HoldToTalkResult } from './holdToTalk';
import type { VoiceHandlers, VoiceStart } from './voice';

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(opts: { supported?: boolean | null; transcript?: string; fail?: string } = {}) {
  const log: string[] = [];
  const results: HoldToTalkResult[] = [];
  let fire: (() => void) | null = null;
  let handlers: VoiceHandlers | null = null;
  const o: HoldToTalkOptions = {
    onTap: () => log.push('tap'),
    onListen: (ok) => log.push(`listen:${ok}`),
    onResult: (r) => results.push(r),
    onUnsupportedRelease: () => log.push('focus'),
    onCancel: () => log.push('cancel'),
    onChange: () => {},
    haptic: () => log.push('haptic'),
    supported: () => (opts.supported === undefined ? true : opts.supported),
    start: (h): Promise<VoiceStart> => {
      handlers = h;
      log.push('start');
      if (opts.fail) return Promise.resolve({ ok: false, reason: 'denied', note: opts.fail });
      return Promise.resolve({
        ok: true,
        session: {
          stop: () => Promise.resolve(opts.transcript ?? ''),
          cancel: () => log.push('voice-cancel'),
        },
      });
    },
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => (fire = null),
  };
  const c = createHoldToTalk(o);
  const hold = () => {
    c.down(0, 0);
    fire?.();
  };
  return { c, log, results, hold, handlers: () => handlers };
}

describe('hold to talk', () => {
  test('a short press is a tap, no voice', () => {
    const r = rig();
    r.c.down(0, 0);
    r.c.up();
    expect(r.log).toEqual(['tap']);
    expect(r.c.phase()).toBe('idle');
  });

  test('start: haptic, then listening with a sheet and live text', () => {
    const r = rig();
    r.hold();
    expect(r.log).toEqual(['haptic', 'listen:true', 'start']);
    expect(r.c.phase()).toBe('listening');
    r.handlers()?.onText('hello');
    r.handlers()?.onLevel(0.5);
    expect(r.c.sheet()).toEqual({ text: 'hello', level: 0.5 });
  });

  test('release hands the cleaned transcript back (never sends)', async () => {
    const r = rig({ transcript: '  send   5p to  $bob ' });
    r.hold();
    r.c.up();
    await flush();
    await flush();
    expect(r.results).toEqual([{ text: 'send 5p to $bob' }]);
    expect(r.c.sheet()).toBeNull();
    expect(r.c.phase()).toBe('idle');
  });

  test('release with nothing heard gives a note', async () => {
    const r = rig({ transcript: '' });
    r.hold();
    r.c.up();
    await flush();
    await flush();
    expect(r.results.length).toBe(1);
    expect('note' in r.results[0]!).toBe(true);
  });

  test('a mic failure note is shown and returned', async () => {
    const r = rig({ fail: 'Allow the microphone' });
    r.hold();
    await flush();
    expect(r.c.sheet()?.note).toBe('Allow the microphone');
    r.c.up();
    await flush();
    expect(r.results).toEqual([{ note: 'Allow the microphone' }]);
  });

  test('slide away then release cancels the voice session', async () => {
    const r = rig({ transcript: 'x' });
    r.hold();
    r.c.move(200, 0);
    expect(r.c.phase()).toBe('cancelling');
    r.c.up();
    await flush();
    expect(r.log).toContain('voice-cancel');
    expect(r.log).toContain('cancel');
    expect(r.results).toEqual([]);
  });

  test('abort (Escape / app hidden) while listening cancels', async () => {
    const r = rig({ transcript: 'x' });
    r.hold();
    r.c.abort();
    await flush();
    expect(r.log).toContain('voice-cancel');
    expect(r.results).toEqual([]);
    expect(r.c.phase()).toBe('idle');
  });

  test('unsupported: no voice starts; release focuses the composer', () => {
    const r = rig({ supported: false });
    r.hold();
    r.c.up();
    expect(r.log).toEqual(['haptic', 'listen:false', 'focus']);
    expect(r.c.sheet()).toBeNull();
  });

  test('moving before the hold starts is a miss', () => {
    const r = rig();
    r.c.down(0, 0);
    r.c.move(50, 0);
    r.c.up();
    expect(r.log).toEqual([]);
  });
});
