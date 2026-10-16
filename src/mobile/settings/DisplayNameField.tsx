import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getPaymail } from '../names/accountName';
import {
  DISPLAY_NAME_MAX,
  cleanDisplayName,
  defaultDisplayName,
  fetchDisplayName,
  setDisplayName,
} from '../names/paymail';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Settings › Identity › Your name (owner, 15 Oct 2026): the name people see when they pay your
 * paymail ("Mike Smith" for a1autos@bwalletx.com). One name for every paymail on this wallet.
 */
export const DisplayNameField = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const paymail = getPaymail(identityAddress) ?? '';
  const [saved, setSaved] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    void fetchDisplayName(f, paymail).then((n) => {
      if (!live) return;
      const name = n || defaultDisplayName(paymail);
      setSaved(name);
      setValue(name);
    });
    return () => {
      live = false;
    };
  }, [paymail]);
  if (!paymail) return null;
  const clean = cleanDisplayName(value);
  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const name = await setDisplayName(f, apiContext.wallet, value);
      setSaved(name);
      setValue(name);
      setMsg('Saved. People paying you see this name.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid #ffffff10' }}>
      <label htmlFor="bw-display-name" className="text-xs block mb-2" style={{ color: '#98A2B3' }}>
        Your name (shown to people who pay {paymail})
      </label>
      <div className="flex items-center gap-2">
        <input
          id="bw-display-name"
          value={value}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setValue(e.target.value)}
          placeholder={defaultDisplayName(paymail)}
          className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm text-white border-0 outline-none"
          style={{ background: '#ffffff10' }}
        />
        <button
          type="button"
          disabled={busy || !clean || clean === saved}
          onClick={() => void save()}
          className="text-xs font-bold rounded-lg px-3 py-2 border-0 shrink-0 disabled:opacity-40"
          style={{ background: 'var(--bw-accent)', color: '#000' }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {value.trim() && clean !== value.trim() && (
        <p className="text-[11px] m-0 mt-1" style={{ color: '#98A2B3' }}>
          {clean ? `Will show as "${clean}"` : 'Use a real name, not a paymail or a badge'}
        </p>
      )}
      {msg && (
        <p className="text-[11px] m-0 mt-1" style={{ color: '#98A2B3' }}>
          {msg}
        </p>
      )}
    </div>
  );
};
