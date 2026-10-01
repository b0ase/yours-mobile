import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getMyName } from './myName';
import { getCachedProfileName, getPaymail, onAccountNamesChange, payableLabel, syncAccountNames } from './accountName';

export type AccountNames = {
  /** BAP profile name, else the account's name. */
  displayName: string;
  /** OpNS name in use (owned / bound), or ''. */
  handle: string;
  /** bWallet paymail, or '' (always '' when paymail is unconfigured). */
  paymail: string;
  /** "Testytester · testytester@domain" (or just the display name). */
  label: string;
};

/** Names for an account from the cache (no network). Also used for the drawer rows of other accounts. */
export const accountNamesFor = (identityAddress?: string, accountName = '', profileName = ''): AccountNames => {
  const displayName = getCachedProfileName(identityAddress) || profileName || accountName;
  const handle = getMyName(identityAddress);
  const paymail = getPaymail(identityAddress);
  return { displayName, handle, paymail, label: payableLabel(displayName, handle, paymail) };
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

/** Back-compat: just the OpNS handle. */
export const useMyName = (identityAddress?: string) => useAccountNames(identityAddress, '', '', false).handle;

/** Receive screen: "Testytester · send to testytester@domain" (build-time insert into BsvWallet.tsx). */
export const ReceiveName = ({ identityAddress }: { identityAddress?: string }) => {
  const { displayName, handle, paymail } = useAccountNames(identityAddress, '', '', false);
  const payable = [paymail, handle].filter(Boolean);
  if (!payable.length) return null;
  return (
    <p className="text-xs text-center w-full" style={{ color: '#9aa0a6' }}>
      {displayName && displayName.toLowerCase() !== payable[0].toLowerCase() ? `${displayName} · ` : ''}Or send to{' '}
      {payable.map((p, i) => (
        <span key={p}>
          {i > 0 ? ' or ' : ''}
          <span style={{ color: '#FFD24D', fontWeight: 600 }}>{p}</span>
        </span>
      ))}
    </p>
  );
};
