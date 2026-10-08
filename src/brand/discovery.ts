import type { WalletInterface } from '@bsv/sdk';

/**
 * BRC-100 wallet discovery (tokenblaster.lol docs/wallet-connect.md §3), modelled on EIP-6963.
 * A site dispatches `brc100:requestWallet`; every wallet answers with `brc100:announceWallet`
 * carrying its own name, icon and rdns, so the site can list all of them instead of guessing
 * which one sits on window.CWI.
 */
export const REQUEST_WALLET = 'brc100:requestWallet';
export const ANNOUNCE_WALLET = 'brc100:announceWallet';

export type WalletKind = 'extension' | 'in-app' | 'web';

export type WalletInfo = {
  /** Random per page load: the site's dedupe key. */
  uuid: string;
  name: string;
  /** Square data URI, at least 96×96. */
  icon: string;
  /** Stable reverse-DNS id of a domain we own; sites remember the user's choice by it. */
  rdns: string;
  kind: WalletKind;
};

export type WalletAnnouncement = { info: WalletInfo; wallet: WalletInterface };

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/** Announce now and in reply to every request. Returns a function that stops announcing. */
export function announceWallet(
  info: Omit<WalletInfo, 'uuid'>,
  wallet: WalletInterface,
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'> = window,
): () => void {
  const detail: WalletAnnouncement = Object.freeze({ info: Object.freeze({ ...info, uuid: uuid() }), wallet });
  const announce = () => target.dispatchEvent(new CustomEvent(ANNOUNCE_WALLET, { detail }));
  target.addEventListener(REQUEST_WALLET, announce);
  announce();
  return () => target.removeEventListener(REQUEST_WALLET, announce);
}

type CwiWindow = { CWI?: WalletInterface };

/** Set window.CWI only if no other wallet has (spec §3.2). True if this wallet now holds it. */
export function claimWindowCwi(wallet: WalletInterface, w: CwiWindow = window as unknown as CwiWindow): boolean {
  if (!w.CWI) w.CWI = wallet;
  return w.CWI === wallet;
}

/**
 * A wallet whose window.CWI another wallet took over. It hasn't announced itself (it would be
 * listed under its own name if it had), so it gets a neutral name: discovery must not call it to
 * find one, since some wallets prompt on any call from a new site.
 */
export const DISPLACED_INFO: Omit<WalletInfo, 'uuid'> = {
  name: 'Browser wallet',
  icon: '',
  rdns: 'legacy.window-cwi',
  kind: 'extension',
};

/**
 * Keeps the wallet bWalletX displaced from window.CWI visible to choosers: announces whichever
 * wallet it is passed, replacing the previous one. Pass undefined to stop.
 */
export function displacedAnnouncer(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'> = window,
): (wallet: WalletInterface | undefined) => void {
  let current: WalletInterface | undefined;
  let stop: (() => void) | undefined;
  return (wallet) => {
    if (wallet === current) return;
    stop?.();
    current = wallet;
    stop = wallet ? announceWallet(DISPLACED_INFO, wallet, target) : undefined;
  };
}
