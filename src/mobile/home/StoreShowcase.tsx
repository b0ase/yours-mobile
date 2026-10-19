import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ShoppingBag } from 'lucide-react';
import { LISTED_SHOPS } from '../themeStore/shops';
import { HEADLINE_ALBUM } from '../media/featured/featured';
import { BSPACES_ENABLED } from '../storeBuild';
import scammersCard from '../wallet/editionArt/scammerscartel-dj-card.webp';
import npgBanner from '../wallet/art/npg/npg-1.webp';
import vexArt from '../media/featured/vexvoid-cover.jpg';

/**
 * Store showcase (home module, bWalletX only: loaded behind THEME_STORE_PAID_ENABLED like the Store itself).
 * A calm, slowly turning shelf of real things in the Store: the edition themes (NPG first; Scammers Cartel hidden until it is ready), the emoji
 * packs, the VexVoid album, OpNS names and Spaces. Every slide opens its own page.
 */
type Item = {
  key: string;
  kind: string;
  title: string;
  blurb: string;
  to: string;
  /** Background behind the picture (or the whole art when there is no picture). */
  art: string;
  /** The item's picture, shown sharp with object-fit: cover; `pos` keeps its focal point in view. */
  img?: string;
  pos?: string;
  logo?: string;
};

/** Sharp art per shop (the shops' own banner CSS uses a soft, blurred backdrop for Scammers Cartel). */
const SHOP_ART: Record<string, { img: string; pos: string } | undefined> = {
  scammerscartel: { img: scammersCard, pos: '50% 35%' },
  npg: { img: npgBanner, pos: '50% 30%' },
  vexvoid: { img: vexArt, pos: '50% 40%' },
};

const ROTATE_MS = 5200;

const reduced = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const showcaseItems = (spaces = BSPACES_ENABLED): Item[] => {
  const order = ['npg', 'emoji', 'vexvoid', 'npgx', 'scammerscartel'];
  const shops = [...LISTED_SHOPS].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const items: Item[] = shops.map((s) => ({
    ...SHOP_ART[s.id],
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
    art: '#000',
    img: HEADLINE_ALBUM.cover,
    pos: '50% 40%',
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
            {it.img && (
              <img className="bw-home-artimg" src={it.img} alt="" style={{ objectPosition: it.pos ?? 'center' }} />
            )}
            <span className="bw-home-cap">
              {it.logo && it.logo !== it.img && <img src={it.logo} alt="" width={34} height={34} />}
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
