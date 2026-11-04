import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chainKnowsTx, sendFailureText, type SendChecksContext } from './ownSend';
import { ownPaymentOutMessage, SPENT_ELSEWHERE_MESSAGE } from '../utils/sendErrors';

const T = 'a'.repeat(64);

const ctx = (woc: number, stack: string | Error, mainnet = true): SendChecksContext => ({
  storage: null,
  services: {
    getStatusForTxids: async () => {
      if (stack instanceof Error) throw stack;
      return { results: [{ txid: T, status: stack }] };
    },
  },
  identityKey: 'k',
  mainnet,
  kv: { get: async () => ({}), set: async () => undefined },
  fetch: (async () => new Response('', { status: woc })) as unknown as typeof fetch,
});

describe('chainKnowsTx (17b M1: "not sent" only when the chain confirms it)', () => {
  test('known when WhatsOnChain has it, or the 1Sat stack calls it known or mined', async () => {
    expect(await chainKnowsTx(ctx(200, 'unknown'), T)).toBe(true);
    expect(await chainKnowsTx(ctx(404, 'known'), T)).toBe(true);
    expect(await chainKnowsTx(ctx(404, 'mined'), T)).toBe(true);
  });
  test('not known only on a WhatsOnChain 404 with the stack not knowing it', async () => {
    expect(await chainKnowsTx(ctx(404, 'unknown'), T)).toBe(false);
    expect(await chainKnowsTx(ctx(404, new Error('stack down')), T)).toBe(false);
  });
  test("can't tell: WhatsOnChain errors, off mainnet, or no account", async () => {
    expect(await chainKnowsTx(ctx(503, 'unknown'), T)).toBeNull();
    expect(await chainKnowsTx(ctx(404, 'unknown', false), T)).toBeNull();
    expect(await chainKnowsTx(null, T)).toBeNull();
  });
});

describe('sendFailureText', () => {
  test("the retry stack's sentence wins; else the heal's words over the error", () => {
    expect(sendFailureText({ errorText: 'x', heal: { checked: 1, released: 1 }, notice: 'N', isSite: false })).toBe(
      'N',
    );
    expect(sendFailureText({ errorText: 'UTXO_SPENT', heal: { checked: 1, released: 1 }, isSite: false })).toBe(
      SPENT_ELSEWHERE_MESSAGE,
    );
  });
  test('a site never gets the txid of another payment of this wallet (17b L1)', () => {
    const notice = ownPaymentOutMessage(T);
    expect(sendFailureText({ errorText: 'x', heal: null, notice, isSite: false })).toContain(T);
    expect(sendFailureText({ errorText: 'x', heal: null, notice, isSite: true })).not.toContain(T.slice(0, 8));
  });
});

describe('17b L4: background.ts runs this pipeline, not a copy of it', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  test('processCWICreateAction sends through sendWithChecks and answers with sendFailureText', () => {
    expect(bg).toContain("from './services/ownSend'");
    expect(bg).toMatch(/await sendWithChecks\(\{/);
    expect(bg.match(/sendFailureText\(\{/g)?.length).toBe(2); // the site answer and the wallet's own
    expect(bg).toMatch(/healRefusedInputs\(sendChecksContext\(ctx\), error\)/);
    // No second, hand-wired retry stack left in the background.
    expect(bg).not.toMatch(/createWithSpentRetry\(/);
    expect(bg).not.toMatch(/withHealMessage\(/);
  });
});
