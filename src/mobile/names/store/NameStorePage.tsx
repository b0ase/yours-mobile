import { useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Gift, Search } from 'lucide-react';
import { listOpns } from '@1sat/actions';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { ApprovalCard, Chip } from '../../../components/approval/ApprovalCard';
import { CARD } from '../../../components/approval/cardTheme';
import { PayHero } from '../../../components/approval/ApprovalHeroes';
import { bavatarSvg } from '../../bavatar/bavatar';
import { ObsidianBackdrop } from '../../ui/ObsidianBackdrop';
import { fmtSats, fmtUsd, useBsvUsd } from '../../money/money';
import { MARKET_ENABLED } from '../../storeBuild';
import { GuestCtx } from '../../media/artists/guestCtx';
import { resumeAt } from '../../url/resume';
import { checkOpnsAvailability, parseRecipient, resolveRecipient } from '../names';
import { OPNS_PROFILE_DOMAIN } from '../config';
import { OPNS_MINT_ROUTE } from '../opnsBatch';
import { buyOpnsListing, giftOpnsName, opnsIdFor } from '../opnsBuy';
import { giftDestination, giftRecipientLabel } from '../opnsGift';
import { fetchOpnsListings, ownedForSale, type OpnsListing } from '../opnsSell';
import { buyThenGive, displayUsd, normaliseQuery, RAILS, railNames, resultFor, type StoreResult } from './inventory';
import { NAME_TIERS, nameTierUsd, offerHref } from './tiers';

/**
 * The Name Store (/names, owner-approved 13 Oct 2026): "Get your name on Bitcoin. Yours forever."
 * Search → one result card (buy from us, claim a free name, buy from someone else, or taken + suggestions),
 * a live preview of what the name becomes, browse rails from our listed inventory, and "Give a name".
 * Works signed out (GuestNames.tsx): anything that needs the wallet asks to sign in first.
 * Plumbing words (OpNS, mining, ordinals) stay in "What is this?" only. Selling/buying needs MARKET_ENABLED;
 * a store build keeps search and claim only.
 */

const BG = '#07080a';
const GOLD = '#F5B800';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.82)';
const FAINT = 'rgba(244,241,232,0.64)';
const HAIR = 'rgba(244,241,232,0.14)';
// Cards sit on the gold pool: a near-solid dark surface so their text reads (owner, 13 Oct 2026).
const SURFACE = 'rgba(7,8,10,0.72)';
const LISTINGS_URL = 'https://api.1sat.app/1sat/market/listings?status=active&type=application/op-ns&limit=1000';
const f = (u: string, i?: RequestInit) => fetch(u, i);

const usdLabel = (l: OpnsListing, rate: number) => {
  const u = displayUsd(l, rate);
  return u === null ? fmtSats(l.priceSats) : fmtUsd(u);
};

const Avatar = ({ name, size }: { name: string; size: number }) => {
  const src = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bavatarSvg(name || 'b', { size: 128 }))}`,
    [name],
  );
  return <img src={src} alt="" width={size} height={size} className="rounded-full block shrink-0" />;
};

const btn =
  'max-w-full inline-flex items-center justify-center gap-2 rounded-xl px-5 h-11 text-sm font-semibold border-0 cursor-pointer transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 no-underline';
const goldBtn = { background: GOLD, color: '#0a0a0a', outlineColor: GOLD };
const ghostBtn = { background: 'transparent', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}`, outlineColor: GOLD };

type Pending = { listing: OpnsListing; giftTo?: { label: string; address: string } };

