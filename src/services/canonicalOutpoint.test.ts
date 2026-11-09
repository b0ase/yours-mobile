import { describe, expect, test } from 'bun:test';
import { parseWalletOutpoint } from '@bsv/sdk/wallet/validationHelpers';
import { BAD_OUTPOINT_REFUSAL, canonicalInputs, canonicalOutpoint } from './canonicalOutpoint';

const T = 'ab'.repeat(32);

describe('canonicalOutpoint', () => {
  test('either separator and any hex case give one spelling', () => {
    for (const op of [`${T}.5`, `${T}_5`, `${T.toUpperCase()}.5`, `${T.toUpperCase()}_5`, `aB${T.slice(2)}.5`])
      expect(canonicalOutpoint(op)).toBe(`${T}.5`);
  });

  test('index bounds', () => {
    expect(canonicalOutpoint(`${T}.0`)).toBe(`${T}.0`);
    expect(canonicalOutpoint(`${T}.4294967295`)).toBe(`${T}.4294967295`);
    expect(canonicalOutpoint(`${T}.4294967296`)).toBeNull();
    expect(canonicalOutpoint(`${T}.99999999999`)).toBeNull();
  });

  test('anything else is null', () => {
    for (const bad of [
      ` ${T}.0`,
      `${T}.0 `,
      `${T}.0\n`,
      `\t${T}.0`,
      `${T}.00`,
      `${T}.01`,
      `${T}.+1`,
      `${T}.-1`,
      `${T}.1e0`,
      `${T}.٣`,
      `${T}:0`,
      `${T}._0`,
      `${T}.`,
      T,
      `.0`,
      `0x${T}.0`,
      `${T.slice(1)}.0`,
      `${T}a.0`,
      `${T.slice(1)}g.0`,
      '',
      0,
      null,
      undefined,
      {},
      [`${T}.0`],
    ])
      expect(canonicalOutpoint(bad)).toBeNull();
  });

  test('agrees with the SDK on what it accepts, and on the coin it means', () => {
    for (const op of [`${T}.5`, `${T.toUpperCase()}.5`, `aB${T.slice(2)}.5`, `${T}.4294967295`]) {
      const { txid, vout } = parseWalletOutpoint(op);
      expect(canonicalOutpoint(op)).toBe(`${txid}.${vout}`);
    }
    for (const op of [` ${T}.0`, `${T}.00`, `${T}.4294967296`, `${T}.1e0`, `${T}:0`]) {
      expect(canonicalOutpoint(op)).toBeNull();
      expect(() => parseWalletOutpoint(op)).toThrow();
    }
  });
});

describe('canonicalInputs', () => {
  test('nothing named is undefined; an empty list stays empty', () => {
    expect(canonicalInputs(undefined)).toBeUndefined();
    expect(canonicalInputs(null)).toBeUndefined();
    expect(canonicalInputs([])).toEqual([]);
  });

  test('copies with canonical outpoints, other fields kept, original untouched', () => {
    const input = { outpoint: `${T.toUpperCase()}_1`, inputDescription: 'x' };
    const out = canonicalInputs<typeof input>([input]);
    expect(out).toEqual([{ outpoint: `${T}.1`, inputDescription: 'x' }]);
    expect(out?.[0]).not.toBe(input);
    expect(input.outpoint).toBe(`${T.toUpperCase()}_1`);
  });

  test('reads each outpoint once, and passes on the value it read', () => {
    let reads = 0;
    const flipping = {
      get outpoint() {
        return reads++ === 0 ? `${T}.0` : `${'cd'.repeat(32)}.0`;
      },
    };
    expect(canonicalInputs([flipping])?.[0].outpoint).toBe(`${T}.0`);
  });

  test('refuses anything unreadable', () => {
    for (const bad of ['x', 1, {}, { length: 1 }, [null], ['x'], [{}], [{ outpoint: 'nope' }]])
      expect(() => canonicalInputs(bad)).toThrow(BAD_OUTPOINT_REFUSAL);
  });
});
