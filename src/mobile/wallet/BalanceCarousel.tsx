import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useCountUp } from './live/useCountUp';
import './balanceCards.css';

/**
 * MOCKUP ONLY (branch mock/balance-cards, 14 Oct 2026): the wallet card as an Apple-Wallet-style swipe carousel,
 * one card per balance. The BSV card is the real WalletCard, untouched; every other card is MOCK DATA.
 * Nothing here signs, spends or fetches.
 */
export const MOCK_BALANCE_CARDS = true;

export type MockBalance = {
  id: string;
  name: string;
  issuer: string;
  /** Unit word shown in place of BSV: "credits", "PNEEs", "tokens". */
  unit: string;
  balance: number;
  /** Mock $ value of one unit. */
  usdPer: number;
  colour: string;
  ink: string;
  initial: string;
};

const MOCK: MockBalance[] = [
  {
    id: 'mandala',
    name: '$mandala credits',
    issuer: 'GorillaPool · Mandala · accepts BSV',
    unit: 'credits',
    balance: 1240,
    usdPer: 0.01,
    colour: '#1f6f5c',
    ink: '#e8fff6',
    initial: 'M',
  },
  {
    id: 'pnee',
    name: 'PNEEs',
    issuer: 'bWalletX · penny notes',
    unit: 'PNEEs',
    balance: 386,
    usdPer: 0.01,
    colour: '#ffd24d',
    ink: '#111',
    initial: 'P',
  },
  {
    id: 'bcorp',
    name: '$bcorp',
    issuer: 'The Bitcoin Corporation',
    unit: 'tokens',
    balance: 52000,
    usdPer: 0.0004,
    colour: '#16161a',
    ink: '#ffd24d',
    initial: 'b',
  },
];

const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

const MockCard = ({ c, chip }: { c: MockBalance; chip: string | null }) => {
  const [unit, setUnit] = useState<'own' | 'usd'>('own');
  const count = useCountUp(c.balance, true);
  const big = unit === 'own' ? fmtNum(count.value) : fmtUsd(count.value * c.usdPer);
  const small = unit === 'own' ? fmtUsd(count.value * c.usdPer) : `${fmtNum(count.value)} ${c.unit}`;
  const toggle = () => setUnit((u) => (u === 'own' ? 'usd' : 'own'));
  const ownLabel = c.unit === 'PNEEs' ? 'PNEEs' : c.unit;
  return (
    <div className="bw-bc" style={{ ['--bc-bg' as string]: c.colour, ['--bc-ink' as string]: c.ink }}>
      <div className="bw-bc-top">
        <span className="bw-bc-logo">{c.initial}</span>
        <span className="bw-bc-head">
          <b>{c.name}</b>
          <small>{c.issuer}</small>
        </span>
        <span className="bw-bc-mock">MOCK</span>
      </div>
      <button
        type="button"
        className={`bw-bc-amt${count.dir && count.flashKey ? ` bw-live-flash-${count.dir}` : ''}`}
        key={count.flashKey}
        onClick={toggle}
      >
        {big}
        {unit === 'own' && <span className="bw-bc-unitword"> {c.unit}</span>}
      </button>
      <div className="bw-bc-bottom">
        <span className="bw-bc-sub">{chip ? <span className="bw-bc-chip">{chip}</span> : small}</span>
        <span className="bw-wcard-unit" role="group" aria-label="Balance unit">
          <button type="button" className={unit === 'usd' ? 'is-on' : undefined} onClick={() => setUnit('usd')}>
            $
          </button>
          <button type="button" className={unit === 'own' ? 'is-on' : undefined} onClick={() => setUnit('own')}>
            {ownLabel}
          </button>
        </span>
      </div>
    </div>
  );
};

type Slot = { id: string; hidden: boolean };

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const [cards, setCards] = useState(MOCK);
  const [slots, setSlots] = useState<Slot[]>(() => [
    { id: 'bsv', hidden: false },
    ...MOCK.map((m) => ({ id: m.id, hidden: false })),
  ]);
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [spending, setSpending] = useState<string | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const visible = slots.filter((s) => !s.hidden);

  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);

  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  // Long-press anywhere on the carousel opens the reorder/hide sheet.
  const press = useRef<number | null>(null);
  const startPress = () => {
    press.current = window.setTimeout(() => setSheet(true), 600);
  };
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };

  // Demo: b spends 2 credits per reply every 3 s for ~20 s on $mandala; the card follows the money, then returns.
  const demo = () => {
    if (spending) return;
    const idx = visible.findIndex((s) => s.id === 'mandala');
    if (idx < 0) return;
    const back = active;
    setSpending('mandala');
    setChip('b · 2 credits/reply');
    goTo(idx);
    let n = 0;
    const tick = window.setInterval(() => {
      n += 1;
      setCards((cs) => cs.map((c) => (c.id === 'mandala' ? { ...c, balance: Math.max(0, c.balance - 2) } : c)));
      if (n >= 7) {
        window.clearInterval(tick);
        window.setTimeout(() => {
          setSpending(null);
          setChip(null);
          goTo(back);
        }, 1200);
      }
    }, 3000);
  };

  useEffect(() => () => endPress(), []);

  const move = (id: string, d: -1 | 1) =>
    setSlots((s) => {
      const i = s.findIndex((x) => x.id === id);
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const nameOf = (id: string) => (id === 'bsv' ? 'BSV' : (cards.find((c) => c.id === id)?.name ?? id));

  return (
    <div className="bw-bcar">
      <div
        ref={track}
        className="bw-bcar-track"
        onScroll={onScroll}
        onTouchStart={startPress}
        onTouchEnd={endPress}
        onTouchMove={endPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setSheet(true);
        }}
      >
        {visible.map((s) => (
          <div className="bw-bcar-slide" key={s.id}>
            {s.id === 'bsv' ? (
              bsvCard
            ) : (
              <div className="bw-bcar-mockwrap">
                <MockCard c={cards.find((c) => c.id === s.id)!} chip={spending === s.id ? chip : null} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bw-bcar-dots" aria-label={`Card ${active + 1} of ${visible.length}`}>
        {visible.map((s, i) => (
          <button
            type="button"
            key={s.id}
            aria-label={nameOf(s.id)}
            className={i === active ? 'is-on' : undefined}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
      <div className="bw-bcar-demo">
        <button type="button" onClick={demo} disabled={!!spending}>
          {spending ? 'b is spending…' : 'Demo spend (mock)'}
        </button>
      </div>
      {sheet && (
        <div className="bw-bcar-sheet-bg" onClick={() => setSheet(false)}>
          <div className="bw-bcar-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Cards</h3>
            {slots.map((s, i) => (
              <div className="bw-bcar-row" key={s.id}>
                <span className={s.hidden ? 'is-hidden' : undefined}>{nameOf(s.id)}</span>
                <button type="button" disabled={i === 0} onClick={() => move(s.id, -1)}>
                  ↑
                </button>
                <button type="button" disabled={i === slots.length - 1} onClick={() => move(s.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  disabled={s.id === 'bsv'}
                  onClick={() => setSlots((x) => x.map((y) => (y.id === s.id ? { ...y, hidden: !y.hidden } : y)))}
                >
                  {s.hidden ? 'Show' : 'Hide'}
                </button>
              </div>
            ))}
            <button type="button" className="bw-bcar-done" onClick={() => setSheet(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
