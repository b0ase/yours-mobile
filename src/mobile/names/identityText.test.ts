import { describe, expect, test } from 'bun:test';
import { identityRowText } from './identityText';

describe('identity row', () => {
  test('paymail handle: $alias, full paymail, tap copies the paymail', () => {
    // Outside a build the paymail domain is unset, so bareName keeps the address; use a bare alias.
    expect(identityRowText('Testytester', 'testy', '')).toMatchObject({ name: 'Testytester', tag: '$testy' });
    const t = identityRowText('Testytester', 'testy@bwallet.space', '');
    expect(t.full).toBe('testy@bwallet.space');
    expect(t.copy).toBe('testy@bwallet.space');
  });
  test('card front shows the full bWalletX paymail, not just the $handle', () => {
    const t = identityRowText('b0asex', 'b0asex@bwalletx.com', '');
    expect(t.front).toBe('b0asex@bwalletx.com');
  });
  test('OpNS only; name equal to the handle is not repeated', () => {
    expect(identityRowText('alice', '', 'alice')).toEqual({
      name: '',
      tag: '$alice',
      full: '',
      front: '$alice',
      copy: 'alice',
    });
  });
  test('no handle: name only, nothing to copy', () => {
    expect(identityRowText('Account 1', '', '')).toEqual({ name: 'Account 1', tag: '', full: '', front: '', copy: '' });
  });
});
