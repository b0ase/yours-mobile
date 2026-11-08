import { describe, expect, test } from 'bun:test';
import pm from '../lib/paymail.js';

// ArtechEx names (owner, 8 Nov 2026): nobody can claim them; each is assigned to its owner's wallet by hand.
describe('ArtechEx reserved names', () => {
  for (const name of ['artechex', 'henry', 'admir', 'andres', 'oleg', 'richard']) {
    test(`${name}@ is reserved, plain and social`, () => {
      for (const a of [name, `${name}.x`, `${name}.gmail`])
        expect([a, pm.validAlias(a)]).toEqual([a, 'That alias is reserved']);
    });
  }
});
