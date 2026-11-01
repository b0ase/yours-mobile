import {
  AppWindow,
  ArchiveRestore,
  ArrowLeftRight,
  AtSign,
  Banknote,
  Bot,
  Box,
  Brain,
  ChevronRight,
  Coins,
  Dna,
  ExternalLink,
  FileSignature,
  FileText,
  Film,
  Globe,
  HardDrive,
  Image as ImageIcon,
  LineChart,
  Link as LinkIcon,
  Mail,
  Music,
  Sparkle,
  Ticket,
  TreePine,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { MINT_PREVIEWS_ENABLED, STORE_BUILD } from '../storeBuild';
import { BrandMark } from './BrandMark';
import { Lockup, ServiceExample } from './ServiceBrand';
import { serviceStyle, type ServiceStyle } from './serviceStyles';
import {
  MINT_SECTIONS,
  MINT_WAYS,
  mintCard,
  type MintAction,
  type MintCard,
  type MintIconId,
  type MintBrand,
  type MintUse,
  APP_BRANDS,
} from './mintCatalog';
import { MINT_SOURCES, mintSource, type MintSourceId } from './mintSources';

/**
 * The Mint sheet's first step (owner's prototype, 1 Nov 2026): "Mint your digital DNA", the two ways in (Link an
 * account, not open yet; Upload your archive), the apps, then every type as same-size tiles. Each tile opens a card
 * that sells it and starts the real flow (MintButton.tsx runs the action). Content: mintCatalog.ts, mintSources.ts.
 * Not-open-yet text is behind MINT_PREVIEWS_ENABLED, so a store build has none of it.
 */
export type ChooserView = { k: 'home' } | { k: 'card'; id: string } | { k: 'app'; id: MintSourceId } | { k: 'more' };

// eslint-disable-next-line react-refresh/only-export-components -- the sheet's header reads the same titles
export const chooserTitle = (v: ChooserView): string =>
  v.k === 'card'
    ? (mintCard(v.id)?.title ?? 'Mint')
    : v.k === 'app'
      ? (mintSource(v.id)?.label ?? 'Mint')
      : v.k === 'more'
        ? 'More apps'
        : 'Mint';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#15171c';
const PANEL2 = '#1d1f25';
const BORDER = '#262a32';
const EDGE = '#262a32';
const INK = '#f2f2f0';
const MUTED = '#9aa0aa';
const DIM = '#8a877f';
const BLUE = '#5fd0ff';
const NOT_OPEN = MINT_PREVIEWS_ENABLED ? 'Not open yet' : '';

const ICONS: Record<MintIconId, LucideIcon> = {
  link: LinkIcon,
  upload: ArchiveRestore,
  spark: Sparkle,
  card: Mail,
  pic: ImageIcon,
  music: Music,
  film: Film,
  video: Video,
  box: Box,
  book: FileText,
  globe: Globe,
  note: Banknote,
  coin: Coins,
  ticket: Ticket,
  at: AtSign,
  sign: FileSignature,
  chart: LineChart,
  app: AppWindow,
  bot: Bot,
  brain: Brain,
  swap: ArrowLeftRight,
  drive: HardDrive,
  tree: TreePine,
};

const isSoon = (a: MintAction) => 'soon' in a;

type Props = {
  view: ChooserView;
  push: (v: ChooserView) => void;
  back: () => void;
  run: (a: MintAction) => void;
  /** Whether a MINT_TILES flow exists in this build and edition. */
  hasFlow: (id: string) => boolean;
  /** Opens one of our services' sites (bWalletX only; a store build passes nothing, so brands are names only). */
  openSite?: (name: string, url: string) => void;
};

export const MintChooser = ({ view, push, back, run, hasFlow, openSite }: Props) => {
  const available = (a: MintAction) => ('flow' in a ? hasFlow(a.flow) : 'site' in a ? !!openSite : true);
  const usesOf = (c: MintCard): MintUse[] => (c.uses ?? []).filter((u) => available(u.action));
  // The card's main button: its own action, else the first use that works today.
  const primary = (c: MintCard): { action: MintAction; label: string } | null => {
    if (c.soon) return null;
    if (c.cta) return available(c.cta) ? { action: c.cta, label: c.ctaLabel ?? 'Start' } : null;
    const u = usesOf(c).find((x) => !isSoon(x.action));
    return u ? { action: u.action, label: `Start: ${u.title.charAt(0).toLowerCase()}${u.title.slice(1)}` } : null;
  };
  // A tile shows when it is a preview (only in preview builds) or something on it works in this build.
  const shown = (c: MintCard | undefined): c is MintCard => !!c && (!!c.soon || primary(c) !== null);

  let body: React.ReactNode;
  let foot: React.ReactNode = null;

  if (view.k === 'home') {
    const ways = MINT_WAYS.map(mintCard).filter(shown);
    body = (
      <>
        <div
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3.5 rounded-[18px] border p-4"
          style={{ background: 'linear-gradient(150deg, #241b06, #111214 65%)', borderColor: BORDER }}
        >
          <span
            className="grid h-[52px] w-[52px] place-items-center rounded-[14px]"
            style={{ background: 'rgba(245,184,0,0.12)', color: GOLD }}
          >
            <Dna size={26} />
          </span>
          <div className="min-w-0">
            <h1 className="m-0 text-[22px] font-bold leading-tight">Mint your digital DNA</h1>
            <p className="m-0 mt-1 text-[13px] leading-snug" style={{ color: MUTED }}>
              Everything you&rsquo;ve made, kept private on Bitcoin, signed and dated by your wallet. Yours to keep, and
              to reveal only if you choose.
            </p>
          </div>
          <div className="col-span-2 flex flex-wrap gap-1.5">
            {['Private by default', 'Signed and dated on chain', 'Reveal it only if you choose'].map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px]"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#d9d5ca' }}
              >
                <i className="block h-1.5 w-1.5 rounded-full" style={{ background: GOLD }} />
                {p}
              </span>
            ))}
          </div>
        </div>
        <SectionTitle>Your past, from the apps you use</SectionTitle>
        <TileGrid>
          {ways.map((c) => (
            <Tile key={c.id} c={c} onClick={() => push({ k: 'card', id: c.id })} />
          ))}
        </TileGrid>
        <SectionTitle>Pick an app</SectionTitle>
        <AppGrid>
          {MINT_SOURCES.filter((s) => s.popular).map((s) => (
            <AppButton key={s.id} id={s.id} onClick={() => push({ k: 'app', id: s.id })} />
          ))}
          <button
            type="button"
            onClick={() => push({ k: 'more' })}
            className="flex min-w-0 flex-col items-center gap-1.5 border-0 bg-transparent px-0 py-1 cursor-pointer"
            style={{ color: '#ccc' }}
          >
            <span
              className="flex h-[46px] w-[46px] items-center justify-center rounded-[13px] text-xl"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)', color: '#aaa' }}
            >
              +
            </span>
            <span className="h-6 text-center text-[11px] leading-[1.1]">More apps</span>
          </button>
        </AppGrid>
        <Fine>Logos belong to their owners. Only mint what you made or own; illegal material is never allowed.</Fine>
        {MINT_SECTIONS.map((sec) => {
          const cards = sec.cards.map(mintCard).filter(shown);
          if (!cards.length) return null;
          return (
            <section key={sec.id} aria-label={sec.title}>
              <SectionTitle brand={sec.brand} openSite={openSite}>
                {sec.title}
              </SectionTitle>
              <TileGrid>
                {cards.map((c) => (
                  <Tile key={c.id} c={c} onClick={() => push({ k: 'card', id: c.id })} />
                ))}
              </TileGrid>
            </section>
          );
        })}
      </>
    );
  } else if (view.k === 'more') {
    body = (
      <>
        <AppGrid>
          {MINT_SOURCES.filter((s) => !s.popular).map((s) => (
            <AppButton key={s.id} id={s.id} onClick={() => push({ k: 'app', id: s.id })} />
          ))}
        </AppGrid>
        <Fine>Can&rsquo;t see yours? Any app that lets you download your data works with Your archive.</Fine>
      </>
    );
  } else if (view.k === 'app') {
    const s = mintSource(view.id)!;
    body = (
      <>
        <Art tint="#1b1d22" height={120}>
          <span
            className="grid h-[76px] w-[76px] place-items-center rounded-[22px]"
            style={{ background: '#111', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)' }}
          >
            <BrandMark id={s.id} size={44} />
          </span>
        </Art>
        <BrandStrip brands={APP_BRANDS[s.id]} openSite={openSite} />
        <h2 className="mb-1 mt-4 text-2xl font-bold leading-tight">Mint your {s.label}</h2>
        <p className="m-0 mb-3.5 text-[15px] leading-normal" style={{ color: '#d6d2c7' }}>
          {s.what}, kept privately in your wallet for good.
        </p>
        <SubTitle>What&rsquo;s in your download</SubTitle>
        <Bullets items={s.get} />
        <SubTitle>{MINT_PREVIEWS_ENABLED ? 'Two ways' : 'How to mint it'}</SubTitle>
        <div className="mb-4 grid gap-2">
          {MINT_PREVIEWS_ENABLED && (
            <UseRow
              title={`Link your ${s.label}`}
              badge={s.link ? NOT_OPEN : 'Download only'}
              sub={
                s.link
                  ? 'Sign in once; every post fingerprinted on chain'
                  : `${s.label} doesn’t let other apps read your posts, so use your download`
              }
              onClick={() => push({ k: 'card', id: 'link' })}
            />
          )}
          <UseRow
            title="Upload from your download"
            live
            sub={s.steps.join(' · ')}
            onClick={() => run({ upload: true })}
          />
        </div>
        <SubTitle>What it&rsquo;s good for</SubTitle>
        <Bullets
          items={[
            `Proof of when you minted it, even if ${s.label} deletes it`,
            'Only you can open it: it’s encrypted on this device first',
            'Reveal it later, if you ever want to show it',
          ]}
        />
        {MINT_PREVIEWS_ENABLED && (
          <>
            <SubTitle>{NOT_OPEN}</SubTitle>
            <Bullets
              dim
              items={[
                'Your agent can learn from it, if you let it',
                'Sell access on BSVEX, on your terms',
                'Hand it down to your heirs',
              ]}
            />
          </>
        )}
        <Fine>Only mint what you made or own. Menus change now and then.</Fine>
      </>
    );
    foot = <Foot back={back} label={`Pick a file from ${s.label}`} onClick={() => run({ upload: true })} />;
  } else {
    const c = mintCard(view.id);
    if (!c) return null;
    const Icon = ICONS[c.icon];
    const uses = usesOf(c);
    const main = primary(c);
    const svc = cardService(c);
    const linkable = MINT_SOURCES.filter((s) => s.link);
    const uploadOnly = MINT_SOURCES.filter((s) => !s.link).map((s) => s.label);
    body = (
      <>
        {svc ? (
          <ServiceHero c={c} s={svc} openSite={openSite} />
        ) : (
          <>
            <Art tint={c.tint} height={150} badge={<Badge live={!c.soon} />}>
              <span
                className="grid h-[76px] w-[76px] place-items-center rounded-[22px]"
                style={{
                  background: 'rgba(0,0,0,0.35)',
                  color: c.id === 'upload' ? BLUE : GOLD,
                  boxShadow: '0 0 50px rgba(245,184,0,0.25)',
                }}
              >
                <Icon size={40} />
              </span>
            </Art>
            <BrandStrip brands={c.brands} openSite={openSite} />
          </>
        )}
        <h2 className={`mb-1.5 ${svc ? 'mt-0' : 'mt-4'} text-2xl font-bold leading-tight`}>{c.title}</h2>
        <p className="m-0 mb-3.5 text-[15px] leading-[1.45]" style={{ color: '#c9ccd2' }}>
          {c.pitch}
        </p>
        {MINT_PREVIEWS_ENABLED && c.id === 'link' && (
          <>
            <SubTitle>Apps you can link ({linkable.length})</SubTitle>
            <AppGrid>
              {linkable.map((s) => (
                <AppButton key={s.id} id={s.id} onClick={() => push({ k: 'app', id: s.id })} />
              ))}
            </AppGrid>
            <Fine>
              These apps let you sign in and share your posts with another app. The rest ({uploadOnly.join(', ')}) only
              offer a download: use Your archive.
            </Fine>
          </>
        )}
        {c.id === 'upload' && (
          <>
            <SubTitle>Every app with a download ({MINT_SOURCES.length})</SubTitle>
            <AppGrid>
              {MINT_SOURCES.map((s) => (
                <AppButton key={s.id} id={s.id} onClick={() => push({ k: 'app', id: s.id })} />
              ))}
            </AppGrid>
            <Fine>Tap an app for its download steps. Any other app that gives you a data download works too.</Fine>
          </>
        )}
        {uses.length > 0 && (
          <>
            <SubTitle>What do you want to do?</SubTitle>
            <div className="mb-4 grid gap-2">
              {uses.map((u) =>
                isSoon(u.action) ? (
                  <UseRow key={u.id} title={u.title} sub={u.sub} badge={NOT_OPEN} />
                ) : (
                  <UseRow key={u.id} title={u.title} sub={u.sub} onClick={() => run(u.action)} accent={svc?.accent} />
                ),
              )}
            </div>
          </>
        )}
        <SubTitle>Why mint it</SubTitle>
        <Bullets items={c.why} />
        {MINT_PREVIEWS_ENABLED && !!c.later?.length && (
          <>
            <SubTitle>{NOT_OPEN}</SubTitle>
            <Bullets dim items={c.later} />
          </>
        )}
        <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Fact label="Who sees it" text={c.facts.who} />
          <Fact label="What it costs" text={c.facts.cost} />
          <Fact label="Where it lives" text={c.facts.where} />
        </div>
      </>
    );
    foot = main ? (
      <Foot back={back} label={main.label} onClick={() => run(main.action)} s={svc} />
    ) : (
      <Foot back={back} label={NOT_OPEN} s={svc} />
    );
  }

  return (
    <>
      <div
        // Remount per view so each card starts at the top.
        key={view.k === 'card' || view.k === 'app' ? `${view.k}:${view.id}` : view.k}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-5 pt-4"
        style={foot ? undefined : { paddingBottom: 'calc(20px + env(safe-area-inset-bottom))' }}
      >
        {body}
      </div>
      {foot}
    </>
  );
};

