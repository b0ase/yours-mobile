import { describe, expect, test } from 'bun:test';
import { usableTranscript, voiceNote } from './voiceText';

describe('hold to talk text', () => {
  test('every failure has a note, platform-specific where it matters', () => {
    for (const p of ['ios', 'android', 'web', 'extension'] as const)
      for (const r of ['unavailable', 'denied', 'asked', 'empty'] as const)
        expect(voiceNote(r, p).length).toBeGreaterThan(10);
    expect(voiceNote('denied', 'ios')).toContain('Speech Recognition');
    expect(voiceNote('asked', 'extension')).toContain('tab');
  });
  test('blank transcripts are not sent', () => {
    expect(usableTranscript('  \n ')).toBe('');
    expect(usableTranscript(' what is  my balance ')).toBe('what is my balance');
  });
});
