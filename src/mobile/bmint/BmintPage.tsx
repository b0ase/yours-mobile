import { lazy, Suspense } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { BMINT_NOTES_ENABLED } from '../storeBuild';
import mintMark from './assets/logos/mint-stamp.svg';
import './bmint.css';

/**
 * bMint (/m/bmint, Desktop and web): the design-and-mint tools ported from The Bitcoin Corporation
 * Mint (bcorp-mint). Phase 1 is Notes; OpNS names (/m/bmint/opns) is a sibling built separately.
 * See docs/BMINT-PORT-PLAN.md. Notes is never in a store build, not even as code (BMINT_NOTES_ENABLED).
 */
const NotesPage = BMINT_NOTES_ENABLED ? lazy(() => import('./notes/NotesPage')) : null;

// OpNS names (names/OpnsMintPage.tsx, its own chunk) renders inside the shell at /m/bmint/opns.
const OpnsMintPage = lazy(() => import('../names/OpnsMintPage'));

const BASE = '/m/bmint';

/** Gold rosette art for the Notes tile (drawn, so no picture loads on the landing page). */
const rosette = (() => {
  const paths: string[] = [];
  for (let r = 0; r < 14; r++) {
    const pts: string[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * Math.PI * 2;
      const rad = 60 + r * 7 + 10 * Math.sin(12 * t + r * 0.4);
      pts.push(`${(200 + rad * Math.cos(t)).toFixed(1)},${(120 + rad * Math.sin(t)).toFixed(1)}`);
    }
    paths.push(
      `<polyline points="${pts.join(' ')}" fill="none" stroke="%23c9a84c" stroke-opacity="0.55" stroke-width="0.7"/>`,
    );
  }
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 240'>${paths.join('').replace(/"/g, "'")}</svg>")`;
})();

const Tab = ({ to, children, end }: { to: string; children: string; end?: boolean }) => (
  <NavLink to={to} end={end} className={({ isActive }) => `bm-tab${isActive ? ' active' : ''}`}>
    {children}
  </NavLink>
);

const Landing = () => (
  <div className="bm-body">
    <div className="bm-hero">
      <span className="bm-chip">bMint</span>
      <h1>
        Design it. <span>Mint it.</span>
      </h1>
      <p>Make notes, names and more in your browser, then mint them to your wallet with one approval.</p>
    </div>
    <div className="bm-tiles">
      {NotesPage && (
        <Link to={`${BASE}/notes`} className="bm-tile">
          <span className="bm-tile-art" style={{ backgroundImage: rosette, opacity: 1 }} />
          <span className="bm-chip">Notes</span>
          <h2>Note designer</h2>
          <p>Guilloche, rosettes, microprint and serials. Export PNG or SVG, or mint as an NFT.</p>
        </Link>
      )}
      <Link to={`${BASE}/opns`} className="bm-tile">
        <span
          className="bm-tile-art"
          style={{
            backgroundImage: `url(${mintMark})`,
            backgroundSize: '55%',
            backgroundRepeat: 'no-repeat',
            opacity: 0.25,
          }}
        />
        <span className="bm-chip">Names</span>
        <h2>OpNS names</h2>
        <p>Mint on-chain names that point at your identity.</p>
      </Link>
    </div>
  </div>
);

export const BmintPage = () => (
  <div className="bmint">
    <header className="bm-head">
      <Link to={BASE} className="bm-brand">
        <img src={mintMark} alt="" />
        <span>
          b<b>Mint</b>
        </span>
      </Link>
      <nav className="bm-tabs" aria-label="bMint">
        {NotesPage && <Tab to={`${BASE}/notes`}>Notes</Tab>}
        <Tab to={`${BASE}/opns`}>OpNS names</Tab>
      </nav>
    </header>
    <Suspense fallback={<div className="bm-body bm-msg">Loading…</div>}>
      <Routes>
        {NotesPage && <Route path="notes" element={<NotesPage />} />}
        <Route path="opns" element={<OpnsMintPage />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </Suspense>
  </div>
);

export default BmintPage;
