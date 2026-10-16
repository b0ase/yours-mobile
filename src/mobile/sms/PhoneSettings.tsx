import { useState } from 'react';
import { normE164 } from './phoneApi';
import { usePhoneApi, usePhoneAvailable } from './usePhone';

/**
 * Settings › Phone: add a number (text code), verify, remove; match contacts by number.
 * Hidden entirely while bit-sign answers 503 sms_disabled (`available() === null`).
 * Contact matching uses the browser Contact Picker where the platform has one; otherwise the
 * button is not shown (no fake list).
 */
type Picker = { select(props: string[], opts: { multiple: boolean }): Promise<{ tel?: string[] }[]> };
const contactPicker = (): Picker | null => {
  const c = (navigator as unknown as { contacts?: Picker }).contacts;
  return c && typeof c.select === 'function' ? c : null;
};

export const PhoneSettings = ({ onBack }: { onBack: () => void }) => {
  const api = usePhoneApi();
  const [state, setState] = usePhoneAvailable(api);
  const [num, setNum] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'enter' | 'code'>('enter');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ e164: string; paymail: string }[] | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const e164 = normE164(num);
      if (!e164) throw new Error('Enter your number with the country code, e.g. +44 7700 900123');
      await api.start(e164);
      setStep('code');
      setMsg('We texted you a 6-digit code. It expires in 10 minutes.');
    });
  const verify = () =>
    run(async () => {
      const phone = await api.verify(code);
      setState({ phone });
      setStep('enter');
      setCode('');
      setNum('');
    });
  const remove = () =>
    run(async () => {
      await api.remove();
      setState({ phone: null });
    });
  const picker = contactPicker();
  const matchContacts = () =>
    run(async () => {
      const picked = await picker!.select(['tel'], { multiple: true });
      setMatches(await api.match(picked.flatMap((p) => p.tel || [])));
    });

  const card = 'rounded-xl bg-[var(--bw-surface)] px-4 py-3';
  const btn = 'rounded-xl py-2.5 px-4 text-sm font-semibold border-0';
  const gold = { background: 'linear-gradient(135deg, var(--bw-accent-hi), var(--bw-accent))', color: '#010101' };
  const input = 'w-full rounded-xl bg-[var(--bw-bg)] px-3 py-2.5 text-white text-sm border border-[#2b2f36]';

  return (
    <div className="w-full px-4 pb-24 flex flex-col gap-3">
      <button onClick={onBack} className="self-start py-2 text-sm text-[#98A2B3] bg-transparent border-0">
        ‹ Settings
      </button>
      <p className="text-lg font-bold text-white">Phone</p>
      {state === null && <p className="text-sm text-[#98A2B3]">Loading…</p>}
      {state === false && (
        <div className={card}>
          <p className="text-sm text-white">Phone numbers are not switched on yet.</p>
          <p className="text-[11px] text-[#98A2B3]">
            Coming: verify your number, send bitcoin by text, find friends by number.
          </p>
        </div>
      )}
      {state && state.phone && (
        <div className={card}>
          <p className="text-sm font-semibold text-white">{state.phone.masked}</p>
          <p className="text-[11px] text-[#98A2B3]">Verified. We keep only a hash and the last 4 digits.</p>
          <button disabled={busy} onClick={remove} className={`${btn} mt-3 bg-transparent text-[#F04438]`}>
            Remove number
          </button>
        </div>
      )}
      {state && !state.phone && step === 'enter' && (
        <div className={`${card} flex flex-col gap-2`}>
          <p className="text-sm text-white">Add your number so friends who have it can pay you.</p>
          <input
            className={input}
            inputMode="tel"
            autoComplete="tel"
            placeholder="+44 7700 900123"
            value={num}
            onChange={(e) => setNum(e.target.value)}
          />
          <button disabled={busy} onClick={start} className={btn} style={gold}>
            Text me a code
          </button>
        </div>
      )}
      {state && !state.phone && step === 'code' && (
        <div className={`${card} flex flex-col gap-2`}>
          <input
            className={input}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button disabled={busy || code.length !== 6} onClick={verify} className={btn} style={gold}>
            Verify
          </button>
          <button disabled={busy} onClick={() => setStep('enter')} className={`${btn} bg-transparent text-[#98A2B3]`}>
            Change number
          </button>
        </div>
      )}
      {state && state.phone && picker && (
        <div className={card}>
          <button disabled={busy} onClick={matchContacts} className={btn} style={gold}>
            Find friends from contacts
          </button>
          {matches && (
            <ul className="mt-2 text-sm text-white">
              {matches.length === 0 && <li className="text-[#98A2B3]">No matches yet.</li>}
              {matches.map((m) => (
                <li key={m.paymail}>{m.paymail}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {msg && <p className="text-[12px] text-[#98A2B3]">{msg}</p>}
    </div>
  );
};