const SectionTitle = ({
  children,
  brand,
  openSite,
}: {
  children: React.ReactNode;
  brand?: MintBrand;
  openSite?: (name: string, url: string) => void;
}) => (
  <div className="mb-2.5 mt-[22px] flex items-center justify-between gap-2">
    <h3 className="m-0 text-[11px] font-bold uppercase" style={{ color: MUTED, letterSpacing: '0.12em' }}>
      {children}
    </h3>
    {brand && <BrandRow b={brand} openSite={openSite} size={13} />}
  </div>
);

/**
 * A service name in our wordmark style (owner, 1 Nov 2026; as bWallet<X> in the wallet's own header): lowercase b,
 * gold final X on the b*X names. Other names (OpNS, bTrust) are drawn plain; a trailing word ("Exchange") stays white.
 */
const Wordmark = ({ name }: { name: string }) => {
  const [head, ...rest] = name.split(' ');
  const x = /^b[A-Z]\w*X$/.test(head);
  return (
    <span className="whitespace-nowrap font-extrabold tracking-tight" style={{ color: INK }}>
      {x ? head.slice(0, -1) : head}
      {x && <span style={{ color: GOLD }}>X</span>}
      {rest.length > 0 && <span className="font-bold"> {rest.join(' ')}</span>}
    </span>
  );
};

