import { describe, expect, test } from 'bun:test';
import {
  collisionLabel,
  deployDateLabel,
  groupByTicker,
  isHttpsUrl,
  parseTokenId,
  shortTokenId,
  tokenOutsideLinks,
} from './tokenIdentity';

// Real $SCAM deploys (GorillaPool, 15 Oct 2026).
const ORIGINAL = '8353949b27e8e16025702ce2b5d9b1ac2dad56d725eb2a38761974a857d98804_0';
const COPY_A = 'e328a26b9be05d57e60c31021dedbce4e19d0fd1d46441e03c0cce995eb34e20_1';
const COPY_B = '43ee17f8293476aaab406c80c6c32fe27194a3c528cf24277d337bdad11897bb_0';

describe('token id formatting', () => {
  test('parses txid_vout and txid.vout, lowercases', () => {
    expect(parseTokenId(ORIGINAL)).toEqual({ id: ORIGINAL, txid: ORIGINAL.slice(0, 64), vout: 0 });
    expect(parseTokenId(COPY_A.toUpperCase().replace('_', '.'))?.id).toBe(COPY_A);
    expect(parseTokenId('SCAM')).toBeNull();
    expect(parseTokenId('')).toBeNull();
  });
  test('short form keeps the head, tail and vout', () => {
    expect(shortTokenId(ORIGINAL)).toBe('8353949b…8804_0');
    expect(shortTokenId(COPY_A)).toBe('e328a26b…4e20_1');
    expect(shortTokenId('not-an-id')).toBe('not-an-id');
  });
  test('outside links are https and use the id / deploy txid', () => {
    const l = tokenOutsideLinks(ORIGINAL)!;
    expect(l.market).toBe(`https://1sat.market/market/bsv21/${ORIGINAL}`);
    expect(l.deployTx).toBe(`https://whatsonchain.com/tx/${ORIGINAL.slice(0, 64)}`);
    expect(isHttpsUrl(l.market) && isHttpsUrl(l.deployTx)).toBe(true);
    expect(isHttpsUrl('http://1sat.market')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(tokenOutsideLinks('SCAM')).toBeNull();
  });
  test('deploy date is UTC', () => {
    expect(deployDateLabel(1710201940)).toBe('12 Mar 2024');
    expect(deployDateLabel(null)).toBeNull();
  });
});

describe('ticker collisions', () => {
  test('groups case-insensitively, never merges ids, most holders first', () => {
    const g = groupByTicker([
      { id: COPY_A, ticker: 'SCAM', holders: 1, height: 950422 },
      { id: ORIGINAL, ticker: '$scam', holders: 49, height: 835314 },
      { id: COPY_B, ticker: 'Scam', holders: 1, height: 951097 },
      { id: 'a'.repeat(64) + '_0', ticker: 'OTHER', holders: 3, height: 1 },
    ]);
    const scam = g.get('SCAM')!;
    expect(scam.map((t) => t.id)).toEqual([ORIGINAL, COPY_A, COPY_B]);
    expect(g.get('OTHER')!.length).toBe(1);
    expect(collisionLabel('scam', scam.length)).toBe('3 tokens use $SCAM');
    expect(collisionLabel('OTHER', 1)).toBeNull();
  });
  test('same id twice (two indexers, either spelling) counts once and keeps known holders', () => {
    const g = groupByTicker([
      { id: ORIGINAL, ticker: 'SCAM', holders: null, height: null },
      { id: ORIGINAL.replace('_', '.').toUpperCase(), ticker: 'SCAM', holders: 49, height: 835314 },
    ]);
    expect(g.get('SCAM')).toEqual([{ id: ORIGINAL, ticker: 'SCAM', holders: 49, height: 835314 }]);
  });
  test('skips rows with no ticker or a bad id', () => {
    const g = groupByTicker([
      { id: 'junk', ticker: 'SCAM' },
      { id: ORIGINAL, ticker: '' },
    ]);
    expect(g.size).toBe(0);
  });
});
