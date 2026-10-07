import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { parseUsdInput } from '../money/money';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import { OWN_SERVICE_PAYEES, addSubscription, subProblem, type NewSub, type Period } from './pots';
import { reschedulePotReminders } from './notifyPots';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';
const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border w-full';
const field = { background: '#010101', borderColor: LINE };

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[420] flex items-end" style={{ background: '#000a' }} onClick={onClose}>
      <div
        className="w-full rounded-t-2xl p-4 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        style={{ background: CARD, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Pots › New pot: a name, then Add account makes the pot's own account (fresh keys). */
export const CreatePotSheet = ({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) => {
  const [name, setName] = useState('');
  return (
    <Sheet title="New pot" onClose={onClose}>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        A pot is a separate account with its own keys. Standing orders pay from it, and whatever you put in it is the
        most they can ever take. Pause or empty it any time.
      </p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Rent, bChat)" maxLength={32} className={input} style={field} />
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onCreate(name.trim())}
        className="rounded-xl py-3 font-bold border-0"
        style={{ background: GOLD, color: '#000', opacity: name.trim() ? 1 : 0.5 }}
      >
        Create pot
      </button>
    </Sheet>
  );
};

const PERIODS: [Exclude<Period, object>, string][] = [
  ['week', 'Weekly'],
  ['month', 'Monthly'],
  ['year', 'Yearly'],
  ['day', 'Daily'],
];

const today = () => new Date().toISOString().slice(0, 10);

/** A standing order on a pot: to a person / paymail everywhere, or to one of our services in bWalletX. */
export const AddOrderSheet = ({
  potId,
  potName,
  balanceUsd,
  bsvUsd,
  onClose,
}: {
  potId: string;
  potName: string;
  balanceUsd: number | null;
  bsvUsd: number;
  onClose: () => void;
}) => {
  const [service, setService] = useState('');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [usd, setUsd] = useState('');
  const [period, setPeriod] = useState<Exclude<Period, object>>('month');
  const [start, setStart] = useState(today());
  const [max, setMax] = useState('');
  const [error, setError] = useState('');

  const svc = OWN_SERVICE_PAYEES.find((p) => p.service === service);
  const recipient = to.trim();
  const payee = svc
    ? { name: svc.name, service: svc.service }
    : {
        name: label.trim() || recipient,
        ...(recipient.includes('@') || recipient.startsWith('$') ? { paymail: recipient } : { address: recipient }),
      };
  const amount = parseUsdInput(usd);
  const startAt = Date.parse(`${start}T12:00:00Z`);
  const n: NewSub = {
    potId,
    payee,
    amount: { value: amount ?? 0, currency: 'USD' },
    period,
    start: startAt,
    maxCount: max.trim() ? Number(max) : null,
  };

  const save = () => {
    const p = subProblem(n);
    if (p) return setError(p);
    try {
      addSubscription(n, bsvUsd);
      void reschedulePotReminders();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet title={`Standing order from ${potName}`} onClose={onClose}>
      {SUBSCRIPTIONS_ENABLED && OWN_SERVICE_PAYEES.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {[{ service: '', name: 'A person' }, ...OWN_SERVICE_PAYEES].map((p) => (
            <button
              key={p.service || 'person'}
              type="button"
              onClick={() => setService(p.service)}
              className="rounded-full px-3 py-1.5 text-xs font-bold border-0"
              style={{ background: service === p.service ? GOLD : LINE, color: service === p.service ? '#000' : '#fff' }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {!svc && (
        <>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Paymail or address" className={input} style={field} autoCapitalize="off" autoCorrect="off" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" maxLength={32} className={input} style={field} />
        </>
      )}
      <input value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="Amount in $" inputMode="decimal" className={input} style={field} />
      <div className="flex gap-2 flex-wrap">
        {PERIODS.map(([p, l]) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className="rounded-full px-3 py-1.5 text-xs font-bold border-0"
            style={{ background: period === p ? GOLD : LINE, color: period === p ? '#000' : '#fff' }}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
        First payment
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={input} style={field} />
      </label>
      <input value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} placeholder="Number of payments (blank = until stopped)" inputMode="numeric" className={input} style={field} />
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Paid when you open the app on or after each date. At most{' '}
        {balanceUsd !== null ? `$${balanceUsd.toFixed(2)}` : 'the pot balance'} can ever be taken: the pot balance.
        Pause or cancel any time.
      </p>
      {error && (
        <div className="text-xs" style={{ color: '#FDA29B' }}>
          {error}
        </div>
      )}
      <button type="button" onClick={save} className="rounded-xl py-3 font-bold border-0" style={{ background: GOLD, color: '#000' }}>
        Set up
      </button>
    </Sheet>
  );
};
