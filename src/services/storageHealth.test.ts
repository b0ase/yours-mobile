import { describe, expect, test } from 'bun:test';
import { storageLabel, syncHealthLabel } from './storageHealth';

describe('storage label', () => {
  test('remotes but no activeRemote: this device holds the data, 1Sat is the backup', () => {
    const l = storageLabel({ remotes: ['https://wallet.1sat.app'] });
    expect(l.title).toBe('Stored on this device');
    expect(l.detail).toBe('Backed up to 1Sat (wallet.1sat.app)');
    expect(l.warn).toBe(false);
  });
  test('active remote', () => {
    const l = storageLabel({ activeRemote: 'https://wallet.1sat.app', remotes: ['https://wallet.1sat.app'] });
    expect(l.title).toBe('Stored on 1Sat (wallet.1sat.app)');
    expect(l.detail).toBe('No backup copy');
  });
  test('other host + backup', () => {
    const l = storageLabel({ activeRemote: 'https://store.example.com', remotes: ['https://wallet.1sat.app'] });
    expect(l.title).toBe('Stored on store.example.com (store.example.com)');
    expect(l.detail).toBe('Backed up to 1Sat');
  });
  test('nothing configured warns', () => {
    expect(storageLabel(undefined).warn).toBe(true);
    expect(storageLabel({}).title).toBe('Stored on this device only');
  });
});

describe('sync health', () => {
  const now = 1_000_000_000;
  test('never synced', () => expect(syncHealthLabel(undefined, now).text).toBe('Not synced yet on this device'));
  test('synced 2 min ago', () =>
    expect(syncHealthLabel({ status: 'complete', at: now - 120_000 }, now).text).toBe('Synced 2 min ago'));
  test('failure carries the reason for Copy / Ask b', () => {
    const l = syncHealthLabel({ status: 'error', at: now, error: 'Sync request failed: 502' }, now);
    expect(l.failing).toBe(true);
    expect(l.error).toBe('Sync request failed: 502');
    expect(l.text).toContain('Sync failing: Sync request failed: 502');
  });
  test('arriving is not a failure', () => {
    const l = syncHealthLabel({ status: 'arriving', at: now, satoshis: 25 }, now);
    expect(l.failing).toBe(false);
    expect(l.text).toContain('Payment arriving');
  });
});
