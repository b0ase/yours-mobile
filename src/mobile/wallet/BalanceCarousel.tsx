import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { PenLine, X } from 'lucide-react';
import { BCREDITS_ENABLED, BUY_CRYPTO_ENABLED, PLACEMENT_ENABLED, STORE_BUILD } from '../storeBuild';
import { PNEE_ICON } from '../notes/pnee';
import { requestWalletAction } from '../phone/walletAction';
import { MNEE_ICON_URL } from '../../utils/constants';
import { getListCoin, getWalletKind, setWalletKind, setWalletView, subscribeWalletKind } from './walletKind';
import { cardForView, filterForCard } from './cardFilter';
import {
  clearFocusedToken,
  getFocusedToken,
  registerFocusHost,
  subscribeFocusedToken,
  type FocusedToken,
} from './cardFocus';
import { CardBalance, CardSkin } from './CardSkin';
import { skinFor } from './cardSkins';
import { publishBalance } from './balanceStore';
import { useBshares } from '../placement/useBshares';
import { requestCreditsSheet } from '../credits/creditsNav';
import { BuyBsvSheet } from './BuyBsv';
import { holdersRoomsEnabled, openHoldersRoom, type HoldersCoin } from './holdersRoom';
import { routeFor } from '../tabs/tabs';
import { AddressBook } from './AddressBook';
import { opensAddressBook } from './addressBookGesture';
import './balanceCards.css';

/**
 * Balance cards: the wallet card as a swipe carousel, one card per kind of balance, always shown with its REAL
 * balance (0.00 included, from balanceStore, published by the screens that already read it). Every card but BSV
 * (which is the real WalletCard with its own pen) has the pen flip icon: the back says what the balance is and its
 * buttons open real screens (Send/Receive, Credits Top up/History, the bShares register, Tickets, Tokens, Buy BSV
 * where allowed). bCredits has "View contract" with the decided terms. No mock money: nothing here signs or spends.
 * Long-press opens All cards.
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

type BackButton = { label: string; run: () => void; primary?: boolean };
type CardDef = {
  id: string;
  title: string;
  /** Front line before a real balance is known: a 0.00 in the card's unit (or a label for Top up). */
  sub: string;
  /** Second front line (who issues it). */
  issuer: string;
  colour: string;
  logo: ReactNode;
  /** Back of the card: what the balance is for, in true words. */
  backLines: string[];
  /** Back buttons: each opens a real screen. */
  backButtons: BackButton[];
  /** "View contract" sheet (bCredits only, the decided terms). */
  agreement?: Agreement;
  /** A tapped token's card: its real balance, already formatted (instead of balanceStore). */
  amount?: string;
};

/** A tapped token row as a card: real balance and icon; the back's buttons are the row's existing actions. */
const tokenCard = (t: FocusedToken): CardDef => ({
  id: `tok-${t.id}`,
  title: t.name,
  sub: t.amount,
  amount: t.amount,
  issuer: 'BSV-21 token',
  colour: '#14161f',
  logo: <img src={t.icon} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
  backLines: ['A BSV-21 token held in this wallet’s keys.'],
  backButtons: [
    { label: 'Send', run: t.onSend, primary: true },
    ...(t.onReceive ? [{ label: 'Receive', run: t.onReceive }] : []),
    ...(t.onLock ? [{ label: 'Lock', run: t.onLock }] : []),
    ...(t.onRoom ? [{ label: 'Room', run: t.onRoom }] : []),
  ],
});

/*
 * Not here on purpose: Stop, running-contract lines, spent counters and a live tick-down. They need a running
 * contract on the server (bit-sign debiting a balance as it is used), which does not exist yet; they come with
 * the server debit. Until then a card shows only its real balance and opens real screens.
 */

const FlipBtn = ({ onFlip, back }: { onFlip: () => void; back: boolean }) => (
  <button
    type="button"
    className="bw-wcard-penflip"
    aria-label={back ? 'Flip card to the front' : 'Flip card'}
    title="Flip card"
    onClick={(e) => {
      e.stopPropagation();
      onFlip();
    }}
  >
    <PenLine size={20} aria-hidden="true" />
  </button>
);