export const NameStorePage = () => {
  const { apiContext, isLocked } = useServiceContext();
  const onWallet = useContext(GuestCtx);
  const guest = !!onWallet || isLocked;
  const navigate = useNavigate();
  const { search } = useLocation();
  const rate = useBsvUsd();
  const initial = new URLSearchParams(search).get('q') ?? '';
  const [q, setQ] = useState(initial);
  const [result, setResult] = useState<StoreResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [listings, setListings] = useState<OpnsListing[] | null>(null);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [giving, setGiving] = useState(false);
  const [giftTo, setGiftTo] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const seq = useRef(0);
  const name = normaliseQuery(q);
  const previewName = result && result.kind !== 'invalid' ? result.name : name || 'yourname';

  useEffect(() => {
    let live = true;
    fetchOpnsListings(f, LISTINGS_URL)
      .then((l) => live && setListings(l))
      .catch(() => live && setListings([]));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (guest || !apiContext) return;
    listOpns
      .execute(apiContext, { includeTags: true, limit: 1000 })
      .then((r) => setMine(new Set(ownedForSale(r.outputs).map((o) => o.name))))
      .catch(() => undefined);
  }, [apiContext, guest]);

  const lookup = async (raw: string) => {
    const n = normaliseQuery(raw);
    const id = ++seq.current;
    if (!n) {
      setResult(null);
      return;
    }
    setChecking(true);
    setMsg('');
    try {
      const a = await checkOpnsAvailability(f, n);
      if (id === seq.current) setResult(resultFor(a, listings ?? [], mine));
    } catch {
      if (id === seq.current) setMsg("Couldn't check that name just now. Try again in a moment.");
    } finally {
      if (id === seq.current) setChecking(false);
    }
  };

  // Instant result while typing (debounced), and again once the listings arrive.
  useEffect(() => {
    const t = setTimeout(() => void lookup(q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, listings, mine]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void lookup(q);
  };
  const pick = (n: string) => {
    setQ(n);
    setGiving(false);
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
    document.getElementById('name-store-top')?.scrollIntoView?.({ behavior: 'smooth' });
  };

  /** Anything that needs the wallet: signed out → sign in / create, then come back to this name. */
  const needWallet = (n: string) => {
    if (!guest) return false;
    resumeAt(`/m/names?q=${encodeURIComponent(n)}`);
    onWallet?.();
    return true;
  };

  const claim = (n: string) => {
    if (needWallet(n)) return;
    navigate(`${OPNS_MINT_ROUTE}?mint=${encodeURIComponent(n)}`);
  };

  const startBuy = async (listing: OpnsListing) => {
    if (needWallet(listing.name)) return;
    setMsg('');
    if (!giving) return setPending({ listing });
    const parsed = parseRecipient(giftTo);
    try {
      const r = await resolveRecipient(f, parsed);
      const d = giftDestination(r);
      if (!d.ok) return setMsg(d.error);
      setPending({ listing, giftTo: { label: giftRecipientLabel(r, d.to), address: d.to } });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Enter their $handle or paymail');
    }
  };

  const approve = async () => {
    if (!pending || !apiContext) return;
    const { listing, giftTo: to } = pending;
    setPending(null);
    setBusy(listing.name);
    try {
      if (!to) {
        await buyOpnsListing(apiContext, listing.outpoint, listing.name);
        setMsg(`${listing.name} is yours. It shows in your names within a minute.`);
        setMine((m) => new Set(m).add(listing.name));
      } else {
        const r = await buyThenGive(
          {
            buy: () => buyOpnsListing(apiContext, listing.outpoint, listing.name),
            idOf: (n) => opnsIdFor(apiContext, n),
            send: (id, address) => giftOpnsName(apiContext, id, address),
            onStep: (s) => setMsg(s === 'buying' ? 'Buying…' : s === 'finding' ? 'Wrapping it up…' : 'Sending…'),
          },
          listing.name,
          to.address,
        );
        if (r.ok) setMsg(`Sent. ${listing.name} now belongs to ${to.label}.`);
        else if (r.stage === 'buy') setMsg(r.error);
        else
          setMsg(`You bought ${listing.name}, but the gift didn't go through (${r.error}). It's safe in your wallet.`);
      }
      setListings((l) => (l ?? []).filter((x) => x.outpoint !== listing.outpoint));
      setResult(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Purchase failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <div
      className="relative w-full h-full overflow-y-auto"
      style={{ background: BG, color: TEXT, isolation: 'isolate' }}
    >
      {/* The gold pool (owner, 13 Oct 2026): the obsidian pool's shader in molten gold, dimmed so the text reads. */}
      <ObsidianBackdrop variant="gold" dim={0.58} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px]"
        style={{ background: 'radial-gradient(60% 60% at 50% 0%, rgba(245,184,0,0.10), transparent 70%)' }}
      />
      <div id="name-store-top" className="relative w-full max-w-5xl mx-auto px-4 sm:px-8 pt-12 sm:pt-20 pb-40">
        {/* Hero */}
        <header className="flex flex-col items-center text-center gap-4">
          <span className="text-[11px] font-semibold tracking-[0.18em] uppercase" style={{ color: GOLD }}>
            Names
          </span>
          <h1 className="m-0 text-[34px] leading-[1.05] sm:text-[56px] font-bold tracking-[-0.035em] max-w-[16ch]">
            Get your name on Bitcoin.
          </h1>
          <p className="m-0 text-base sm:text-lg max-w-[46ch]" style={{ color: MUTED }}>
            Yours forever. One payment, no renewals.
          </p>
        </header>

        <form onSubmit={submit} className="mt-8 sm:mt-10 mx-auto max-w-2xl" role="search">
          <label
            className="flex items-center gap-3 rounded-2xl px-4 sm:px-5 h-16 transition-shadow duration-200 focus-within:shadow-[0_0_0_1px_#F5B800,0_12px_40px_rgba(245,184,0,0.12)]"
            style={{ background: '#0f1013', boxShadow: `0 0 0 1px ${HAIR}, 0 12px 40px rgba(0,0,0,0.4)` }}
          >
            <Search size={20} color={FAINT} aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find your name"
              aria-label="Find your name"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-lg sm:text-xl"
              style={{ color: TEXT }}
            />
            <button type="submit" className={`${btn} h-10 px-4 shrink-0`} style={goldBtn}>
              <span className="hidden sm:inline">Search</span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </label>
          {MARKET_ENABLED && (
            <ul
              className="list-none p-0 m-0 mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs"
              style={{ color: FAINT }}
            >
              {NAME_TIERS.map((t) => (
                <li key={t.label}>
                  {t.label} <span style={{ color: MUTED }}>{fmtUsd(t.usd)}</span>
                </li>
              ))}
              <li>Shorter or special names: make an offer</li>
            </ul>
          )}
        </form>

        {/* Result + preview */}
        <section aria-live="polite" className="mt-10 grid gap-4 lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
          <ResultCard
            result={result}
            checking={checking && !!name}
            rate={rate}
            busy={busy}
            giving={giving}
            setGiving={setGiving}
            giftTo={giftTo}
            setGiftTo={setGiftTo}
            onBuy={(l) => void startBuy(l)}
            onClaim={claim}
            onPick={pick}
          />
          <Preview name={previewName} />
        </section>
        {msg && (
          <p role="status" className="mt-4 text-sm text-center m-0" style={{ color: MUTED }}>
            {msg}
          </p>
        )}

        {/* Browse */}
        {MARKET_ENABLED && (
          <div className="mt-16 flex flex-col gap-10">
            {RAILS.map((r) => (
              <Rail key={r.id} title={r.title} sub={r.sub} loading={listings === null}>
                {(listings ? railNames(r.id, listings) : []).map((l) => (
                  <button
                    key={l.outpoint}
                    type="button"
                    onClick={() => pick(l.name)}
                    className="group shrink-0 snap-start w-[150px] text-left rounded-2xl p-4 border-0 cursor-pointer transition-[background,transform] duration-150 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2"
                    style={{
                      background: SURFACE,
                      boxShadow: `inset 0 0 0 1px ${HAIR}`,
                      color: TEXT,
                      outlineColor: GOLD,
                    }}
                  >
                    <span className="block text-base font-semibold truncate">{l.name}</span>
                    <span className="block mt-1 text-xs tabular-nums" style={{ color: MUTED }}>
                      {usdLabel(l, rate)}
                    </span>
                    <span
                      className="block mt-3 text-xs font-semibold opacity-60 group-hover:opacity-100 transition-opacity"
                      style={{ color: GOLD }}
                    >
                      View →
                    </span>
                  </button>
                ))}
              </Rail>
            ))}
          </div>
        )}

        <WhatIsThis />
      </div>

      {MARKET_ENABLED && pending && (
        <BuySheet
          name={pending.listing.name}
          amount={usdLabel(pending.listing, rate)}
          sats={pending.listing.priceSats}
          giftTo={pending.giftTo?.label}
          onAllow={() => void approve()}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
};

const ResultCard = (p: {
  result: StoreResult | null;
  checking: boolean;
  rate: number;
  busy: string;
  giving: boolean;
  setGiving: (v: boolean) => void;
  giftTo: string;
  setGiftTo: (v: string) => void;
  onBuy: (l: OpnsListing) => void;
  onClaim: (n: string) => void;
  onPick: (n: string) => void;
}) => {
  const r = p.result;
  const shell = (children: ReactNode) => (
    <div
      className="rounded-3xl p-6 sm:p-8 flex flex-col gap-5 min-h-[260px]"
      style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
    >
      {children}
    </div>
  );
  if (!r)
    return shell(
      <div className="flex flex-col gap-2 my-auto">
        <p className="m-0 text-2xl font-semibold tracking-tight">
          {p.checking ? 'Checking…' : 'Type a name to start.'}
        </p>
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          Letters, numbers and dashes. First come, first served.
        </p>
      </div>,
    );

  const title = (
    <p className="m-0 text-[32px] sm:text-[40px] font-bold tracking-[-0.03em] leading-none break-all">{r.name}</p>
  );
  const busy = p.busy === r.name;
  const buyable = MARKET_ENABLED && (r.kind === 'house' || r.kind === 'listed');
  const gift = buyable && (
    <div className="flex flex-col gap-2">
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: MUTED }}>
        <input
          type="checkbox"
          checked={p.giving}
          onChange={(e) => p.setGiving(e.target.checked)}
          className="accent-[#F5B800] w-4 h-4"
        />
        <Gift size={14} aria-hidden="true" /> Give it to someone
      </label>
      {p.giving && (
        <input
          value={p.giftTo}
          onChange={(e) => p.setGiftTo(e.target.value)}
          placeholder="Their $handle or paymail"
          aria-label="Who is it for? Their $handle or paymail"
          autoCapitalize="none"
          className="h-11 rounded-xl px-4 text-sm outline-none focus-visible:shadow-[0_0_0_1px_#F5B800]"
          style={{ background: '#0b0c0f', color: TEXT, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
        />
      )}
    </div>
  );

  switch (r.kind) {
    case 'invalid':
      return shell(
        <>
          {title}
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            {r.reason}. Try lower-case letters, numbers or a dash.
          </p>
        </>,
      );
    case 'mine':
      return shell(
        <>
          {title}
          <p className="m-0 text-base inline-flex items-center gap-2" style={{ color: GOLD }}>
            <Check size={18} aria-hidden="true" /> Already yours.
          </p>
          <Link to={OPNS_MINT_ROUTE} className={btn} style={{ ...ghostBtn, alignSelf: 'flex-start' }}>
            Manage your names
          </Link>
        </>,
      );
    case 'premium':
      // A store build has no selling or buying (MARKET_ENABLED): premium and listed names just read "Taken".
      if (!MARKET_ENABLED)
        return shell(
          <>
            {title}
            <p className="m-0 text-lg" style={{ color: MUTED }}>
              Taken.
            </p>
          </>,
        );
      return shell(
        <>
          {title}
          <p className="m-0 text-base" style={{ color: MUTED }}>
            A special name. It isn&apos;t sold at a set price, but we&apos;re happy to hear an offer.
          </p>
          <a href={offerHref(r.name)} className={btn} style={{ ...goldBtn, alignSelf: 'flex-start' }}>
            Make an offer
          </a>
        </>,
      );
    case 'house':
    case 'listed': {
      if (!MARKET_ENABLED)
        return shell(
          <>
            {title}
            <p className="m-0 text-lg" style={{ color: MUTED }}>
              Taken.
            </p>
          </>,
        );
      const price = usdLabel(r.listing, p.rate);
      return shell(
        <>
          {title}
          <p className="m-0 text-lg">
            {r.kind === 'house' ? (
              <>
                <span style={{ color: GOLD }}>{r.name}</span> is yours for {price}.
              </>
            ) : (
              <>Its owner is selling it for {price}.</>
            )}
          </p>
          <>
            {gift}
            <button
              type="button"
              disabled={!!p.busy}
              onClick={() => p.onBuy(r.listing)}
              className={btn}
              style={{ ...goldBtn, alignSelf: 'flex-start' }}
            >
              {busy ? 'Buying…' : p.giving ? `Buy and give · ${price}` : `Buy · ${price}`}
            </button>
            <p className="m-0 text-xs" style={{ color: FAINT }}>
              One payment, plus a tiny network fee. No renewals.
            </p>
          </>
        </>,
      );
    }
    case 'free':
      return shell(
        <>
          {title}
          <p className="m-0 text-lg">
            <span style={{ color: GOLD }}>{r.name}</span> is available: ${(nameTierUsd(r.name) ?? 0).toFixed(2)}.
          </p>
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Paid in BSV at today&apos;s price. Yours forever, or give it to someone. Keep the page open until it&apos;s
            done.
          </p>
          <button
            type="button"
            onClick={() => p.onClaim(r.name)}
            className={btn}
            style={{ ...goldBtn, alignSelf: 'flex-start' }}
          >
            <span className="truncate">Get {r.name}</span>
          </button>
        </>,
      );
    case 'taken':
      return shell(
        <>
          {title}
          <p className="m-0 text-lg" style={{ color: MUTED }}>
            Taken.
          </p>
          {r.suggestions.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: FAINT }}>
                Try instead
              </p>
              <div className="flex flex-wrap gap-2">
                {r.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => p.onPick(s)}
                    className="h-9 px-3.5 rounded-full text-sm border-0 cursor-pointer transition-colors duration-150 hover:bg-[rgba(245,184,0,0.12)] focus-visible:outline focus-visible:outline-2"
                    style={{
                      background: 'transparent',
                      color: TEXT,
                      boxShadow: `inset 0 0 0 1px ${HAIR}`,
                      outlineColor: GOLD,
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>,
      );
  }
};

/** What the name becomes: identity address, a payable name in bWalletX, and the profile card. */
const Preview = ({ name }: { name: string }) => (
  <div
    className="rounded-3xl p-6 sm:p-8 flex flex-col gap-5"
    style={{
      background: 'linear-gradient(160deg, rgba(245,184,0,0.10), rgba(245,184,0,0.02) 55%), rgba(7,8,10,0.74)',
      boxShadow: `inset 0 0 0 1px ${HAIR}`,
    }}
  >
    <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: FAINT }}>
      What it becomes
    </p>
    <div className="flex items-center gap-4">
      <Avatar name={name} size={64} />
      <div className="min-w-0">
        <p className="m-0 text-xl font-semibold truncate">{name}</p>
        <p className="m-0 text-sm truncate" style={{ color: MUTED }}>
          {name}@{OPNS_PROFILE_DOMAIN}
        </p>
      </div>
    </div>
    <dl className="m-0 grid gap-3 text-sm">
      {[
        ['Pay me', `Anyone with bWalletX pays you by typing ${name}.`],
        ['Profile', `${name}@${OPNS_PROFILE_DOMAIN} shows your name and picture.`],
        ['Yours', 'One payment. No renewals, no expiry.'],
      ].map(([k, v]) => (
        <div key={k} className="flex gap-3 items-baseline">
          <dt className="w-16 shrink-0 text-xs font-semibold" style={{ color: GOLD }}>
            {k}
          </dt>
          <dd className="m-0 min-w-0 break-words" style={{ color: MUTED }}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

const Rail = (p: { title: string; sub: string; loading: boolean; children: ReactNode[] }) => {
  if (!p.loading && p.children.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-lg font-semibold tracking-tight">{p.title}</h2>
        <span className="text-sm" style={{ color: FAINT }}>
          {p.sub}
        </span>
      </div>
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 flex gap-3 overflow-x-auto snap-x pb-2">
        {p.loading
          ? Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="shrink-0 w-[150px] h-[104px] rounded-2xl animate-pulse"
                style={{ background: SURFACE }}
              />
            ))
          : p.children}
      </div>
    </section>
  );
};

const WhatIsThis = () => (
  <details className="mt-16 mx-auto max-w-2xl rounded-2xl px-5 py-4" style={{ boxShadow: `inset 0 0 0 1px ${HAIR}` }}>
    <summary className="cursor-pointer text-sm font-semibold" style={{ color: MUTED }}>
      What is this?
    </summary>
    <div className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed" style={{ color: FAINT }}>
      <p className="m-0">
        These are on-chain names (OpNS) on Bitcoin SV. Each name is a 1-sat ordinal inscription held by your wallet, not
        an account we can take back. Once it&apos;s yours it stays yours: no renewals and no expiry.
      </p>
      <p className="m-0">
        New names are first come, first served. Names already claimed can only be bought if their owner lists them.
      </p>
      {MARKET_ENABLED && (
        <p className="m-0">
          Prices are set in US dollars and paid in BSV at the live rate when you buy, plus a small network fee.
          Purchases are final; there are no refunds.
        </p>
      )}
      <p className="m-0">Your name takes payments in bWalletX once you set it as your name in Settings › Identity.</p>
    </div>
  </details>
);

const BuySheet = (p: {
  name: string;
  amount: string;
  sats: number;
  giftTo?: string;
  onAllow: () => void;
  onClose: () => void;
}) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub="Names"
        onClose={p.onClose}
        hero={<PayHero amount={p.amount} sub={fmtSats(p.sats)} badge={p.giftTo ? 'GIFT' : 'PAY'} />}
        title={
          p.giftTo ? (
            <>
              Buy <span style={{ color: CARD.gold }}>{p.name}</span> for {p.giftTo}
            </>
          ) : (
            <>
              Buy <span style={{ color: CARD.gold }}>{p.name}</span>
            </>
          )
        }
        primary={{ label: 'Allow', onClick: p.onAllow }}
        secondary={{ label: 'Not now', onClick: p.onClose }}
      >
        <div className="flex flex-wrap gap-2">
          <Chip>Yours forever</Chip>
          <Chip>Plus a small network fee</Chip>
          {p.giftTo ? <Chip>Sent to {p.giftTo} straight after</Chip> : <Chip>Kept in your wallet</Chip>}
          <Chip>No refunds</Chip>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );

export default NameStorePage;
