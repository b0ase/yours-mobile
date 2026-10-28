import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CHOOSE_NAME_EXPLAINER,
  clearNameChoice,
  handleForProfile,
  linkedinAlias,
  nextNameStep,
  pendingNameChoice,
  rememberNameChoice,
} from './nameChoice';

describe('Choose your name', () => {
  beforeEach(() => clearNameChoice());
  test('a sign-in offers only its own provider suffix', () => {
    expect(handleForProfile({ provider: 'google', social_alias: 'richard.gmail' })).toBe('richard.gmail');
    expect(handleForProfile({ provider: 'github', social_alias: 'octo-cat.github' })).toBe('octo-cat.github');
    expect(handleForProfile({ provider: 'x', social_alias: 'richard.gmail' })).toBeNull();
    expect(handleForProfile({ provider: 'linkedin', social_alias: null })).toBeNull();
    expect(handleForProfile(null)).toBeNull();
  });
  test('LinkedIn slugs are chosen by the user', () => {
    expect(linkedinAlias('RichardBoase')).toBe('richardboase.linkedin');
    expect(linkedinAlias('richard-boase.linkedin')).toBe('richard-boase.linkedin');
    expect(linkedinAlias('-bad')).toBeNull();
  });
  test('the choice is held for 30 minutes', () => {
    rememberNameChoice({ provider: 'google', alias: 'richard.gmail' }, 1000);
    expect(pendingNameChoice(1000 + 60_000)?.alias).toBe('richard.gmail');
    expect(pendingNameChoice(1000 + 31 * 60_000)).toBeNull();
  });
  test('next step', () => {
    const g = { provider: 'google' as const, alias: 'r.gmail', at: 0 };
    const li = { provider: 'linkedin' as const, alias: 'r.linkedin', at: 0 };
    expect(nextNameStep(null, null)).toBe('none');
    expect(nextNameStep(g, null)).toBe('sign-in-again');
    expect(nextNameStep(g, { profile: { provider: 'google' } })).toBe('claim');
    expect(nextNameStep(li, { profile: { provider: 'linkedin' } })).toBe('confirm-linkedin');
    expect(nextNameStep(li, { profile: { provider: 'linkedin', id_token: 'a.b.c' } })).toBe('claim');
  });
  test('copy never uses money-making words', () => {
    expect(CHOOSE_NAME_EXPLAINER).not.toMatch(/\b(invest|returns?|yield|earn)\b/i);
  });
});
