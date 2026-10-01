import { describe, expect, test } from 'bun:test';
import { SafetyFilter, type Blocklist } from '../market/safety';
import { mintFeeFor, txFeeSats } from '../mint/mint';
import { TICKET_BLOCKED } from '../tickets/tickets';
import {
  TOKEN_COPY,
  TOKEN_DEPLOY_BYTES,
  cleanToken,
  emptyTokenForm,
  tokenCost,
  tokenFoundingMessage,
  validateToken,
  type TokenForm,
} from './token';

const EMPTY: Blocklist = {
  collections: [],
  origins: [],
  outpoints: [],
  tokens: [],
  keywords: [],
  substrings: [],
  allowCollections: [],
};
const ok = new SafetyFilter(EMPTY);
const FEE_ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const form = (o: Partial<TokenForm> = {}): TokenForm => ({ ...emptyTokenForm(), name: 'Gold', ticker: 'GOLD', ...o });

describe('token form', () => {
  test('copy and defaults', () => {
    expect(TOKEN_COPY).toBe('Create a BSV-21 token. Every token has a room for its holders.');
    expect(emptyTokenForm().decimals).toBe('0');
    expect(validateToken(form(), ok)).toBeNull();
  });

  test('validates name, ticker, supply, decimals', () => {
    expect(validateToken(form({ name: ' ' }), ok)).toBe('Name the token.');
    expect(validateToken(form({ ticker: '' }), ok)).toBe('Add a ticker.');
    expect(validateToken(form({ ticker: 'go ld' }), ok)).toMatch(/^Ticker/);
    expect(validateToken(form({ supply: '0' }), ok)).toBe('Supply must be at least 1.');
    expect(validateToken(form({ decimals: '19' }), ok)).toMatch(/^Decimals/);
    expect(validateToken(form({ decimals: '-1' }), ok)).toMatch(/^Decimals/);
    expect(validateToken(form({ supply: '1000000000000000', decimals: '8' }), ok)).toBe(
      'Supply is too large for these decimals.',
    );
  });

  test('safety filter blocks', () => {
    const s = new SafetyFilter({ ...EMPTY, keywords: ['forbidden'] });
    expect(validateToken(form({ description: 'a forbidden coin' }), s)).toBe(TICKET_BLOCKED);
  });

  test('raw amount and room minimum scale with decimals', () => {
    expect(cleanToken(form({ supply: '1,000', decimals: '2', ticker: '$GOLD' }))).toMatchObject({
      ticker: 'GOLD',
      supply: '1000',
      decimals: 2,
      amount: '100000',
      min: '100',
    });
    expect(cleanToken(form({ supply: '5' }))).toMatchObject({ amount: '5', min: '1' });
  });
});

describe('token cost', () => {
  test('same 1% mint fee rule, smaller deploy (no MAP)', () => {
    const c = tokenCost(0, 100, 0, FEE_ADDR);
    expect(c.networkSats).toBe(txFeeSats(TOKEN_DEPLOY_BYTES, 100));
    expect(c.feeSats).toBe(mintFeeFor(c.networkSats, FEE_ADDR));
    expect(tokenCost(0, 100, 0, '').feeSats).toBe(0);
    expect(tokenCost(10_000, 100).txCount).toBe(2);
  });
});

test('founding message', () => {
  expect(tokenFoundingMessage({ name: 'Gold', ticker: 'GOLD', description: '' })).toBe(
    'Welcome to Gold, the room for $GOLD holders.',
  );
  expect(tokenFoundingMessage({ name: 'Gold', ticker: 'GOLD', description: 'hi' })).toContain('\n\nhi');
});