/**
 * One brand: the wordmark, what it is for, and (bWalletX only) its domain, tapping through to the site. In a store
 * build `site` is never set and `openSite` is not passed, so it is a plain label with no link.
 */
const BrandChip = ({
  b,
  openSite,
  small,
}: {
  b: MintBrand;
  openSite?: (name: string, url: string) => void;
  small?: boolean;
}) => {
  // Folds to '' in a store build, so the bundle has no outbound link code at all.
  const link = !STORE_BUILD && b.site && openSite ? `https://${b.site}` : '';
  const body = (
    <>
      <Wordmark name={b.name} />
      {b.role && !small && <span style={{ color: MUTED }}>&nbsp;{b.role}</span>}
      {link && (
        <>
          <span style={{ color: DIM }}>&nbsp;·&nbsp;</span>
          <span style={{ color: MUTED }}>{b.site}</span>
          <ExternalLink size={small ? 10 : 12} className="ml-1 flex-none" color={DIM} />
        </>
      )}
    </>
  );
  const cls = `inline-flex min-w-0 items-center rounded-full border ${small ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-[13px]'}`;
  const style = { borderColor: BORDER, background: 'rgba(245,184,0,0.06)' };
  return link ? (
    <button
      type="button"
      onClick={() => openSite!(b.name, link)}
      aria-label={`Open ${b.name}`}
      className={`${cls} cursor-pointer`}
      style={style}
    >
      {body}
    </button>
  ) : (
    <span className={cls} style={style}>
      {body}
    </span>
  );
};

