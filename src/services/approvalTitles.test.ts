import { describe, expect, test } from 'bun:test';
import { sheetTitleText, withoutSuffix } from './approvalKind';

const docs = { text: 'Sign and encrypt anything with your "bchat documents" keys' };
describe('sheet titles say what is granted (owner, 26 Oct 2026)', () => {
  test('sign-in is connecting', () =>
    expect(sheetTitleText('signin', 'bchatx', { lines: [] })).toBe('Connect and sign in to bchatx'));
  test('connect names the keys it uses', () =>
    expect(sheetTitleText('connect', 'bchatx', { lines: [docs] as never })).toBe(
      'Connect to bchatx and use your "bchat documents" keys',
    ));
  test('private data', () =>
    expect(sheetTitleText('private', 'bchatx', { lines: [{ privateLabel: 'documents' }] as never })).toBe(
      'Open your private documents on bchatx',
    ));
});

describe('button says what is left out', () => {
  test('all ticked: nothing added', () => expect(withoutSuffix([docs], () => true)).toBe(''));
  test('one unticked: named', () => expect(withoutSuffix([docs], () => false)).toBe(' without bchat documents'));
  test('several unticked', () =>
    expect(withoutSuffix([docs, { text: 'Keep items' }], () => false)).toBe(' without 2 permissions'));
});
