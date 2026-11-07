import { describe, expect, test } from 'bun:test';
import {
  BASE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SLOW_BROADCAST_MS,
  broadcastTimeoutMs,
  sizeAwareBroadcast,
} from './bigBroadcast';

describe('broadcastTimeoutMs', () => {
  test('small txs keep the base timeout', () => {
    expect(broadcastTimeoutMs(0)).toBe(BASE_TIMEOUT_MS);
    expect(broadcastTimeoutMs(NaN)).toBe(BASE_TIMEOUT_MS);
    expect(broadcastTimeoutMs(500)).toBeLessThan(BASE_TIMEOUT_MS + 100);
  });
  test('a 9.8 MB mint gets minutes, capped', () => {
    expect(broadcastTimeoutMs(9_800_000)).toBeGreaterThan(180_000);
    expect(broadcastTimeoutMs(1e9)).toBe(MAX_TIMEOUT_MS);
  });
});

describe('sizeAwareBroadcast', () => {
  test('raises the timeout for the call and restores it after', async () => {
    const seen: number[] = [];
    const services = {
      arcade: { timeout: BASE_TIMEOUT_MS },
      async postBeef() {
        seen.push(this.arcade.timeout);
        return [{ status: 'success' }];
      },
    };
    expect(sizeAwareBroadcast(services, () => undefined)).toBe(true);
    const r = await services.postBeef({ toBinary: () => new Uint8Array(5_000_000) } as never, ['x'] as never);
    expect(r).toEqual([{ status: 'success' }]);
    expect(seen[0]).toBe(broadcastTimeoutMs(5_000_000));
    expect(services.arcade.timeout).toBe(BASE_TIMEOUT_MS);
  });
  test('restores the timeout when the broadcast throws', async () => {
    const services = {
      arcade: { timeout: BASE_TIMEOUT_MS },
      postBeef: async () => {
        throw new Error('boom');
      },
    };
    sizeAwareBroadcast(services, () => undefined);
    await expect(services.postBeef({ toBinary: () => [1, 2, 3] } as never, [] as never)).rejects.toThrow('boom');
    expect(services.arcade.timeout).toBe(BASE_TIMEOUT_MS);
  });
  test('leaves services without an arcade client alone', () => {
    expect(sizeAwareBroadcast({ postBeef: async () => [] })).toBe(false);
    expect(sizeAwareBroadcast(null)).toBe(false);
  });
});

describe("sizeAwareBroadcast: a slow broadcast says how long it took (owner's seal, 7 Nov 2026: 25 s unexplained)", () => {
  const timed = (ms: number, fail = false) => {
    let t = 1_000;
    const lines: string[] = [];
    const services = {
      arcade: { timeout: BASE_TIMEOUT_MS },
      postBeef: async () => {
        t += ms;
        if (fail) throw new Error('no verdict');
        return [{ status: 'success' }];
      },
    };
    sizeAwareBroadcast(services, () => undefined, { now: () => t, slowLog: (m) => void lines.push(m) });
    return { services, lines };
  };
  test('at or over SLOW_BROADCAST_MS: one [payTiming] line with the time, size and txid prefix', async () => {
    const { services, lines } = timed(SLOW_BROADCAST_MS + 1_500);
    await services.postBeef({ toBinary: () => new Uint8Array(400) } as never, ['ab'.repeat(32)] as never);
    expect(lines).toEqual([`[payTiming] broadcast took ${SLOW_BROADCAST_MS + 1_500} ms (400 bytes, abababababab…)`]);
  });
  test('a quick broadcast logs nothing', async () => {
    const { services, lines } = timed(SLOW_BROADCAST_MS - 1);
    await services.postBeef({ toBinary: () => [1] } as never, ['x'] as never);
    expect(lines).toEqual([]);
  });
  test('a slow broadcast that throws is timed too, and still throws', async () => {
    const { services, lines } = timed(SLOW_BROADCAST_MS, true);
    await expect(services.postBeef({ toBinary: () => [1] } as never, [] as never)).rejects.toThrow('no verdict');
    expect(lines[0]).toStartWith(`[payTiming] broadcast took ${SLOW_BROADCAST_MS} ms`);
  });
});
