import { useEffect, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { mayReclaim, type PhoneApi, type TextDrop } from './phoneApi';
import { reclaimDrop } from './sendByText';

const STATUS: Record<TextDrop['status'], string> = {
  sent: 'Waiting',
  claimed: 'Collected',
  reclaimed: 'Taken back',
  failed: 'Text failed',
};

/** Send by text › Sent texts: each drop's state, and "Reclaim" once it may be swept back (expired or failed). */
export const SentTexts = ({ ctx, api, refresh = 0 }: { ctx: OneSatContext; api: PhoneApi; refresh?: number }) => {
  const [drops, setDrops] = useState<TextDrop[] | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .myDrops()
      .then((d) => live && setDrops(d))
      .catch(() => live && setDrops([]));
    return () => void (live = false);
  }, [api, refresh, tick]);

  const reclaim = async (code: string) => {
    setBusy(code);
    setMsg('');
    try {
      await reclaimDrop(ctx, api, code);
      setMsg('Taken back into your wallet.');
      setTick((t) => t + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!drops?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-white">Sent texts</p>
      {drops.map((d) => (
        <div key={d.code} className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-white">
            {d.to || 'Text'} · {d.amount_sats.toLocaleString('en-GB')} sats
          </span>
          {mayReclaim(d) ? (
            <button
              disabled={!!busy}
              onClick={() => void reclaim(d.code)}
              className="px-3 py-1 rounded-full text-[12px] font-semibold border-0 disabled:opacity-50"
              style={{ background: 'var(--bw-accent-hi)', color: '#010101' }}
            >
              {busy === d.code ? 'Reclaiming…' : 'Reclaim'}
            </button>
          ) : (
            <span className="text-[#98A2B3]">{STATUS[d.status]}</span>
          )}
        </div>
      ))}
      {msg && <p className="text-[12px] text-[#98A2B3]">{msg}</p>}
    </div>
  );
};
