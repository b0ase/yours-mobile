import { describe, expect, test } from 'bun:test';
import type { IndexedOutput } from '@1sat/types';
import type { EnrichedOrdinal, TokenBalance } from '../../sweep/scanner';
import {
  buildPlan,
  classifyOrdinal,
  defaultSelection,
  selectedWork,
  sweepButtonLabel,
  visibleResults,
  type OrdinalKind,
} from './plan';

const out = (outpoint: string, satoshis = 1000): IndexedOutput => ({ outpoint, satoshis }) as IndexedOutput;
const ord = (outpoint: string, origin?: string): EnrichedOrdinal =>
  ({ outpoint, satoshis: 1, origin }) as EnrichedOrdinal;
const tok = (tokenId: string, amount: bigint): TokenBalance => ({
  tokenId,
  symbol: tokenId.toUpperCase(),
  decimals: 0,
  totalAmount: amount,
  outputs: amount ? [out(`${tokenId}_0`, 1)] : [],
  isActive: true,
});
const label = { bsv: 'BSV', token: (t: TokenBalance) => t.symbol ?? t.tokenId };

describe('classifyOrdinal', () => {
  test('origin tracing to a BSV-20 / BSV-21 deploy is a token', () => {
    expect(classifyOrdinal([], { events: ['bsv21:abc_0'] })).toBe('token');
    expect(classifyOrdinal([], { data: { insc: { file: { type: 'application/bsv-20' } } } })).toBe('token');
    expect(classifyOrdinal(['type:application/bsv-20'], null)).toBe('token');
  });
  test('failed lookup is unknown, an image inscription is an NFT', () => {
    expect(classifyOrdinal(['type:image/png'], null)).toBe('unknown');
    expect(classifyOrdinal(['type:image/png'], { outpoint: 'x' })).toBe('nft');
    expect(classifyOrdinal([], { outpoint: 'x' })).toBe('unknown');
  });
});

describe('sweep plan', () => {
  const kinds = new Map<string, OrdinalKind>([
    ['n1', 'nft'],
    ['t1', 'token'],
    ['u1', 'unknown'],
  ]);
  const assets = {
    funding: [out('f1')],
    ordinals: [ord('n1'), ord('t1'), ord('u1')],
    bsv21Tokens: [tok('aaa', 5n), tok('zero', 0n)],
  };
  const plan = buildPlan(assets, kinds, label);

  test('origin-uncertain and token-like ordinals are possible tokens, never a class, never ticked', () => {
    expect(plan.possibleTokens.map((o) => o.outpoint)).toEqual(['t1', 'u1']);
    const nft = plan.classes.find((c) => c.key === 'nft');
    expect(nft && 'outputs' in nft ? nft.outputs.map((o) => o.outpoint) : []).toEqual(['n1']);
    const all = selectedWork(plan, new Set(plan.classes.map((c) => c.key)));
    expect(all.nfts.map((o) => o.outpoint)).toEqual(['n1']);
  });

  test('token classes with nothing in them are not offered', () => {
    expect(plan.classes.map((c) => c.key)).toEqual(['bsv', 'nft', 'token:aaa']);
  });

  test('never sweeps an unticked class', () => {
    const w = selectedWork(plan, new Set(['token:aaa']));
    expect(w.bsv).toBe(false);
    expect(w.nfts).toEqual([]);
    expect(w.tokens.map((t) => t.tokenId)).toEqual(['aaa']);
    expect(selectedWork(plan, new Set()).tokens).toEqual([]);
  });

  test('"Sweep all" only when everything is known-safe and ticked', () => {
    expect(sweepButtonLabel(plan, defaultSelection(plan))).toBe('Sweep selected to this account');
    const safe = buildPlan({ ...assets, ordinals: [ord('n1')] }, kinds, label);
    expect(sweepButtonLabel(safe, defaultSelection(safe))).toBe('Sweep all to this account');
    expect(sweepButtonLabel(safe, new Set(['bsv']))).toBe('Sweep selected to this account');
  });
});

describe('result lines', () => {
  test('classes that had nothing are dropped, real failures stay', () => {
    const shown = visibleResults([
      { label: 'BSV', txid: 'abc' },
      { label: 'X', error: 'no-token-amount' },
      { label: 'Y', error: 'overlay-validation-failed', amount: 0n },
      { label: 'Z', error: 'overlay-validation-failed', amount: 5n },
    ]);
    expect(shown.map((r) => r.label)).toEqual(['BSV', 'Z']);
  });
});