/** The services a card belongs to, right under its art. */
const BrandStrip = ({ brands, openSite }: { brands?: MintBrand[]; openSite?: (name: string, url: string) => void }) =>
  brands?.length ? (
    <div className="mt-3 flex flex-wrap gap-2">
      {brands.map((b) =>
        serviceStyle(b.name) ? (
          <BrandRow key={b.name} b={b} openSite={openSite} size={22} />
        ) : (
          <BrandChip key={b.name} b={b} openSite={openSite} />
        ),
      )}
    </div>
  ) : null;

const SubTitle = ({ children }: { children: React.ReactNode }) => (
  <h4 className="mb-2 mt-4 text-[13px] font-semibold" style={{ color: '#e6e2d8' }}>
    {children}
  </h4>
);

const Fine = ({ children }: { children: React.ReactNode }) => (
  <p className="m-0 mt-2 text-[11px] leading-snug" style={{ color: DIM }}>
    {children}
  </p>
);

/** Every tile on the sheet is this one size: two across on a phone, four across from 640px. */
const TileGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{children}</div>
);

const AppGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-4 gap-x-1 gap-y-2 sm:grid-cols-8">{children}</div>
);

const Badge = ({ live, big }: { live: boolean; big?: boolean }) =>
  live || NOT_OPEN ? (
    <span
      className={`whitespace-nowrap rounded-full text-[10px] font-bold leading-[1.45] ${big ? 'px-2 py-[3px]' : 'px-[7px] py-[2px]'}`}
      style={
        live ? { background: '#0f2a1b', color: '#3ddc84' } : { background: 'rgba(255,255,255,0.08)', color: MUTED }
      }
    >
      {live ? 'LIVE' : NOT_OPEN.toUpperCase()}
    </span>
  ) : null;

