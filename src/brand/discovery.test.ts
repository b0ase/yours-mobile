import { describe, expect, test } from 'bun:test';
import type { WalletInterface } from '@bsv/sdk';
import { ANNOUNCE_WALLET, REQUEST_WALLET, announceWallet, claimWindowCwi, type WalletAnnouncement } from './discovery';

const wallet = {} as WalletInterface;
const info = {
  name: 'bWalletX',
  icon: 'data:image/png;base64,AA',
  rdns: 'com.bwalletx.extension',
  kind: 'extension' as const,
};

describe('wallet discovery', () => {
  test('announces on load and on every request, with a frozen detail', () => {
    const target = new EventTarget();
    const seen: WalletAnnouncement[] = [];
    target.addEventListener(ANNOUNCE_WALLET, (e) => seen.push((e as CustomEvent<WalletAnnouncement>).detail));
    const stop = announceWallet(info, wallet, target as unknown as Window);
    target.dispatchEvent(new Event(REQUEST_WALLET));
    expect(seen).toHaveLength(2);
    expect(seen[0].info.rdns).toBe('com.bwalletx.extension');
    expect(seen[0].info.uuid).toBe(seen[1].info.uuid);
    expect(Object.isFrozen(seen[0].info)).toBe(true);
    expect(seen[0].wallet).toBe(wallet);
    stop();
    target.dispatchEvent(new Event(REQUEST_WALLET));
    expect(seen).toHaveLength(2);
  });

  test('claims window.CWI only when empty', () => {
    const other = {} as WalletInterface;
    const w: { CWI?: WalletInterface } = {};
    expect(claimWindowCwi(wallet, w)).toBe(true);
    expect(w.CWI).toBe(wallet);
    const taken: { CWI?: WalletInterface } = { CWI: other };
    expect(claimWindowCwi(wallet, taken)).toBe(false);
    expect(taken.CWI).toBe(other);
  });
});
