import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listOpns } from '@1sat/actions';
import { AtSign, Check, Copy } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getPaymail, ownedFromOutputs, type OwnedName } from '../names/accountName';
import { listPaymails, type WalletName } from '../names/paymail';
import { ownedForSale, type OwnedForSale } from '../names/opnsSell';
import { OpnsSellSection } from '../names/OpnsSellSection';
import { OpnsGiftSection } from '../names/OpnsGiftSection';
import { MARKET_ENABLED } from '../storeBuild';
import { useBsvUsd } from '../money/money';
import { useOpnsVault } from '../names/useOpnsVault';
import { mergeNames, opnsRows, paymailRows } from './namesList';
import { copyLink } from '../chat/shareLink';
import { BWALLET_PAYMAIL_DOMAIN, SIBLING_PAYMAIL_DOMAINS } from '../names/config';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const HEAD = 'm-0 text-xs font-semibold uppercase tracking-widest';

/**
 * Wallet › Names (owner, 15 Oct 2026: "change Friends for Names"): two sections. Paymail: this wallet's bwalletx.com
 * handle(s), primary marked, each with Copy. OpNS names: the on-chain names it holds with Bound / Not bound, Bind (Settings › Get your name binds it), and Sell / Give (the
 * same sections as bMint › OpNS names: Sell in bWalletX, Give in the store edition). Friends moved to the address
 * book (wallet/AddressBook.tsx).
 */
export const NamesSection = () => {
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const vault = useOpnsVault(identityAddress, account?.pubKeys?.identityPubKey);
  const rate = useBsvUsd();
  const [paymails, setPaymails] = useState<WalletName[]>([]);
  const [bound, setBound] = useState<OwnedName[]>([]);
  const [forSale, setForSale] = useState<OwnedForSale[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!apiContext) return;
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => listPaymails(f, publicKey))
      .then((n) => live && setPaymails(n))
      .catch(() => undefined);
    listOpns
      .execute(apiContext, { includeTags: true, limit: 1000 })
      .then((r) => {
        if (!live) return;
        setBound(ownedFromOutputs(r.outputs));
        setForSale(ownedForSale(r.outputs));
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [apiContext, tick]);

  const handles = paymailRows(paymails, getPaymail(identityAddress), {
    primary: BWALLET_PAYMAIL_DOMAIN,
    siblings: SIBLING_PAYMAIL_DOMAINS,
  });
  const names = opnsRows(mergeNames(bound, forSale));
  const empty = loaded && !handles.length && !names.length;
  const copy = (pm: string) =>
    void copyLink(pm).then((r) => {
      if (r !== 'copied') return;
      setCopied(pm);
      window.setTimeout(() => setCopied((c) => (c === pm ? '' : c)), 1500);
    });

  // w-full + shrink-0 like the Tokens section (owner, 15 Oct 2026: the Names list didn't scroll with the page).
  return (
    <div className="w-full shrink-0 px-4 flex flex-col gap-3 pb-6">
      {handles.length > 0 && (
        <section aria-labelledby="names-paymail" className="flex flex-col gap-2">
          <h2 id="names-paymail" className={HEAD} style={{ color: 'var(--bw-muted)' }}>
            Paymail
          </h2>
          {handles.map((h) => (
            <div
              key={h.paymail}
              className="flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-bold"
              style={{
                background: 'var(--bw-surface)',
                color: 'var(--bw-text)',
                border: '1px solid rgb(var(--bw-accent-rgb)/0.27)',
              }}
            >
              <AtSign size={14} color="var(--bw-accent)" aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">{h.paymail}</span>
              {h.main && (
                <span
                  className="shrink-0 text-[10px] font-bold rounded px-1.5 py-0.5"
                  style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
                >
                  Primary
                </span>
              )}
              <button
                type="button"
                onClick={() => copy(h.paymail)}
                aria-label={`Copy ${h.paymail}`}
                className="ml-auto shrink-0 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold border-0 cursor-pointer bg-transparent"
                style={{ color: copied === h.paymail ? 'var(--bw-success)' : 'var(--bw-muted)' }}
              >
                {copied === h.paymail ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied === h.paymail ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </section>
      )}
      {empty ? (
        <div className="text-center py-8">
          <p className="text-sm m-0 mb-3" style={{ color: 'var(--bw-muted)' }}>
            No names yet
          </p>
          <button
            type="button"
            onClick={() => navigate('/m/names')}
            className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
            style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
          >
            Get a name
          </button>
        </div>
      ) : (
        <>
          {!loaded && (
            <p className="text-xs m-0 text-center py-4" style={{ color: 'var(--bw-muted)' }}>
              Loading your names…
            </p>
          )}
          {names.length > 0 && (
            <section aria-labelledby="names-opns" className="flex flex-col">
              <h2 id="names-opns" className={HEAD} style={{ color: 'var(--bw-muted)' }}>
                OpNS names
              </h2>
              <ul className="m-0 p-0 list-none">
                {names.map((n) => (
                  <li
                    key={n.id}
                    className="flex items-center justify-between gap-2 py-2"
                    style={{ borderBottom: '1px solid var(--bw-line)' }}
                  >
                    <span className="min-w-0 flex items-center gap-2 text-sm" style={{ color: 'var(--bw-text)' }}>
                      <span className="truncate">{n.name}</span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                        style={
                          n.published
                            ? { background: 'var(--bw-card2)', color: 'var(--bw-success)' }
                            : { background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }
                        }
                      >
                        {n.published ? 'Bound' : 'Not bound'}
                      </span>
                      {n.listedSats != null && (
                        <span className="text-[10px] shrink-0" style={{ color: 'var(--bw-muted)' }}>
                          For sale
                        </span>
                      )}
                    </span>
                    {!n.published && (
                      <button
                        type="button"
                        onClick={() => navigate('/settings')}
                        className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
                        style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
                      >
                        Bind
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {MARKET_ENABLED ? (
            <OpnsSellSection
              vault={vault.state}
              onVault={vault.set}
              ctx={apiContext}
              identityAddress={identityAddress}
              rate={rate}
              owned={forSale}
              onChanged={() => setTick((t) => t + 1)}
            />
          ) : (
            <OpnsGiftSection ctx={apiContext} owned={forSale} onChanged={() => setTick((t) => t + 1)} />
          )}
          <button
            type="button"
            onClick={() => navigate('/m/names')}
            className="self-center rounded-xl px-4 py-2 text-xs font-bold border-0 cursor-pointer bg-transparent"
            style={{ color: 'var(--bw-accent)' }}
          >
            Get another name
          </button>
        </>
      )}
    </div>
  );
};
