import { describe, expect, test } from 'bun:test';
import { TERMS_LINE, TERMS_URL, isSetupPath, isUgcPath, termsSheetNeeded } from './ugc';

describe('terms at setup, not in chat (owner, 3 Nov 2026)', () => {
  test('the one line, word for word, with "Terms of Use" as the link to the conduct terms', () => {
    expect(`${TERMS_LINE.before}${TERMS_LINE.link}${TERMS_LINE.after}`).toBe(
      'By continuing you agree to the Terms of Use. We remove objectionable content and ban abusive accounts. Anything written to the blockchain is public and permanent.',
    );
    expect(TERMS_URL.endsWith('/terms#conduct')).toBe(true);
  });

  test('setup routes carry the line themselves', () => {
    for (const p of ['/', '/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore', '/restore-wallet/'])
      expect(isSetupPath(p)).toBe(true);
    for (const p of ['/bsv-wallet', '/m/chat', '/m/home', '/settings']) expect(isSetupPath(p)).toBe(false);
  });

  test('screens with other people’s content', () => {
    for (const p of ['/m/feed', '/m/chat', '/m/chat/bapps', '/m/calls', '/m/bpics', '/m/spaces'])
      expect(isUgcPath(p)).toBe(true);
    for (const p of ['/m/chatter', '/m/home', '/bsv-wallet', '/m/names']) expect(isUgcPath(p)).toBe(false);
  });

  const base = { accepted: false, hasWallet: true, locked: false, pathname: '/bsv-wallet' };
  test('an open wallet that never agreed gets the one-tap sheet, on any screen', () => {
    expect(termsSheetNeeded(base)).toBe(true);
    expect(termsSheetNeeded({ ...base, pathname: '/m/chat' })).toBe(true);
    expect(termsSheetNeeded({ ...base, pathname: '/m/home' })).toBe(true);
  });
  test('never once agreed, never on the lock screen, never over setup', () => {
    expect(termsSheetNeeded({ ...base, accepted: true })).toBe(false);
    expect(termsSheetNeeded({ ...base, locked: true })).toBe(false);
    expect(termsSheetNeeded({ ...base, pathname: '/create-wallet' })).toBe(false);
    expect(termsSheetNeeded({ ...base, pathname: '/' })).toBe(false);
  });
  test('no wallet (a web deep link): still covers Feed, Chat, DMs and Calls, nothing else', () => {
    const none = { ...base, hasWallet: false };
    expect(termsSheetNeeded({ ...none, pathname: '/m/feed' })).toBe(true);
    expect(termsSheetNeeded({ ...none, pathname: '/m/calls' })).toBe(true);
    expect(termsSheetNeeded({ ...none, pathname: '/m/names' })).toBe(false);
  });
});
