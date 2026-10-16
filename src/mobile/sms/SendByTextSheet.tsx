import { useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { Sheet } from '../phone/Sheet';
import { TEXT_COST_LABEL } from './phoneApi';
import { usePhoneApi, usePhoneAvailable } from './usePhone';
import { SentTexts } from './SentTexts';
import { MIN_DROP_SATS, SEND_BY_TEXT_ENABLED, sendByText } from './sendByText';

/** Send › "Send by text". Renders nothing unless the flag is on AND bit-sign has SMS enabled. */
export const SendByTextSheet = ({ ctx, onClose }: { ctx: OneSatContext; onClose: () => void }) => {
  const api = usePhoneApi();
  const [state] = usePhoneAvailable(api);
  const [to, setTo] = useState('');
  const [sats, setSats] = useState(String(MIN_DROP_SATS * 10));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  if (!SEND_BY_TEXT_ENABLED || !state) return null;

  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendByText(ctx, api, { to, sats: Number(sats) });
      setSentCount((n) => n + 1);
      setMsg(`Sent to ${r.to}. If it is not claimed in 14 days you can take it back.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const input = 'w-full rounded-xl bg-[var(--bw-bg)] px-3 py-2.5 text-white text-sm border border-[#2b2f36]';
  return (
    <Sheet label="Send by text" onClose={onClose}>
      <p className="text-base font-bold text-white">Send by text</p>
      <input
        className={input}
        inputMode="tel"
        placeholder="+44 7700 900123"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        className={input}
        inputMode="numeric"
        placeholder="sats"
        value={sats}
        onChange={(e) => setSats(e.target.value.replace(/\D/g, ''))}
      />
      <p className="text-[11px] text-[#98A2B3]">
        They get a link to claim it into bWalletX. Text cost {TEXT_COST_LABEL}, paid by bWalletX. Unclaimed after 14
        days? You can take it back.
      </p>
      <button
        disabled={busy}
        onClick={() => void send()}
        className="py-3 rounded-2xl font-semibold text-sm border-0"
        style={{ background: 'linear-gradient(135deg, var(--bw-accent-hi), var(--bw-accent))', color: '#010101' }}
      >
        Send
      </button>
      {msg && <p className="text-[12px] text-[#98A2B3]">{msg}</p>}
      <SentTexts ctx={ctx} api={api} refresh={sentCount} />
      <button onClick={onClose} className="py-2 text-sm text-[#98A2B3] bg-transparent border-0">
        Cancel
      </button>
    </Sheet>
  );
};
