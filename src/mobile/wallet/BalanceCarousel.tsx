import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BCREDITS_ENABLED, PLACEMENT_ENABLED, STORE_BUILD } from '../storeBuild';
import { PNEE_ICON } from '../notes/pnee';
import { requestWalletAction } from '../phone/walletAction';
import { MNEE_ICON_URL } from '../../utils/constants';
import { setWalletKind } from './walletKind';
import { CardBalance, CardSkin } from './CardSkin';
import { skinFor } from './cardSkins';
import { publishBalance } from './balanceStore';
import { useBshares } from '../placement/useBshares';
import './balanceCards.css';

/**
 * Balance cards: the wallet card as a swipe carousel, one card
 * per kind of balance, always shown with its REAL balance (0 included). No mock money anywhere: the BSV card is the real WalletCard; bCredits opens the real Credits view
 * (real top-up); MNEE shows the wallet's real MNEE balance and only appears once one is known; bShares appears
 * only for a member on bit-sign's register and opens the real bShares bApp. Long-press opens All cards.
 * Nothing here signs or spends; every money action happens in the real screens it opens.
 */

const TICKETS_CARD_ENABLED = !STORE_BUILD;

const readMnee = (): number | null => {
  try {
    const raw = localStorage.getItem('bwallet:mnee-balance');
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

type CardDef = { id: string; title: string; sub: string; colour: string; logo: ReactNode; open: () => void };

const SimpleCard = ({ c }: { c: CardDef }) => (
  <button
    type="button"
    className="bw-bc"
    onClick={c.open}
    style={{
      position: 'relative',
      width: '100%',
      overflow: 'hidden',
      background: c.colour,
      color: skinFor(c.id, c.colour).ink,
      border: 0,
      textAlign: 'left',
    }}
  >
    <CardSkin id={c.id} colour={c.colour} />
    <span style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
        {c.logo}
        {c.title}
      </span>
      <CardBalance id={c.id} live fallback={c.sub} />
    </span>
  </button>
);

const Layer = ({ onClose, children, sheet = false }: { onClose: () => void; children: ReactNode; sheet?: boolean }) => {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    let popped = false;
    try {
      window.history.pushState({ bwCardLayer: true }, '');
    } catch {
      /* ignore */
    }
    const onPop = () => {
      popped = true;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      body.style.overflow = prev;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      if (!popped && (window.history.state as { bwCardLayer?: boolean } | null)?.bwCardLayer) window.history.back();
    };
  }, []);
  const startY = useRef<number | null>(null);
  return createPortal(
    <div
      className={`bw-layer${sheet ? ' is-sheet' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        const sc = (e.target as HTMLElement).closest('.bw-layer-scroll');
        const onTile = (e.target as HTMLElement).closest('.bw-eg-tile');
        startY.current = !onTile && (!sc || sc.scrollTop <= 0) ? e.touches[0].clientY : null;
      }}
      onTouchEnd={(e) => {
        if (startY.current !== null && e.changedTouches[0].clientY - startY.current > 120) onClose();
        startY.current = null;
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

type TmCard = { key: string; id: string; title: string; sub: string; colour: string; logo: ReactNode };
const reducedMotionTm = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const TimeMachine = ({
  cards,
  start,
  onPick,
  onClose,
}: {
  cards: TmCard[];
  start: number;
  onPick: (i: number) => void;
  onClose: () => void;
}) => {
  const [focus, setFocus] = useState(start);
  const [reduced] = useState(reducedMotionTm);
  const t0 = useRef<{ y: number; f: number } | null>(null);
  const clamp = (f: number) => Math.max(0, Math.min(cards.length - 1, f));
  return (
    <Layer onClose={onClose}>
      <div
        className={`bw-tm${reduced ? ' is-flat' : ''}`}
        onWheel={(e) => setFocus((f) => clamp(f + e.deltaY / 240))}
        onTouchStart={(e) => (t0.current = { y: e.touches[0].clientY, f: focus })}
        onTouchMove={(e) => {
          if (!t0.current || reduced) return;
          setFocus(clamp(t0.current.f + (t0.current.y - e.touches[0].clientY) / 120));
        }}
        onTouchEnd={() => {
          t0.current = null;
          if (!reduced) setFocus((f) => Math.round(f));
        }}
      >
        <div className="bw-tm-stars" />
        <div className="bw-tm-head">
          <b>All cards</b>
          <span>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        <div className="bw-tm-stage">
          {cards.map((c, i) => {
            const o = i - focus;
            const style = reduced
              ? undefined
              : {
                  transform: `translate(-50%, -50%) translate3d(0, ${-o * 46}px, ${-o * 260}px) scale(${o < 0 ? 1 - o * 0.25 : 1})`,
                  opacity: o < -0.9 ? 0 : Math.max(0, 1 - o * 0.16),
                  zIndex: 1000 - Math.round(o * 10),
                  pointerEvents: (o < -0.5 ? 'none' : 'auto') as 'none' | 'auto',
                  filter: o > 0.5 ? `brightness(${Math.max(0.45, 1 - o * 0.1)})` : undefined,
                };
            return (
              <button
                type="button"
                key={c.key}
                className="bw-tm-card"
                style={{ ...style, background: c.colour, color: skinFor(c.id, c.colour).ink }}
                onClick={() => (reduced || Math.abs(o) < 0.5 ? onPick(i) : setFocus(i))}
              >
                <CardSkin id={c.id} colour={c.colour} />
                <span className="bw-tm-logo">{c.logo}</span>
                <span className="bw-tm-text">
                  <b>{c.title}</b>
                  <CardBalance id={c.id} live={Math.abs(o) < 2.5} fallback={c.sub} />
                </span>
              </button>
            );
          })}
        </div>
        <p className="bw-tm-hint">Swipe up and down to fly through · tap a card to land on it</p>
      </div>
    </Layer>
  );
};

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const [tm, setTm] = useState(false);
  const [mnee, setMnee] = useState<number | null>(readMnee);
  const track = useRef<HTMLDivElement>(null);
  const shares = useBshares();

  // MNEE: the wallet's real balance (BsvWallet shares the last fetch), read only.
  useEffect(() => {
    const read = () => {
      const v = readMnee();
      setMnee(v);
      if (v !== null) publishBalance('mnee', v, 'MNEE');
    };
    read();
    window.addEventListener('bwallet:mnee-balance', read);
    return () => window.removeEventListener('bwallet:mnee-balance', read);
  }, []);

  // Every kind of balance always has its card (owner, 15 Oct 2026), showing the real balance, 0 included; each opens
  // the real screen for it. Top up opens the real Receive screen.
  const cards: CardDef[] = [
    { id: 'bsv', title: 'BSV', sub: 'Your wallet', colour: '#16161a', logo: '₿', open: () => setWalletKind('tokens') },
    {
      id: 'tokens',
      title: 'Tokens',
      sub: 'Your tokens',
      colour: '#14161f',
      logo: '◎',
      open: () => setWalletKind('tokens'),
    },
  ];
  if (TICKETS_CARD_ENABLED)
    cards.push({
      id: 'btickets',
      title: 'bTickets',
      sub: 'Your tickets',
      colour: '#1f1414',
      logo: '✦',
      open: () => setWalletKind('tickets'),
    });
  if (PLACEMENT_ENABLED)
    cards.push({
      id: 'bshares',
      title: 'bShares',
      sub: shares.me ? 'The Bitcoin Corporation' : 'No shares yet',
      colour: '#23200f',
      logo: '§',
      open: () => navigate('/m/bshares'),
    });
  if (BCREDITS_ENABLED)
    cards.push({
      id: 'bcredits',
      title: 'bCredits',
      sub: 'Tap to top up',
      colour: '#1a1608',
      logo: '¢',
      open: () => setWalletKind('credits'),
    });
  cards.push(
    {
      id: 'mnee',
      title: 'MNEE',
      sub: `${(mnee ?? 0).toFixed(2)} MNEE`,
      colour: '#0f2a1f',
      logo: <img src={MNEE_ICON_URL} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      open: () => setWalletKind('tokens'),
    },
    {
      id: 'pnee',
      title: 'PNEEs',
      sub: '0 PNEEs',
      colour: '#1d1430',
      logo: <img src={PNEE_ICON} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      open: () => setWalletKind('tokens'),
    },
    {
      id: 'topup',
      title: 'Top up',
      sub: 'Add BSV to your wallet',
      colour: '#2a2208',
      logo: '+',
      open: () => requestWalletAction('receive'),
    },
  );

  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el || i < 0) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };
  const press = useRef<number | null>(null);
  const startPress = () => {
    press.current = window.setTimeout(() => setTm(true), 600);
  };
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };
  useEffect(() => () => endPress(), []);

  const tmCards: TmCard[] = cards.map((c) => ({
    key: c.id,
    id: c.id,
    title: c.title,
    sub: c.sub,
    colour: c.colour,
    logo: c.logo,
  }));

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
          setTm(true);
        }}
      >
        {cards.map((c) => (
          <div className="bw-bcar-slide" key={c.id}>
            {c.id === 'bsv' ? (
              <div className="bw-bcar-bsv">{bsvCard}</div>
            ) : (
              <div className="bw-bcar-wrap">
                <SimpleCard c={c} />
              </div>
            )}
          </div>
        ))}
      </div>
      {cards.length > 1 && (
        <div className="bw-bcar-dots" aria-label={`Card ${active + 1} of ${cards.length}`}>
          {cards.map((c, i) => (
            <button
              type="button"
              key={c.id}
              aria-label={c.title}
              className={i === active ? 'is-on' : ''}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}
      {tm && (
        <TimeMachine
          cards={tmCards}
          start={active}
          onClose={() => setTm(false)}
          onPick={(i) => {
            setTm(false);
            window.setTimeout(() => goTo(i), 60);
          }}
        />
      )}
    </div>
  );
};