const FlipCard = ({ c }: { c: CardDef }) => {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const flip = () => {
    setTurning(true);
    timers.current.push(
      window.setTimeout(() => setFlipped((f) => !f), 220),
      window.setTimeout(() => setTurning(false), 440),
    );
  };
  const ink = skinFor(c.id, c.colour).ink;
  const style = {
    position: 'relative' as const,
    width: '100%',
    overflow: 'hidden',
    background: c.colour,
    color: ink,
    border: 0,
    textAlign: 'left' as const,
    ['--bc-ink' as string]: ink,
  };
  const head = (
    <span className="bw-bc-top" style={{ position: 'relative' }}>
      <span className="bw-bc-logo">{c.logo}</span>
      <span className="bw-bc-head">
        <b>{c.title}</b>
        <small>{c.issuer}</small>
      </span>
    </span>
  );
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back${turning ? ' is-turning' : ''}`} style={style} onClick={flip}>
        <CardSkin id={c.id} colour={c.colour} />
        <FlipBtn onFlip={flip} back />
        {head}
        <span className="bw-bc-terms" style={{ position: 'relative' }}>
          {c.backLines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
        <span className="bw-bc-actions" style={{ position: 'relative' }}>
          {c.backButtons.map((b) => (
            <button
              type="button"
              key={b.label}
              className={b.primary ? 'bw-bc-stop is-top' : 'bw-bc-contact'}
              onClick={(e) => {
                e.stopPropagation();
                b.run();
              }}
            >
              {b.label}
            </button>
          ))}
          {c.agreement && (
            <button
              type="button"
              className="bw-bc-contact"
              onClick={(e) => {
                e.stopPropagation();
                setSheetOpen(true);
              }}
            >
              View contract
            </button>
          )}
        </span>
        {sheetOpen && c.agreement && <AgreementSheet a={c.agreement} onClose={() => setSheetOpen(false)} />}
      </div>
    );
  return (
    <div
      className={`bw-bc${turning ? ' is-turning' : ''}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`${c.title}: flip for details`}
      onClick={flip}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && flip()}
    >
      <CardSkin id={c.id} colour={c.colour} />
      <FlipBtn onFlip={flip} back={false} />
      {head}
      <span style={{ position: 'relative' }}>
        {c.amount !== undefined ? (
          <span className="bw-skin-bal bw-bc-amt">{c.amount}</span>
        ) : (
          <CardBalance id={c.id} live fallback={c.sub} className="bw-skin-bal bw-bc-amt" />
        )}
      </span>
    </div>
  );
};

