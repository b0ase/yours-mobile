import { describe, expect, test } from 'bun:test';
import { Script } from '@bsv/sdk';
import {
  burnAvailability,
  burnConfirmEnabled,
  burnScriptHex,
  copiesOf,
  isLastCopy,
  isListed,
  isUnspendable,
  shortOutpoint,
} from './nftBurn';

const item = (outpoint: string, origin: string, name = 'VexVoid Clip 981923FA', tags: string[] = []) => ({
  output: { outpoint, tags },
  origin,
  name,
  type: 'video/mp4',
});
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('burn script', () => {
  test('is OP_FALSE OP_RETURN with the 1Sat MAP burn', () => {
    const hex = burnScriptHex();
    expect(isUnspendable(hex)).toBe(true);
    // 00 = OP_FALSE, 6a = OP_RETURN, then the MAP protocol prefix.
    expect(hex.slice(0, 4)).toBe('006a');
    expect(Script.fromHex(hex).chunks[1].op).toBe(0x6a);
    const text = Buffer.from(hex, 'hex').toString('latin1');
    for (const w of ['1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'SET', 'app', '1sat', 'type', 'ord', 'op', 'burn'])
      expect(text).toContain(w);
  });
  test('a P2PKH or a bare OP_RETURN-less script is not unspendable', () => {
    expect(isUnspendable('76a914' + '00'.repeat(20) + '88ac')).toBe(false);
    expect(isUnspendable('6a')).toBe(false);
  });
  test('short outpoint', () => {
    expect(shortOutpoint(`${A}.0`)).toBe('aaaaaaaa…aaaaaa_0');
    expect(shortOutpoint(`${A}_3`)).toBe('aaaaaaaa…aaaaaa_3');
  });
});

describe('last-copy detection', () => {
  test('same origin is a copy', () => {
    const x = item(`${A}.0`, `${C}_0`, 'one');
    const y = item(`${B}.0`, `${C}.0`, 'two');
    expect(copiesOf(x, [x, y])).toEqual([y]);
    expect(isLastCopy(x, [x, y])).toBe(false);
  });
  test('re-mint of the same file (same title + type) is a copy', () => {
    const x = item(`${A}.0`, `${A}_0`);
    const y = item(`${B}.0`, `${B}_0`);
    expect(isLastCopy(x, [x, y])).toBe(false);
  });
  test('same content hash is a copy', () => {
    const x = item(`${A}.0`, `${A}_0`, 'x', ['sha256:ABC']);
    const y = item(`${B}.0`, `${B}_0`, 'y', ['sha256:abc']);
    expect(isLastCopy(x, [x, y])).toBe(false);
  });
  test('only copy', () => {
    const x = item(`${A}.0`, `${A}_0`, 'Four Ton Shadow');
    const y = item(`${B}.0`, `${B}_0`, 'Something else');
    expect(isLastCopy(x, [x, y])).toBe(true);
    expect(isLastCopy(x, [x])).toBe(true);
  });
  test('generic "Inscription" names never count as the same file', () => {
    const x = item(`${A}.0`, `${A}_0`, 'Inscription');
    const y = item(`${B}.0`, `${B}_0`, 'Inscription');
    expect(isLastCopy(x, [x, y])).toBe(true);
  });
});

describe('burn availability', () => {
  test('unbroadcast NFTs are not burnable and say why', () => {
    const r = burnAvailability({ onChain: false, listed: false, locked: false });
    expect(r.show).toBe(false);
    expect(r.reason).toContain('never reached the network');
  });
  test('unknown on-chain status hides Burn', () => {
    expect(burnAvailability({ onChain: null, listed: false, locked: false }).show).toBe(false);
  });
  test('listed or locked are refused', () => {
    expect(burnAvailability({ onChain: true, listed: true, locked: false }).show).toBe(false);
    expect(burnAvailability({ onChain: true, listed: false, locked: true }).show).toBe(false);
    expect(isListed({ tags: ['ordlock2'] })).toBe(true);
  });
  test('on chain and free: shown', () => {
    expect(burnAvailability({ onChain: true, listed: false, locked: false })).toEqual({ show: true });
  });
});

describe('confirm gating', () => {
  const base = { typed: '', held: false, busy: false, done: false };
  test('needs BURN or a hold', () => {
    expect(burnConfirmEnabled(base)).toBe(false);
    expect(burnConfirmEnabled({ ...base, typed: 'BUR' })).toBe(false);
    expect(burnConfirmEnabled({ ...base, typed: 'burn ' })).toBe(true);
    expect(burnConfirmEnabled({ ...base, held: true })).toBe(true);
  });
  test('never while busy or after success', () => {
    expect(burnConfirmEnabled({ ...base, typed: 'BURN', busy: true })).toBe(false);
    expect(burnConfirmEnabled({ ...base, typed: 'BURN', done: true })).toBe(false);
  });
});
