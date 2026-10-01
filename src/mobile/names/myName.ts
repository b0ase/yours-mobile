/** The account's chosen display name ($handle, paymail or OpNS name), per identity address. */
const key = (identityAddress: string) => `bwallet.name.${identityAddress}`;
const EVENT = 'bwallet-name-changed';

export const getMyName = (identityAddress?: string): string => {
  if (!identityAddress) return '';
  try {
    return localStorage.getItem(key(identityAddress)) ?? '';
  } catch {
    return '';
  }
};

export const setMyName = (identityAddress: string, name: string) => {
  try {
    if (name) localStorage.setItem(key(identityAddress), name);
    else localStorage.removeItem(key(identityAddress));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
};

export const onMyNameChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};
