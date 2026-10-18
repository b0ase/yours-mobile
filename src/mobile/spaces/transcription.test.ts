import { describe, expect, test } from 'bun:test';
import {
  isNotTranscribed,
  mayRedactLine,
  needsListenNotice,
  needsSpeakChoice,
  OFF,
  parseTranscript,
  parseTranscription,
} from './transcription';

describe('space transcription', () => {
  test('missing or malformed reads as off', () => {
    expect(parseTranscription(undefined)).toEqual(OFF);
    expect(parseTranscription({ mode: 'on' }).mode).toBe('off');
  });

  test('on: badge, notices, labels and my consents', () => {
    const t = parseTranscription({
      mode: 'agreements',
      not_transcribed: ['$Erin', 'host1'],
      me: { listen: true, speak: false },
      speak_notice: 'tick me',
    });
    expect(t.badge).toBe('Transcribing');
    expect(t.speakNotice).toBe('tick me');
    expect(isNotTranscribed(t, 'erin')).toBe(true);
    expect(isNotTranscribed(t, 'alice')).toBe(false);
    expect(t.me).toEqual({ listen: true, speak: false });
  });

  test('off: nobody labelled, no badge', () => {
    const t = parseTranscription({ mode: 'off', not_transcribed: ['erin'] });
    expect(t.badge).toBeNull();
    expect(t.notTranscribed).toEqual([]);
  });

  test('listen notice before joining, not for anonymous listeners or once acknowledged', () => {
    const on = parseTranscription({ mode: 'transcribe' });
    expect(needsListenNotice(on, false)).toBe(true);
    expect(needsListenNotice(on, true)).toBe(false);
    expect(needsListenNotice(parseTranscription({ mode: 'transcribe', me: { listen: true } }), false)).toBe(false);
    expect(needsListenNotice(OFF, false)).toBe(false);
  });

  test('speak choice: only when on, not yet ticked, not answered, and never in a store build', () => {
    const on = parseTranscription({ mode: 'transcribe' });
    expect(needsSpeakChoice(on, { enabled: true, answered: false })).toBe(true);
    expect(needsSpeakChoice(on, { enabled: true, answered: true })).toBe(false);
    expect(needsSpeakChoice(on, { enabled: false, answered: false })).toBe(false);
    expect(
      needsSpeakChoice(parseTranscription({ mode: 'transcribe', me: { speak: true } }), {
        enabled: true,
        answered: false,
      }),
    ).toBe(false);
    expect(needsSpeakChoice(OFF, { enabled: true, answered: false })).toBe(false);
  });

  test('transcript: redacted lines never show words; only my lines are deletable', () => {
    const lines = parseTranscript({
      utterances: [
        { id: 'a', handle: 'Alice', t_start: '2026-10-18T10:00:00Z', text: 'hi', redacted: false },
        { id: 'b', handle: 'bob', t_start: null, text: 'leak', redacted_at: '2026-10-18T10:01:00Z' },
        { nope: 1 },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toBeNull();
    expect(mayRedactLine(lines[0], '$alice')).toBe(true);
    expect(mayRedactLine(lines[0], 'bob')).toBe(false);
    expect(mayRedactLine(lines[1], 'bob')).toBe(false);
  });
});
