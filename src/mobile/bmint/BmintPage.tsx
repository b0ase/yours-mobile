import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { setAgentDraft } from '../agent/handoff';
import { mintTilesShown, MintSheet } from '../mint/MintButton';
import { canBulkMint } from '../names/bulkAccess';
import { HandleFlow } from '../names/HandleFlow';
import { BMINT_NOTES_ENABLED, MARKET_ENABLED, RELEASES_ENABLED, STORE_BUILD } from '../storeBuild';
import { isStudioOwner } from './lib/studioAccess';
import mintMark from './assets/logos/mint-stamp.svg';
import { HubArt } from './HubArt';
import { takeHandOff } from './lib/drop';
import { useChatHandle } from '../tabs/useTabBadges';
import { DropHero, Vault } from './Studio';
import './bmint.css';

/**
 * bMint (/m/bmint, Desktop and web): the hub for every mint type the wallet has (useHub below), plus the
 * tools ported from The Bitcoin Corporation Mint (bcorp-mint): Notes and OpNS names (/m/bmint/opns).
 * See docs/BMINT-PORT-PLAN.md. Notes is never in a store build, not even as code (BMINT_NOTES_ENABLED).
 * Notes are fixed designs issued only by The Bitcoin Corporation Mint (owner, 13 Oct 2026): the owner
 * (lib/studioAccess.ts allow-list) gets the note studio; everyone else sees the designs as a showcase.
 */
const NotesPage = BMINT_NOTES_ENABLED ? lazy(() => import('./notes/NotesPage')) : null;
const NotesShowcase = BMINT_NOTES_ENABLED ? lazy(() => import('./notes/NotesShowcase')) : null;

// OpNS names (names/OpnsMintPage.tsx, its own chunk) renders inside the shell at /m/bmint/opns.
const OpnsMintPage = lazy(() => import('../names/OpnsMintPage'));
// Name store (/m/bmint/store, public /bmint/store): every OpNS name for sale. bWalletX only (market rules).
const OpnsStorePage = MARKET_ENABLED ? lazy(() => import('../names/OpnsStorePage')) : null;
const BavatarMintSheet = lazy(() => import('../bavatar/BavatarMintSheet'));

const BASE = '/m/bmint';

const Tab = ({ to, children, end }: { to: string; children: string; end?: boolean }) => (
  <NavLink to={to} end={end} className={({ isActive }) => `bm-tab${isActive ? ' active' : ''}`}>
    {children}
  </NavLink>
);

type HubTile = { id: string; title: string; sub: string; to?: string; agent?: string };

/**
 * Every mint type the wallet already has, one tile each, opening the existing flow (owner, 13 Oct 2026):
 *   Mint sheet types (mint/MintButton.tsx MINT_TILES, store gating applied there) → /m/bmint/mint/<id>
 *     (the sheet over this page with that type preselected); its "with b" types open Ask b with the request typed.
 *   bAvatar (bavatar/BavatarMintSheet) and your $handle (names/HandleFlow; paid feature, !STORE_BUILD so the store bundle drops it)
 *     → /m/bmint/mint/bavatar | handle. bPics → /m/bpics. A music release (RELEASES_ENABLED) → /m/media/new.
 *   OpNS names → /m/bmint/opns (agents and the owner only, names/bulkAccess.ts). Notes (BMINT_NOTES_ENABLED) → /m/bmint/notes.
 */
const useHub = (owner: boolean) => {
  const bulk = useBulkMint(owner);
  const sheet = mintTilesShown();
  const make: HubTile[] = sheet.filter((t) => !t.agent).map((t) => ({ ...t, to: `${BASE}/mint/${t.id}` }));
  const withB: HubTile[] = sheet.filter((t) => t.agent);
  const studio: HubTile[] = [
    {
      id: 'bpics',
      title: 'bPics',
      sub: "Mint your photos; browse everyone's",
      to: '/m/bpics',
    },
    ...(RELEASES_ENABLED
      ? [
          {
            id: 'release',
            title: 'A music release',
            sub: 'A single or album, listed in bMusic',
            to: '/m/media/new',
          },
        ]
      : []),
    ...(bulk
      ? [
          {
            id: 'opns',
            title: 'Mint names in bulk',
            sub: 'Drop a list; each name is mined into your wallet',
            to: `${BASE}/opns`,
          },
        ]
      : []),
    ...(NotesPage
      ? [
          {
            id: 'notes',
            title: owner ? 'Note studio' : "The Mint's notes",
            sub: owner ? "Design the Mint's notes" : 'Issued by The Bitcoin Corporation Mint',
            to: `${BASE}/notes`,
          },
        ]
      : []),
  ];
  // Mass market first (owner, 13 Oct 2026): the Name Store is the front door; bulk minting is the maker's tool.
  const identity: HubTile[] = [
    {
      id: 'names',
      title: 'Get your name',
      sub: 'Search, buy or claim a name on Bitcoin. From $1',
      to: '/m/names',
    },
    {
      id: 'bavatar',
      title: 'Your bAvatar',
      sub: 'Your art, $name and number as an ordinal',
      to: `${BASE}/mint/bavatar`,
    },
    ...(!STORE_BUILD
      ? [
          {
            id: 'handle',
            title: 'Your $handle',
            sub: 'Claim a handle; its personal token comes with it',
            to: `${BASE}/mint/handle`,
          },
        ]
      : []),
  ];
  return {
    make,
    more: [
      { title: 'Names & identity', tiles: identity },
      { title: 'Studio', tiles: studio },
      { title: 'With b', tiles: withB },
    ].filter((g) => g.tiles.length),
  };
};

