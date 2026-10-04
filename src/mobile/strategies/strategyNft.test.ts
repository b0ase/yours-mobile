import { describe, expect, test } from 'bun:test';
import { exampleStrategy } from '../agents/strategy';
import { openStrategy, parseEnvelope, publishProblems, sealStrategy } from './strategyNft';

const sale = { priceUsd: 5, copies: 100, payTo: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' };
const meta = { description: 'Buys slowly.', author: { name: 'b0ase', address: sale.payTo }, sale };

describe('strategy NFT', () => {
  test('seal → open round-trips; the program is not readable in the envelope', async () => {
    const s = exampleStrategy('ABC');
    const { envelope, key } = await sealStrategy(s, meta);
    expect(JSON.stringify(envelope)).not.toContain('maxPerTradeUsd');
    expect(envelope.spec.risk).toBe('Medium');
    expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    expect(await openStrategy(envelope, key)).toEqual(s);
  });

  test('a key for another envelope is refused', async () => {
    const a = await sealStrategy(exampleStrategy('A'), meta);
    const b = await sealStrategy(exampleStrategy('B'), meta);
    await expect(openStrategy(a.envelope, b.key)).rejects.toThrow('doesn’t belong');
  });

  test('publishing needs a full spec and sane terms', () => {
    const s = exampleStrategy();
    expect(publishProblems(s, sale, 'd')).toEqual([]);
    expect(publishProblems({ ...s, spec: { ...s.spec, stops: '' } }, sale, 'd')[0]).toContain('When it stops');
    expect(publishProblems(s, { ...sale, copies: 0 }, '').length).toBe(2);
    expect(parseEnvelope('{"format":"x"}')).toBeNull();
  });
});