const Tile = ({ c, onClick }: { c: MintCard; onClick: () => void }) => {
  const Icon = ICONS[c.icon];
  const svc = cardService(c);
  const label = !!c.brands?.length && !svc;
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex h-[140px] min-w-0 flex-col items-start overflow-hidden rounded-[16px] border p-3 text-left cursor-pointer transition-transform hover:-translate-y-0.5"
      style={{ borderColor: BORDER, background: PANEL, color: INK }}
    >
      <span className="absolute right-2.5 top-2.5">
        <Badge live={!c.soon} />
      </span>
      <span className="flex h-[22px] items-center" style={{ color: svc?.accent ?? GOLD }}>
        <Icon size={22} strokeWidth={1.8} />
      </span>
      <span className="mt-2 line-clamp-2 text-[15px] font-bold leading-[1.3]">{c.title}</span>
      <span className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px]" style={{ color: MUTED }}>
        {c.sub}
      </span>
      {svc && (
        <span className="mt-auto flex gap-2 overflow-hidden">
          {c.brands!.map((b) => {
            const st = serviceStyle(b.name);
            return st ? <Lockup key={b.name} s={st} size={13} /> : null;
          })}
        </span>
      )}
      {label && (
        <span className="mt-auto w-full overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-[1.3]">
          {c.brands!.map((b, i) => (
            <span key={b.name}>
              {i > 0 && <span style={{ color: DIM }}> · </span>}
              <Wordmark name={b.name} />
            </span>
          ))}
        </span>
      )}
    </button>
  );
};

