import { describe, expect, test } from 'bun:test';
import { cleanDisplayName, defaultDisplayName } from './paymail';
// The server's rules (site/lib/displayName.js) and the app's must agree.
const server = require('../../../site/lib/displayName.js');

const CASES = [
  '  Mike   Smith ',
  'Mike @bwalletx',
  'mike@bwalletx.com',
  'Mike verified ✓',
  'Anonymous',
  'Account 1',
  'Mi\u200bke\u0007',
  'a'.repeat(80),
  'Zoë',
];

describe('display name (app)', () => {
  test('matches the server for every case', () => {
    for (const c of CASES) expect(cleanDisplayName(c)).toBe(server.cleanDisplayName(c));
    for (const a of ['mike', 'b0asex.x', 'mary_jo']) expect(defaultDisplayName(a)).toBe(server.defaultDisplayName(a));
  });
  test('never blank after a default', () => {
    expect(cleanDisplayName('Anonymous') || defaultDisplayName('mike')).toBe('Mike');
  });
});
