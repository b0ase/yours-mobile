import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
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

/** Back-compat: just the OpNS handle. */
export const useMyName = (identityAddress?: string) => useAccountNames(identityAddress, '', '', false).handle;

/**
 * Receive screen (build-time insert into BsvWallet.tsx). The one place the FULL paymail is shown,
 * because other wallets need the domain: "alice@bwallet.space [copy] · Use the full address in other wallets".
 */
export const ReceiveName = ({ identityAddress }: { identityAddress?: string }) => {
  const { displayName, handle, paymail } = useAccountNames(identityAddress, '', '', false);
  const [copied, setCopied] = useState(false);
  const payable = paymail || handle;
  if (!payable) return null;
  const copy = () =>
    navigator.clipboard
      ?.writeText(payable)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  return (
    <div className="flex flex-col items-center gap-1 w-full text-xs text-center" style={{ color: '#9aa0a6' }}>
      <div className="flex items-center justify-center gap-1.5">
        {displayName && displayName.toLowerCase() !== bareName(payable).toLowerCase() ? `${displayName} · ` : ''}Or send
        to <span style={{ color: '#FFD24D', fontWeight: 600 }}>{payable}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${payable}`}
          className="p-1 bg-transparent border-0 cursor-pointer"
          style={{ color: copied ? '#2ecc71' : '#FFD24D' }}
        >
          <Copy size={13} />
        </button>
      </div>
      {paymail && <span>Use the full address in other wallets</span>}
      {paymail && handle && <span>OpNS name: {handle}</span>}
    </div>
  );
};
