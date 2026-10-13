import { describe, expect, test } from 'bun:test';
import { decideExisting, duplicateNote, matchExistingToken, personalTokenLabel } from './existingToken';
import { handleCardTitle } from './handlePrompt';
import { deployPersonalToken } from './claimPersonal';
import type { OneSatContext } from '@1sat/actions';

const ID = 'a'.repeat(64) + '_0';
const npg = { tokenId: ID, sym: 'NPG', issued: true };

describe('handle ↔ existing token', () => {
  test('matches ticker and brand aliases', () => {
    expect(matchExistingToken('npg', [npg])?.tokenId).toBe(ID);
    expect(matchExistingToken('npg', [{ tokenId: ID, sym: 'NINJAPUNKGIRLS' }])?.tokenId).toBe(ID);
    expect(matchExistingToken('john', [npg])).toBeNull();
  });
  test('import offered when the account controls the token', () => {
    expect(decideExisting({ handle: 'npg', controlled: [npg], othersBsv21: 1, bsv20Tick: true }).kind).toBe('import');
    expect(handleCardTitle(true, 'NPG')).toBe('We found the $NPG token — sign to import it');
    expect(handleCardTitle(true, null)).toBe('Open your $name room');
  });
  test('a holder (not the issuer) is never offered the import; gets the labelled-mint note', () => {
    const held = { tokenId: ID, sym: 'NPG' };
    expect(decideExisting({ handle: 'npg', controlled: [held], othersBsv21: 0, bsv20Tick: false }).kind).toBe(
      'mint-labelled',
    );
  });
  test("labelled mint allowed when someone else's token uses the ticker", () => {
    expect(decideExisting({ handle: 'john', controlled: [], othersBsv21: 1, bsv20Tick: false }).kind).toBe(
      'mint-labelled',
    );
    expect(personalTokenLabel('john', 'bwalletx.com')).toBe('$john · personal token of john@bwalletx.com');
    expect(duplicateNote('john', 'bwalletx.com')).toContain('already a token called JOHN by someone else');
  });
  test('a taken BSV-20 tick is an error, nothing new is a plain mint', () => {
    expect(decideExisting({ handle: 'john', controlled: [], othersBsv21: 0, bsv20Tick: true }).kind).toBe(
      'bsv20-taken',
    );
    expect(decideExisting({ handle: 'john', controlled: [], othersBsv21: 0, bsv20Tick: false }).kind).toBe('mint');
  });
  test('the mint path refuses an import, a taken BSV-20 tick and an unacknowledged duplicate', async () => {
    const ctx = {} as OneSatContext; // never reached: the checks come first
    const base = { identityAddress: '1x', name: 'npg', supply: '1000', icon: 'x' };
    await expect(deployPersonalToken(ctx, { ...base, choice: { kind: 'import', token: npg } })).rejects.toThrow(
      /Import it/,
    );
    await expect(deployPersonalToken(ctx, { ...base, choice: { kind: 'bsv20-taken', tick: 'NPG' } })).rejects.toThrow(
      /BSV-20/,
    );
    await expect(deployPersonalToken(ctx, { ...base, choice: { kind: 'mint-labelled', others: 1 } })).rejects.toThrow(
      /someone else/,
    );
  });
});