/** The first of our services a card belongs to (its look), if any. */
const cardService = (c: MintCard): ServiceStyle | undefined =>
  c.brands?.map((b) => serviceStyle(b.name)).find((x): x is ServiceStyle => !!x);

/**
 * One of our services as its site sets it: logo lockup, what it is for, and (bWalletX only) its domain, tapping
 * through to the site. A store build has no `site` and passes no opener, and the link branch folds away.
 */
const BrandRow = ({
  b,
  openSite,
  size,
}: {
  b: MintBrand;
  openSite?: (name: string, url: string) => void;
  size: number;
}) => {
  const st = serviceStyle(b.name);
  if (!st) return <BrandChip b={b} openSite={openSite} small={size < 18} />;
  // Folds to '' in a store build, so the bundle has no outbound link code at all.
  const link = !STORE_BUILD && b.site && openSite ? `https://${b.site}` : '';
  const small = size < 18;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <Lockup s={st} size={size} />
      {link && (
        <button
          type="button"
          onClick={() => openSite!(b.name, link)}
          aria-label={`Open ${b.name}`}
          className="inline-flex items-center gap-1 border-0 bg-transparent p-0 cursor-pointer"
          style={{ color: MUTED, fontSize: small ? 11 : 13 }}
        >
          {b.site}
        </button>
      )}
    </div>
  );
};

/**
 * A card's top when it belongs to our services (approved mock): the lockup at 22px, its domain and LIVE, then a blank
 * example of the user's own item for that service (ServiceBrand.tsx), never anything of ours.
 */
const ServiceHero = ({
  c,
  s,
  openSite,
}: {
  c: MintCard;
  s: ServiceStyle;
  openSite?: (name: string, url: string) => void;
}) => (
  <>
    <div className={`mb-3 flex justify-between gap-2.5 ${c.brands!.length > 1 ? 'items-start' : 'items-center'}`}>
      <div className="grid min-w-0 gap-2">
        {c.brands!.map((b) => (
          <BrandRow key={b.name} b={b} openSite={openSite} size={22} />
        ))}
      </div>
      <span className="flex-none">
        <Badge live={!c.soon} big />
      </span>
    </div>
    <ServiceExample id={c.id} s={s} />
  </>
);

const AppButton = ({ id, onClick }: { id: MintSourceId; onClick: () => void }) => {
  const s = mintSource(id)!;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Mint your ${s.label}`}
      className="flex min-w-0 flex-col items-center gap-1.5 border-0 bg-transparent px-0 py-1 cursor-pointer"
      style={{ color: '#ccc' }}
    >
      <span
        className="flex h-[46px] w-[46px] items-center justify-center rounded-[13px]"
        style={{
          background: 'linear-gradient(160deg, #1d1d20, #121214)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <BrandMark id={id} size={24} />
      </span>
      <span className="h-6 text-center text-[11px] leading-[1.1]">{s.label}</span>
    </button>
  );
};

const Art = ({
  tint,
  height,
  badge,
  children,
}: {
  tint: string;
  height: number;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div
    className="relative grid place-items-center overflow-hidden rounded-[18px] border"
    style={{
      height,
      background: `radial-gradient(120% 80% at 80% 0%, ${tint}, transparent 60%), #0d0f13`,
      borderColor: EDGE,
    }}
  >
    {badge && <span className="absolute right-3 top-3">{badge}</span>}
    {children}
  </div>
);

