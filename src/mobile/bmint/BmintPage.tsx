import { lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { setAgentDraft } from '../agent/handoff';
import { mintTilesShown, MintSheet } from '../mint/MintButton';
import { HandleFlow } from '../names/HandleFlow';
import { BMINT_NOTES_ENABLED, MARKET_ENABLED, RELEASES_ENABLED, STORE_BUILD } from '../storeBuild';
import { isStudioOwner } from './lib/studioAccess';
import mintMark from './assets/logos/mint-stamp.svg';
import { HubArt } from './HubArt';
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
 *   OpNS names → /m/bmint/opns. Notes (BMINT_NOTES_ENABLED) → /m/bmint/notes.
 */
const useHub = (owner: boolean) => {
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
  const identity: HubTile[] = [
    {
      id: 'opns',
      title: 'OpNS names',
      sub: 'On-chain names that point at you',
      to: `${BASE}/opns`,
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
  return [
    { title: 'Make', tiles: make },
    { title: 'Studio', tiles: studio },
    { title: 'Names & identity', tiles: identity },
    { title: 'With b', tiles: withB },
  ].filter((g) => g.tiles.length);
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

const Landing = ({ owner }: { owner: boolean }) => {
  const groups = useHub(owner);
  return (
    <div className="bm-body">
      <div className="bm-hero">
        <span className="bm-chip">bMint</span>
        <h1>
          The <span>Mint</span>
        </h1>
        <p>Everything you can mint, in one place. Whatever you make is yours on chain: keep it, send it or sell it.</p>
      </div>
      {groups.map((g) => (
        <section key={g.title} className="bm-group" aria-label={g.title}>
          <h2 className="bm-group-title">{g.title}</h2>
          <div className="bm-types">
            {g.tiles.map((t) => (
              <TypeTile key={t.id} t={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

/** /m/bmint/mint/<type>: the existing flow for that type, over the hub. Closing returns to the hub. */
const MintOpen = ({ owner }: { owner: boolean }) => {
  const { type = '' } = useParams();
  const navigate = useNavigate();
  const close = () => navigate(BASE, { replace: true });
  const flow =
    type === 'bavatar' ? (
      <BavatarMintSheet onClose={close} />
    ) : type === 'handle' && !STORE_BUILD ? (
      <HandleFlow onClose={close} />
    ) : (
      <MintSheet exchangeRate={0} start={type} onClose={close} />
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

export const BmintPage = () => {
  const owner = useOwner();
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
          {Notes && <Tab to={`${BASE}/notes`}>Notes</Tab>}
          <Tab to={`${BASE}/opns`}>OpNS names</Tab>
          {OpnsStorePage && <Tab to={`${BASE}/store`}>Name store</Tab>}
        </nav>
      </header>
      <Suspense fallback={<div className="bm-body bm-msg">Loading…</div>}>
        <Routes>
          {Notes && <Route path="notes" element={<Notes />} />}
          <Route path="opns" element={<OpnsMintPage />} />
          {OpnsStorePage && <Route path="store" element={<OpnsStorePage />} />}
          <Route path="mint/:type" element={<MintOpen owner={owner} />} />
          <Route path="*" element={<Landing owner={owner} />} />
        </Routes>
      </Suspense>
    </div>
  );
};

export default BmintPage;
