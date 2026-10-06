import { useEffect, useState } from 'react';
import { bareName } from './names';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getMyName } from './myName';
import { isPlaceholderName } from './handlePrompt';
import { getCachedProfileName, getPaymail, onAccountNamesChange, payableLabel, syncAccountNames } from './accountName';

export type AccountNames = {
  /** BAP profile name, else the account's name. */
  displayName: string;
  /** OpNS name in use (owned / bound), or ''. */
  handle: string;
  /** bWallet paymail in full (name@bwallet.space), or '' (always '' when paymail is unconfigured). */
  paymail: string;
  /** How bWallet shows the payable name: the paymail without our domain, else the OpNS handle. */
  payable: string;
  /** "Testytester · testytester" (or just the display name). */
  label: string;
};

/** Names for an account from the cache (no network). Also used for the drawer rows of other accounts. */
export const accountNamesFor = (identityAddress?: string, accountName = '', profileName = ''): AccountNames => {
  const handle = getMyName(identityAddress);
  const paymail = getPaymail(identityAddress);
  const short = bareName(paymail);
  // A placeholder ("Anonymous", "Account 1") is never shown as the name: the paymail name wins over it.
  const displayName =
    [getCachedProfileName(identityAddress), profileName, accountName].find((n) => n && !isPlaceholderName(n)) ||
    short ||
    handle ||
    accountName;
  return { displayName, handle, paymail, payable: short || handle, label: payableLabel(displayName, handle, short) };
};

/**
 * Names for the current account. Paints from the cache, then (when `sync`) refreshes from the
 * chain: BAP profile, the opns basket, and the paymail server (which also collects paymail payments).
 */
export const useAccountNames = (identityAddress?: string, accountName = '', profileName = '', sync = true) => {
  const { apiContext } = useServiceContext();
  const [names, setNames] = useState(() => accountNamesFor(identityAddress, accountName, profileName));
  useEffect(() => {
    const update = () => setNames(accountNamesFor(identityAddress, accountName, profileName));
    update();
    return onAccountNamesChange(update);
  }, [identityAddress, accountName, profileName]);
  useEffect(() => {
    if (!sync || !apiContext || !identityAddress) return;
    const run = () => syncAccountNames(apiContext, identityAddress).catch(() => undefined);
    run();
    const t = setInterval(run, 150_000);
    return () => clearInterval(t);
  }, [apiContext, identityAddress, sync]);
  return names;
};
