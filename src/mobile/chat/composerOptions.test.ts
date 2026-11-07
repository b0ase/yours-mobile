import { describe, expect, test } from 'bun:test';
import {
  clockLabel,
  composerOptions,
  recorderMime,
  runComposerOption,
  voiceFileName,
  type ComposerContext,
  type ComposerHandlers,
  type ComposerOptionId,
} from './composerOptions';

const base: ComposerContext = { online: true, uploads: true, canRecord: true, call: null, draftable: false };
const ids = (c: Partial<ComposerContext>) => composerOptions({ ...base, ...c }).map((o) => o.id);
const off = (c: Partial<ComposerContext>, id: ComposerOptionId) =>
  composerOptions({ ...base, ...c }).find((o) => o.id === id)?.off;

const spyHandlers = () => {
  const ran: ComposerOptionId[] = [];
  const h = Object.fromEntries(
    (['photo', 'file', 'gif', 'emoji', 'voice', 'call', 'draft'] as const).map((id) => [id, () => ran.push(id)]),
  ) as ComposerHandlers;
  return { ran, h };
};

describe('composerOptions: the "+" sheet', () => {
  test('every option the second row would have had, in one sheet', () => {
    expect(ids({})).toEqual(['photo', 'file', 'gif', 'emoji', 'voice', 'call']);
    expect(ids({ draftable: true })).toEqual(['photo', 'file', 'gif', 'emoji', 'voice', 'call', 'draft']);
  });

  test('offline: everything but emoji is off, with the reason', () => {
    const o = composerOptions({ ...base, online: false, call: { kind: 'dm', peer: 'alice' } });
    expect(o.filter((x) => !x.off).map((x) => x.id)).toEqual(['emoji']);
    expect(o.find((x) => x.id === 'photo')?.off).toBe('Offline');
  });

  test('rooms that charge per message: no uploads or voice notes (GIF and emoji still work)', () => {
    expect(off({ uploads: false }, 'photo')).toMatch(/charge/);
    expect(off({ uploads: false }, 'file')).toMatch(/charge/);
    expect(off({ uploads: false }, 'voice')).toMatch(/charge/);
    expect(off({ uploads: false }, 'gif')).toBeUndefined();
    expect(off({ uploads: false }, 'emoji')).toBeUndefined();
  });

  test('voice note is off where the device cannot record', () => {
    expect(off({ canRecord: false }, 'voice')).toMatch(/record/);
  });

  test('call: a DM rings the person; a room joins or starts its Space; otherwise off', () => {
    const label = (c: ComposerContext['call']) => composerOptions({ ...base, call: c }).find((o) => o.id === 'call')!;
    expect(label({ kind: 'dm', peer: 'alice' })).toMatchObject({ label: 'Call $alice', off: undefined });
    expect(label({ kind: 'join' }).label).toBe('Join the Space');
    expect(label({ kind: 'start' }).label).toBe('Start a Space');
    expect(label(null).off).toBeTruthy();
  });
});

describe('runComposerOption: each tile runs its own action', () => {
  test('every enabled option runs exactly its handler', () => {
    const options = composerOptions({ ...base, call: { kind: 'join' }, draftable: true });
    for (const o of options) {
      const { ran, h } = spyHandlers();
      expect(runComposerOption(o.id, options, h)).toBe(true);
      expect(ran).toEqual([o.id]);
    }
  });

  test('an option that is off runs nothing', () => {
    const options = composerOptions({ ...base, online: false });
    const { ran, h } = spyHandlers();
    expect(runComposerOption('photo', options, h)).toBe(false);
    expect(runComposerOption('call', options, h)).toBe(false);
    expect(ran).toEqual([]);
  });

  test('an option not in this room (Draft with b) runs nothing', () => {
    const options = composerOptions(base);
    const { ran, h } = spyHandlers();
    expect(runComposerOption('draft', options, h)).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe('voice notes', () => {
  test('recorder format: Opus/WebM first, else MP4 (iPhone), else the default', () => {
    expect(recorderMime((m) => m.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(recorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(recorderMime(() => false)).toBe('');
    expect(
      recorderMime(() => {
        throw new Error('old engine');
      }),
    ).toBe('');
  });

  test('file names carry the right extension', () => {
    const at = new Date(2026, 10, 4, 15, 30);
    expect(voiceFileName('audio/webm;codecs=opus', at)).toBe('voice-2026-11-04-1530.webm');
    expect(voiceFileName('audio/mp4', at)).toBe('voice-2026-11-04-1530.m4a');
    expect(voiceFileName('audio/ogg;codecs=opus', at)).toBe('voice-2026-11-04-1530.ogg');
  });

  test('clock label', () => {
    expect(clockLabel(7_400)).toBe('0:07');
    expect(clockLabel(150_000)).toBe('2:30');
    expect(clockLabel(-5)).toBe('0:00');
  });
});
