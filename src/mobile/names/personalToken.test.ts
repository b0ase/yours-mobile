import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import {
  DEFAULT_SUPPLY,
  MAP_PREFIX,
  cleanSupply,
  isPersonalTokenId,
  isVerified,
  personalKey,
  personalMapScript,
  personalTicker,
  tickerLabel,
  validateSupply,
  withPersonalMap,
} from './personalToken';

const ID = `${'a'.repeat(64)}_0`;
const COPY = `${'b'.repeat(64)}_0`;
const link = { name: 'boase', tokenId: ID };

describe('personal token naming', () => {
  test('ticker = the name, upper-cased, without $ or @domain', () => {
    expect(personalTicker('$boase')).toBe('BOASE');
    expect(personalTicker('boase@handcash.io')).toBe('BOASE');
    expect(personalTicker('a b')).toBeNull();
    expect(personalTicker('')).toBeNull();
    expect(personalKey('$BOASE')).toBe('boase');
  });
  test('supply defaults to 1,000,000 and is validated', () => {
    expect(DEFAULT_SUPPLY).toBe('1000000');
    expect(validateSupply('1,000,000')).toBeNull();
    expect(cleanSupply('1,000,000')).toBe('1000000');
    expect(validateSupply('0')).not.toBeNull();
    expect(validateSupply('1.5')).not.toBeNull();
    expect(validateSupply('9'.repeat(20))).not.toBeNull();
  });
});

describe('✓ verification (tickers are not unique)', () => {
  test('✓ only for the token id linked to the name', () => {
    expect(isVerified(link, '$BOASE', ID.replace('_', '.'))).toBe(true);
    expect(tickerLabel('BOASE', ID, [link])).toBe('$BOASE ✓');
  });
  test('a copycat BOASE shows without ✓', () => {
    expect(isVerified(link, 'BOASE', COPY)).toBe(false);
    expect(tickerLabel('BOASE', COPY, [link])).toBe('$BOASE');
  });
  test('the linked id under another ticker is not ✓', () => {
    expect(tickerLabel('ALICE', ID, [link])).toBe('$ALICE');
    expect(isVerified(null, 'boase', ID)).toBe(false);
  });
  test('personal-token badge by id', () => {
    expect(isPersonalTokenId(ID, [link])).toBe(true);
    expect(isPersonalTokenId(COPY, [link])).toBe(false);
  });
});

describe('on-chain MAP link', () => {
  test('OP_FALSE OP_RETURN MAP SET app bWallet type personal-token name boase', () => {
    const hex = personalMapScript('$Boase', 'BOASE').toHex();
    expect(hex.startsWith('006a')).toBe(true);
    for (const part of [MAP_PREFIX, 'SET', 'personal-token', 'boase', 'BOASE']) {
      expect(hex).toContain(Buffer.from(part).toString('hex'));
    }
  });
  test('appends one 0-sat MAP output to the next createAction only; nothing else changes', async () => {
    const calls: { outputs?: { satoshis: number; lockingScript: string }[] }[] = [];
    const wallet = { createAction: async (a: (typeof calls)[0]) => (calls.push(a), { txid: 'x' }) };
    const ctx = withPersonalMap({ wallet } as unknown as OneSatContext, 'boase', 'BOASE');
    const deploy = { lockingScript: 'deploy', satoshis: 1 };
    await (ctx.wallet as unknown as typeof wallet).createAction({ outputs: [deploy] });
    await (ctx.wallet as unknown as typeof wallet).createAction({ outputs: [deploy] });
    expect(calls[0].outputs?.length).toBe(2);
    expect(calls[0].outputs?.[0]).toEqual(deploy); // deploy stays vout 0 → token id unchanged
    expect(calls[0].outputs?.[1].satoshis).toBe(0);
    expect(calls[1].outputs?.length).toBe(1);
  });
});