/** The bCredits contract: the decided terms, as a one-page NDS instrument (bit-sign's signable HTML). */
type Agreement = { title: string; ref: string; file: string; issuer: string; clauses: [string, string][] };

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ndsHtml = (a: Agreement) => {
  const manifest = {
    nds: '1.0',
    documentTitle: a.title,
    documentRef: a.ref,
    canonical: { algo: 'sha-256', over: 'rendered-pdf' },
    resolution: 'dom-anchor',
    signatureFields: [
      { id: 'issuer', role: 'Issuer', name: a.issuer, party: 'issuer', required: true, order: 1 },
      { id: 'holder', role: 'Customer', name: 'You', party: 'customer', required: true, order: 2 },
    ],
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)}</title>
<script type="application/npg-sig-manifest+json">
${JSON.stringify(manifest, null, 2)}
</script>
<style>
body{margin:0;background:#0b0b0d;font-family:'Times New Roman',serif;font-size:16px;line-height:1.5;color:#111}
.sheet{background:#fff;margin:12px;padding:20px 18px;border-radius:6px;border-top:4px solid #ffd24d}
h1{font-size:21px;margin:0 0 4px}.ref{font-size:12px;color:#555;font-family:ui-monospace,Menlo,monospace}
.parties{border-top:1px solid #ccc;border-bottom:1px solid #ccc;padding:8px 0;margin:10px 0}
ol{padding-left:22px}li{margin-bottom:8px}
.execution{display:flex;flex-direction:column;gap:18px;margin-top:18px}
.sig-line{border-bottom:1px solid #000;min-height:56px}.sig-caption{font-size:13px;color:#333}
.note{font-size:12px;color:#555;margin-top:14px}
</style></head><body><div class="sheet">
<h1>${esc(a.title)}</h1><div class="ref">${esc(a.ref)}</div>
<div class="parties"><b>Between</b> ${esc(a.issuer)} (the issuer)<br><b>and</b> you, the holder of this wallet</div>
<ol>${a.clauses.map(([h, t]) => `<li><b>${esc(h)}.</b> ${esc(t)}</li>`).join('')}</ol>
<div class="execution">
<div class="sig-block"><div class="sig-line" data-sig-anchor="issuer"></div><div class="sig-caption">${esc(a.issuer)}</div></div>
<div class="sig-block"><div class="sig-line" data-sig-anchor="holder"></div><div class="sig-caption">You</div></div>
</div>
<div class="note">Unsigned. You accept these terms when you top up; the signature lines are for bit-sign.</div>
</div></body></html>`;
};

const AgreementSheet = ({ a, onClose }: { a: Agreement; onClose: () => void }) => {
  const html = ndsHtml(a);
  const save = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = a.file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };
  return (
    <Layer onClose={onClose}>
      <div className="bw-ag" onClick={(e) => e.stopPropagation()}>
        <iframe className="bw-ag-doc" title={a.title} sandbox="" srcDoc={html} />
        <div className="bw-ag-btns">
          <button type="button" onClick={save}>
            Save contract (.nds.html)
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Layer>
  );
};

/** The bCredits terms as decided (matches bit-sign creditsTerms() and CREDITS_TERMS_FALLBACK). */
const BCREDITS_AGREEMENT: Agreement = {
  title: 'bCredits contract',
  ref: 'BCORP-BCREDITS-1',
  file: 'bcredits-contract.nds.html',
  issuer: 'The Bitcoin Corporation Ltd',
  clauses: [
    ['Issuer', 'bCredits are issued by The Bitcoin Corporation Ltd.'],
    ['Price', '1 bCredit = 1p. You pay in BSV at the BSV/GBP rate when you top up.'],
    [
      'What they pay for',
      'bCredits are spent only on b, the bWalletX agent. Each b reply costs what it costs to run × 1.35, rounded up to whole bCredits. b never runs you into debt.',
    ],
    [
      'Today',
      'Ask b uses bCredits once the server has switched bCredits on for b; until then Ask b is paid per message in BSV.',
    ],
    ['Top-ups', 'Each top-up is up to £20.'],
    ['Expiry', 'bCredits do not expire.'],
    ['Refunds', 'bCredits are non-refundable except where the law requires.'],
    ['Transfers', 'bCredits cannot be cashed out, sent to anyone or spent anywhere else.'],
  ],
};

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
  const [buyOpen, setBuyOpen] = useState(false);
  // Address book (owner, 15 Oct 2026): pull right past the first card, or the notebook button.
  const [book, setBook] = useState(false);
  const pull0 = useRef<{ x: number; y: number; left: number } | null>(null);
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

  // bShares: the register's real count (0 for a non-member), once bit-sign has answered.
  useEffect(() => {
    if (!PLACEMENT_ENABLED || shares.loading || shares.error) return;
    publishBalance(
      'bshares',
      (shares.me?.holdings ?? []).reduce((n, h) => n + h.shares, 0),
      'shares',
    );
  }, [shares.loading, shares.error, shares.me]);

  // Every kind of balance always has its card (owner, 15 Oct 2026), showing the real balance (0.00 included). Tap or
  // the pen flips it; the back says what it is and its buttons open the real screens. Nothing here signs or spends.
  const showTokens = () => setWalletKind('tokens');
  // MNEE / PNEEs holders' rooms (bWalletX; a store build has no token rooms).
  const holdersBtn = (coin: HoldersCoin): BackButton[] =>
    holdersRoomsEnabled()
      ? [{ label: 'Holders room', run: () => openHoldersRoom(coin, () => navigate(routeFor('chat') ?? '/m/chat')) }]
      : [];
  const cards: CardDef[] = [
    {
      id: 'bsv',
      title: 'BSV',
      sub: '0.00 BSV',
      issuer: 'Your wallet',
      colour: '#16161a',
      logo: '₿',
      backLines: [],
      backButtons: [],
    },
    {
      id: 'tokens',
      title: 'Tokens',
      sub: '0.00 tokens',
      issuer: 'BSV-21 tokens in this wallet',
      colour: '#14161f',
      logo: '◎',
      backLines: [
        'The BSV-21 tokens this wallet holds, counted from the chain.',
        'Send, receive or open each one from the Tokens list.',
      ],
      backButtons: [{ label: 'Open tokens', run: showTokens, primary: true }],
    },
  ];
  if (TICKETS_CARD_ENABLED)
    cards.push({
      id: 'btickets',
      title: 'bTickets',
      sub: '0.00 tickets',
      issuer: 'Tokens that open rooms',
      colour: '#1f1414',
      logo: '✦',
      backLines: [
        'Tokens you hold that get you into a room: a Space, a chat or a show.',
        'Holding the token is the ticket. Open the room from My tickets.',
      ],
      backButtons: [{ label: 'My tickets', run: () => setWalletKind('tickets'), primary: true }],
    });
  if (PLACEMENT_ENABLED)
    cards.push({
      id: 'bshares',
      title: 'bShares',
      sub: '0.00 shares',
      issuer: 'The Bitcoin Corporation Ltd',
      colour: '#23200f',
      logo: '§',
      backLines: shares.me
        ? [
            'Your shares in The Bitcoin Corporation Ltd, as recorded on its Register of Members (bit-sign).',
            'Restricted: not offered publicly.',
          ]
        : [
            'Shares in The Bitcoin Corporation Ltd, as recorded on its Register of Members (bit-sign).',
            'You are not on the register.',
          ],
      backButtons: shares.me ? [{ label: 'Open register', run: () => navigate('/m/bshares'), primary: true }] : [],
    });
  if (BCREDITS_ENABLED)
    cards.push({
      id: 'bcredits',
      title: 'bCredits',
      sub: '0.00 bCredits',
      issuer: 'The Bitcoin Corporation Ltd',
      colour: '#1a1608',
      logo: '¢',
      backLines: [
        'Prepaid credit for b, the bWalletX agent. 1 bCredit = 1p.',
        'Each b reply costs what it costs to run × 1.35. Top-ups up to £20. No expiry.',
      ],
      backButtons: [
        {
          label: 'Top up',
          primary: true,
          run: () => {
            setWalletKind('credits');
            requestCreditsSheet('topup');
          },
        },
        {
          label: 'History',
          run: () => {
            setWalletKind('credits');
            requestCreditsSheet('history');
          },
        },
      ],
      agreement: BCREDITS_AGREEMENT,
    });
  cards.push(
    {
      id: 'mnee',
      title: 'MNEE',
      sub: `${(mnee ?? 0).toFixed(2)} MNEE`,
      issuer: 'USD stablecoin on BSV · issued by MNEE',
      colour: '#0f2a1f',
      logo: <img src={MNEE_ICON_URL} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      backLines: ['A US dollar stablecoin on BSV: 1 MNEE is meant to be worth $1.', 'Held in this wallet’s keys.'],
      backButtons: [
        { label: 'Send', run: () => requestWalletAction('send'), primary: true },
        { label: 'Receive', run: () => requestWalletAction('receive') },
        ...holdersBtn('mnee'),
      ],
    },
    {
      id: 'pnee',
      title: 'PNEEs',
      sub: '0.00 PNEEs',
      issuer: 'Penny Notes · BSV-21',
      colour: '#1d1430',
      logo: <img src={PNEE_ICON} alt="" width={22} height={22} style={{ borderRadius: 11 }} />,
      backLines: ['Penny Notes: a BSV-21 token counted in US cents.', 'Held in this wallet’s keys.'],
      backButtons: [
        { label: 'Send', run: () => requestWalletAction('send'), primary: true },
        { label: 'Receive', run: () => requestWalletAction('receive') },
        ...holdersBtn('pnee'),
      ],
    },
    {
      id: 'topup',
      title: 'Top up',
      sub: 'Add BSV to your wallet',
      issuer: 'Fund this wallet',
      colour: '#2a2208',
      logo: '+',
      backLines: BUY_CRYPTO_ENABLED
        ? ['Receive BSV from another wallet or an exchange, or buy some with a card.']
        : ['Receive BSV from another wallet or an exchange.'],
      backButtons: [
        { label: 'Receive', run: () => requestWalletAction('receive'), primary: true },
        ...(BUY_CRYPTO_ENABLED ? [{ label: 'Buy BSV', run: () => setBuyOpen(true) }] : []),
      ],
    },
  );

  // Card ⇄ list sync (owner, 15 Oct 2026). A swipe that settles on a card shows that card's list (cardFilter.ts);
  // a chip (or any other view change) scrolls to the matching card. `pending` is a scroll we started: its
  // in-between cards never touch the list.
  const ids = cards.map((c) => c.id);
  const idsKey = ids.join(',');
  const activeRef = useRef(0);
  const pending = useRef<number | null>(null);
  const settle = useRef<number | null>(null);
  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el || i < 0) return;
    pending.current = i;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    activeRef.current = i;
    setActive(i);
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      const at = activeRef.current;
      if (pending.current !== null) {
        if (pending.current === at) pending.current = null;
        return;
      }
      const id = ids[at];
      if (!id) return;
      const f = filterForCard(id);
      setWalletView(f.kind, f.coin);
    }, 140);
  };
  useEffect(
    () => () => {
      if (settle.current !== null) window.clearTimeout(settle.current);
    },
    [],
  );
  const kind = useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);
  const coin = useSyncExternalStore(subscribeWalletKind, getListCoin, getListCoin);
  useEffect(() => {
    const list = idsKey.split(',');
    const at = pending.current ?? activeRef.current;
    const i = cardForView({ kind, coin }, list, list[at]);
    if (i !== null && i !== at) goTo(i);
  }, [kind, coin, idsKey, goTo]);

  // Tap a token row: it becomes the front card until × or a swipe (cardFocus.ts).
  useEffect(() => registerFocusHost(), []);
  const focused = useSyncExternalStore(subscribeFocusedToken, getFocusedToken, getFocusedToken);
  const swipe0 = useRef<{ x: number; y: number } | null>(null);
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
      <div className="bw-bcar-stage">
        <div
          ref={track}
          className="bw-bcar-track"
          style={focused ? { visibility: 'hidden' } : undefined}
          onScroll={onScroll}
          onTouchStart={(e) => {
            pull0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, left: e.currentTarget.scrollLeft };
            startPress();
          }}
          onTouchEnd={(e) => {
            endPress();
            const p = pull0.current;
            pull0.current = null;
            if (!p || focused) return;
            const t = e.changedTouches[0];
            if (opensAddressBook(p.left, { dx: t.clientX - p.x, dy: t.clientY - p.y })) setBook(true);
          }}
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
                  <FlipCard c={c} />
                </div>
              )}
            </div>
          ))}
        </div>
        {focused && (
          <div
            className="bw-bcar-focus"
            onTouchStart={(e) => (swipe0.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
            onTouchEnd={(e) => {
              const s0 = swipe0.current;
              swipe0.current = null;
              if (!s0) return;
              const dx = e.changedTouches[0].clientX - s0.x;
              const dy = e.changedTouches[0].clientY - s0.y;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) clearFocusedToken();
            }}
          >
            <div className="bw-bcar-wrap">
              <FlipCard key={focused.id} c={tokenCard(focused)} />
            </div>
            <button
              type="button"
              className="bw-bcar-unfocus"
              aria-label="Back to your cards"
              onClick={clearFocusedToken}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div style={{ position: 'relative', minHeight: 26 }}>
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
      </div>
      {book && <AddressBook onClose={() => setBook(false)} />}
      {BUY_CRYPTO_ENABLED && buyOpen && (
        <BuyBsvSheet
          onClose={() => setBuyOpen(false)}
          onReceive={() => {
            setBuyOpen(false);
            requestWalletAction('receive');
          }}
        />
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
