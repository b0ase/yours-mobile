import { describe, expect, test } from 'bun:test';
import { LockingScript } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';
import { ordLockVersion } from './ordlockVersion';

const ADDR = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';

describe('OrdLock version', () => {
  test('v2 listings are v2; anything else is not buyable', () => {
    const v2 = OrdLockV2.lock(ADDR, ADDR, 1000);
    expect(ordLockVersion(new LockingScript(v2.chunks))).toBe(2);
    expect(ordLockVersion(LockingScript.fromHex('76a91400112233445566778899aabbccddeeff0011223388ac'))).toBe(0);
  });
});