const TypeTile = ({ t }: { t: HubTile }) => {
  const navigate = useNavigate();
  const body = (
    <>
      <HubArt id={t.id} agent={!!t.agent} />
      <span className="bm-type-title">{t.title}</span>
      <span className="bm-type-sub">{t.sub}</span>
    </>
  );
  if (t.agent)
    return (
      <button
        type="button"
        className="bm-type"
        onClick={() => {
          setAgentDraft(t.agent!);
          navigate('/m/ask-b');
        }}
      >
        {body}
      </button>
    );
  return (
    <Link to={t.to!} className="bm-type">
      {body}
    </Link>
  );
};

const Group = ({ title, tiles, compact }: { title: string; tiles: HubTile[]; compact?: boolean }) => (
  <section className="bm-group" aria-label={title}>
    <h2 className="bm-group-title">{title}</h2>
    <div className={`bm-types${compact ? ' compact' : ''}`}>
      {tiles.map((t) => (
        <TypeTile key={t.id} t={t} />
      ))}
    </div>
  </section>
);

/** The account's display name for the preview card and vault ("$you" until it has one). */
const useMinterName = () => {
  const { chromeStorageService } = useServiceContext();
  const handle = useChatHandle();
  const account = chromeStorageService.getCurrentAccountObject()?.account?.name?.trim();
  return handle ? `$${handle.replace(/^\$/, '')}` : account || '$you';
};

/** The studio landing (Studio.tsx): drop zone hero, the types, your vault, then names, studio tools and b. */
const Landing = ({ owner }: { owner: boolean }) => {
  const { make, more } = useHub(owner);
  const name = useMinterName();
  return (
    <div className="bm-body bm-studio">
      <DropHero name={name} />
      {make.length > 0 && <Group title="Or start from a type" tiles={make} compact />}
      <Vault name={name} />
      {more.map((g) => (
        <Group key={g.title} title={g.title} tiles={g.tiles} />
      ))}
      <p className="bm-fine">
        Minting writes your file, a timestamp and your signature to Bitcoin. It proves the file existed at that time and
        was published by your key; it is not a copyright registration. Only mint work you have the right to publish. The
        cost depends on the file size.
      </p>
    </div>
  );
};

/** /m/bmint/mint/<type>: the existing flow for that type, over the hub. Closing returns to the hub. */
const MintOpen = ({ owner }: { owner: boolean }) => {
  const { type = '' } = useParams();
  const navigate = useNavigate();
  // A file dropped on the hero (lib/drop.ts), taken once so a later open starts empty.
  const [file] = useState(takeHandOff);
  const close = () => navigate(BASE, { replace: true });
  const flow =
    type === 'bavatar' ? (
      <BavatarMintSheet onClose={close} />
    ) : type === 'handle' && !STORE_BUILD ? (
      <HandleFlow onClose={close} />
    ) : (
      <MintSheet exchangeRate={0} start={type} file={file} onClose={close} />
    );
  return (
    <>
      <Landing owner={owner} />
      {createPortal(<Suspense fallback={null}>{flow}</Suspense>, document.body)}
    </>
  );
};

const useOwner = () => {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject()?.account;
  return isStudioOwner({
    identityPubKey: account?.pubKeys?.identityPubKey,
    identityAddress: account?.addresses?.identityAddress,
  });
};

/** The bulk OpNS minter: agent accounts, the studio owner and the owner's handle (owner, 14 Oct 2026). */
const useBulkMint = (owner: boolean) => {
  const { chromeStorageService } = useServiceContext();
  return canBulkMint(chromeStorageService.getCurrentAccountObject()?.account?.addresses?.identityAddress, owner);
};

export const BmintPage = () => {
  const owner = useOwner();
  const bulk = useBulkMint(owner);
  const Notes = owner ? NotesPage : NotesShowcase;
  return (
    <div className="bmint">
      <header className="bm-head">
        <Link to={BASE} className="bm-brand">
          <img src={mintMark} alt="" />
          <span>
            b<b>Mint</b>
          </span>
        </Link>
        <nav className="bm-tabs" aria-label="bMint">
          <Tab to={BASE} end>
            Mint
          </Tab>
          {/* The consumer Name Store lives at /names (names/store/); the old order-book list stays at /store. */}
          <Tab to="/m/names">Get a name</Tab>
          {Notes && <Tab to={`${BASE}/notes`}>Notes</Tab>}
          {bulk && <Tab to={`${BASE}/opns`}>Mint names</Tab>}
        </nav>
      </header>
      <Suspense fallback={<div className="bm-body bm-msg">Loading…</div>}>
        <Routes>
          {Notes && <Route path="notes" element={<Notes />} />}
          <Route path="opns" element={bulk ? <OpnsMintPage /> : <Navigate to="/m/names" replace />} />
          {OpnsStorePage && <Route path="store" element={<OpnsStorePage />} />}
          <Route path="mint/:type" element={<MintOpen owner={owner} />} />
          <Route path="*" element={<Landing owner={owner} />} />
        </Routes>
      </Suspense>
    </div>
  );
};

export default BmintPage;
