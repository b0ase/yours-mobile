import { useEffect, useState } from 'react';
import { AtSign, BadgeCheck } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { listPaymails, unlinkPaymail, type WalletName } from '../names/paymail';
import { setPaymail } from '../names/accountName';
import { ErrorActions } from '../errors/ErrorActions';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Settings › Identity: every name that receives for this wallet (owner, 4 Oct 2026: a wallet may
 * have more than one, "but NOT invisibly"). The main one is its identity, token and room.
 */
export const WalletNames = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [names, setNames] = useState<WalletName[] | null>(null);
  const [asking, setAsking] = useState(''); // paymail awaiting a second tap
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const unlink = async (pm: string) => {
    setBusy(pm);
    setError('');
    try {
      await unlinkPaymail(f, apiContext.wallet, pm);
      const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
      const next = (await listPaymails(f, publicKey)).find((n) => n.main)?.paymail;
      if (identityAddress) setPaymail(identityAddress, next ?? '');
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlink');
    } finally {
      setBusy('');
      setAsking('');
    }
  };
  useEffect(() => {
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => listPaymails(f, publicKey))
      .then((n) => live && setNames(n))
      .catch(() => live && setNames([]));
    return () => {
      live = false;
    };
  }, [apiContext.wallet, tick]);
  if (!names?.length) return null;
  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid #ffffff10' }}>
      <p className="text-xs m-0 mb-2" style={{ color: '#98A2B3' }}>
        {names.length > 1 ? `This wallet receives at ${names.length} names` : 'This wallet receives at'}
      </p>
      {names.map((n) => (
        <div key={n.paymail} className="flex items-center gap-2 py-1 text-sm text-white">
          {n.kind === 'plain' ? <AtSign size={14} color="#98A2B3" /> : <BadgeCheck size={14} color="#F5B800" />}
          <span className="truncate">{n.paymail}</span>
          {n.main && (
            <span
              className="text-[10px] font-bold rounded px-1.5 py-0.5"
              style={{ background: '#F5B80022', color: '#F5B800' }}
            >
              MAIN
            </span>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={() => (asking === n.paymail ? void unlink(n.paymail) : setAsking(n.paymail))}
            className="ml-auto text-xs bg-transparent border-0 p-0 shrink-0"
            style={{ color: asking === n.paymail ? '#FDA29B' : '#98A2B3' }}
          >
            {busy === n.paymail ? 'Unlinking…' : asking === n.paymail ? 'Tap again to unlink' : 'Unlink'}
          </button>
        </div>
      ))}
      {asking && (
        <p className="text-[11px] m-0 mt-1" style={{ color: '#98A2B3' }}>
          {asking} will stop receiving and anyone can claim it.
          {names.find((n) => n.paymail === asking)?.main ? ' Your next name becomes the main one.' : ''} Tokens you
          already made are not affected.
        </p>
      )}
      {error && (
<div className="flex flex-col gap-1.5"><p className="text-[11px] m-0 mt-1" style={{ color: '#FDA29B' }}>
          {error}
        </p><ErrorActions message={String(error)} /></div>
)}
    </div>
  );
};
