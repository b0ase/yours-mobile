import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listOpns } from '@1sat/actions';
import { AtSign } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getPaymail, ownedFromOutputs, type OwnedName } from '../names/accountName';
import { listPaymails, type WalletName } from '../names/paymail';
import { ownedForSale, type OwnedForSale } from '../names/opnsSell';
import { OpnsSellSection } from '../names/OpnsSellSection';
import { OpnsGiftSection } from '../names/OpnsGiftSection';
import { MARKET_ENABLED } from '../storeBuild';
import { useBsvUsd } from '../money/money';
import { useOpnsVault } from '../names/useOpnsVault';
import { mergeNames } from './namesList';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const MUTED = '#98A2B3';

/**
 * Wallet › Names (owner, 15 Oct 2026: "change Friends for Names"): this wallet's $handle paymail(s) at the top, then
 * the OpNS names it holds with Bound / Not bound, Bind (Settings › Get your name binds it), and Sell / Give (the
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

  const handles = paymails.length
    ? paymails.map((p) => p.paymail)
    : getPaymail(identityAddress)
      ? [getPaymail(identityAddress)]
      : [];
  const names = mergeNames(bound, forSale);
  const empty = loaded && !handles.length && !names.length;

  return (
    <div className="w-[92%] mx-auto flex flex-col gap-3 pb-6">
      {handles.map((pm) => (
        <div
          key={pm}
          className="flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-bold text-white"
          style={{ background: 'var(--bw-surface)', border: '1px solid rgb(var(--bw-accent-rgb)/0.27)' }}
        >
          <AtSign size={14} color="var(--bw-accent)" aria-hidden="true" />
          <span className="min-w-0 truncate">{pm}</span>
        </div>
      ))}
      {empty ? (
        <div className="text-center py-8">
          <p className="text-sm m-0 mb-3" style={{ color: MUTED }}>
            No names yet
          </p>
          <button
            type="button"
            onClick={() => navigate('/m/names')}
            className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
            style={{ background: 'var(--bw-accent)', color: '#000' }}
          >
            Get a name
          </button>
        </div>
      ) : (
        <>
          {!loaded && (
            <p className="text-xs m-0 text-center py-4" style={{ color: MUTED }}>
              Loading your names…
            </p>
          )}
          {names.length > 0 && (
            <ul className="m-0 p-0 list-none">
              {names.map((n) => (
                <li
                  key={n.id}
                  className="flex items-center justify-between gap-2 py-2"
                  style={{ borderBottom: '1px solid #ffffff10' }}
                >
                  <span className="min-w-0 flex items-center gap-2 text-sm text-white">
                    <span className="truncate">{n.name}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                      style={
                        n.published
                          ? { background: '#123d24', color: '#2ecc71' }
                          : { background: '#3a2f0c', color: 'var(--bw-accent)' }
                      }
                    >
                      {n.published ? 'Bound' : 'Not bound'}
                    </span>
                    {n.listedSats != null && (
                      <span className="text-[10px] shrink-0" style={{ color: MUTED }}>
                        For sale
                      </span>
                    )}
                  </span>
                  {!n.published && (
                    <button
                      type="button"
                      onClick={() => navigate('/settings')}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
                      style={{ background: 'var(--bw-accent)', color: '#000' }}
                    >
                      Bind
                    </button>
                  )}
                </li>
              ))}
            </ul>
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