const UseRow = ({
  title,
  sub,
  badge,
  live,
  onClick,
  accent,
}: {
  title: string;
  sub: string;
  /** A grey status chip (not open yet / download only). */
  badge?: string;
  /** A green Live chip. */
  live?: boolean;
  onClick?: () => void;
  /** The card's service accent (its chevron). */
  accent?: string;
}) => (
  <button
    type="button"
    disabled={!onClick}
    onClick={onClick}
    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-[14px] border bg-transparent px-3.5 py-3 text-left"
    style={{
      borderColor: BORDER,
      color: INK,
      cursor: onClick ? 'pointer' : 'default',
      opacity: onClick ? 1 : 0.62,
    }}
  >
    <span className="flex min-w-0 flex-wrap items-center gap-2 text-[15px]">
      {title}
      {live && <Badge live />}
      {badge && (
        <span
          className="whitespace-nowrap rounded-full px-[7px] py-[2px] text-[10px] font-bold uppercase leading-[1.45]"
          style={{ background: 'rgba(255,255,255,0.08)', color: MUTED }}
        >
          {badge}
        </span>
      )}
    </span>
    <span className="col-start-1 text-[13px] leading-snug" style={{ color: MUTED }}>
      {sub}
    </span>
    <span className="col-start-2 row-span-2 row-start-1 text-[18px]" style={{ color: accent ?? GOLD }}>
      {onClick && <ChevronRight size={18} />}
    </span>
  </button>
);

const Bullets = ({ items, dim }: { items: string[]; dim?: boolean }) => (
  <ul className="m-0 mb-4 grid list-none gap-1.5 p-0">
    {items.map((w) => (
      <li key={w} className="flex gap-2.5 text-[13.5px] leading-snug" style={{ color: dim ? DIM : '#dcd8cd' }}>
        <span className="mt-[7px] block h-1.5 w-1.5 flex-none rounded-full" style={{ background: dim ? DIM : GOLD }} />
        {w}
      </li>
    ))}
  </ul>
);

const Fact = ({ label, text }: { label: string; text: string }) => (
  <div className="rounded-xl border px-3 py-2.5" style={{ background: PANEL2, borderColor: EDGE }}>
    <small className="mb-1 block text-[10px] font-semibold uppercase" style={{ color: DIM, letterSpacing: '0.08em' }}>
      {label}
    </small>
    <span className="block text-[12.5px] leading-snug" style={{ color: '#d6d2c7' }}>
      {text}
    </span>
  </div>
);

const Foot = ({
  back,
  label,
  onClick,
  s,
}: {
  back: () => void;
  label: string;
  onClick?: () => void;
  /** The card's service: its accent on the main button. */
  s?: ServiceStyle;
}) => (
  <div
    className="flex flex-none gap-2 border-t px-4 pt-3"
    style={{ borderColor: EDGE, paddingBottom: 'calc(14px + env(safe-area-inset-bottom))' }}
  >
    <button
      type="button"
      onClick={back}
      className="h-[46px] flex-none rounded-full border bg-transparent px-[18px] text-[15px] font-bold cursor-pointer"
      style={{ borderColor: EDGE, color: INK }}
    >
      Back
    </button>
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className="h-[46px] min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border-0 px-3 text-[15px] font-bold"
      style={{
        background: s ? s.accent : 'linear-gradient(180deg, #ffe58a, #ffd24d 55%, #e0a800)',
        color: s ? s.onAccent : '#1a1400',
        opacity: onClick ? 1 : 0.45,
        cursor: onClick ? 'pointer' : 'not-allowed',
      }}
    >
      {label}
    </button>
  </div>
);
