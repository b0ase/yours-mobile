import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ShoppingBag } from 'lucide-react';
import { SHOPS } from '../themeStore/shops';
import { HEADLINE_ALBUM } from '../media/featured/featured';
import { BSPACES_ENABLED } from '../storeBuild';

/**
 * Store showcase (home module, bWalletX only: loaded behind THEME_STORE_PAID_ENABLED like the Store itself).
 * A calm, slowly turning shelf of real things in the Store: the edition themes (Scammers Cartel first), the emoji
 * packs, the VexVoid album, OpNS names and Spaces. Every slide opens its own page.
 */
type Item = { key: string; kind: string; title: string; blurb: string; to: string; art: string; logo?: string };

const ROTATE_MS = 5200;

const reduced = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const showcaseItems = (spaces = BSPACES_ENABLED): Item[] => {
  const order = ['scammerscartel', 'emoji', 'npg', 'vexvoid', 'npgx'];
  const shops = [...SHOPS].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const items: Item[] = shops.map((s) => ({
    key: `shop:${s.id}`,
    kind: s.id === 'emoji' ? 'Emoji packs' : 'Theme',
    title: s.name,
    blurb: s.blurb,
    to: `/m/store?shop=${encodeURIComponent(s.id)}`,
    art: s.bannerCss ?? (s.banner ? `center / cover no-repeat url(${s.banner}), ${s.colour}` : s.colour),
    logo: s.logo,
  }));
  items.splice(2, 0, {
    key: 'album',
    kind: 'Album',
    title: HEADLINE_ALBUM.title,
    blurb: `${HEADLINE_ALBUM.artist} · first track free`,
    to: '/m/media',
    art: `center / cover no-repeat url(${HEADLINE_ALBUM.cover}), #000`,
  });
  items.splice(4, 0, {
    key: 'names',
    kind: 'Names',
    title: 'Your name on chain',
    blurb: 'OpNS names: short, yours, payable',
    to: '/m/names',
    art: 'radial-gradient(120% 90% at 20% 10%, var(--bw-accent-hi), var(--bw-accent-lo) 55%, #1a1405)',
  });
  if (spaces)
    items.push({
      key: 'spaces',
      kind: 'Spaces',
      title: 'Live Spaces',
      blurb: 'Talks and shows in your rooms, tickets at the door',
      to: '/m/spaces',
      art: 'radial-gradient(120% 90% at 80% 0%, #3a2a08, #0b0905 70%)',
    });
  return items;
};

const StoreShowcase = () => {
  const navigate = useNavigate();
  const items = useMemo(() => showcaseItems(), []);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || reduced() || items.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [paused, items.length]);
  const go = (d: number) => setI((n) => (n + d + items.length) % items.length);
  return (
    <section
      className="bw-home-panel bw-home-show"
      aria-roledescription="carousel"
      aria-label="From the Store"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <header className="bw-home-head">
        <ShoppingBag size={16} className="bw-home-ico" aria-hidden="true" />
        <span className="bw-home-title">From the Store</span>
        <button type="button" className="bw-home-link" onClick={() => navigate('/m/store')}>
          Open Store
        </button>
      </header>
      <div className="bw-home-stage">
        {items.map((it, n) => (
          <button
            key={it.key}
            type="button"
            className={`bw-home-slide${n === i ? ' on' : ''}`}
            aria-hidden={n !== i}
            tabIndex={n === i ? 0 : -1}
            onClick={() => navigate(it.to)}
          >
            <span className="bw-home-art" style={{ background: it.art }} />
            <span className="bw-home-cap">
              {it.logo && <img src={it.logo} alt="" width={34} height={34} />}
              <span className="bw-home-tiletext">
                <span className="bw-home-kind">{it.kind}</span>
                <span className="bw-home-captitle">{it.title}</span>
                <span className="bw-home-capsub">{it.blurb}</span>
              </span>
            </span>
          </button>
        ))}
        <button type="button" className="bw-home-nav l" aria-label="Previous" onClick={() => go(-1)}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className="bw-home-nav r" aria-label="Next" onClick={() => go(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="bw-home-dots" aria-hidden="true">
        {items.map((it, n) => (
          <span key={it.key} className={n === i ? 'on' : ''} />
        ))}
      </div>
    </section>
  );
};

export default StoreShowcase;
