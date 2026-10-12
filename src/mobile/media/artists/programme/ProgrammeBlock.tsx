import { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GuestCtx } from '../guestCtx';
import { getArtistPublic, type ArtistPublic } from './api';

const GOLD = '#FFD24D';
const MUTED = '#98A2B3';

/**
 * Artist page extras from the artist programme (docs/ARTIST-PROGRAMME.md): "Free to listen — sponsored by
 * bWalletX", the Founding artist badge, and fans who lock BSV behind the artist. Renders nothing until the bMusic
 * server answers (its programme routes are off by default).
 */
export const ProgrammeBlock = ({ slug }: { slug: string }) => {
  const navigate = useNavigate();
  const guest = useContext(GuestCtx);
  const [p, setP] = useState<ArtistPublic | null>(null);
  useEffect(() => {
    void getArtistPublic(slug).then((r) => setP(r.ok ? r.data : null));
  }, [slug]);
  if (!p) return null;
  return (
    <div className="mt-6">
      {p.founding && (
        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold text-black" style={{ background: GOLD }}>
          Founding artist
        </span>
      )}
      {p.sponsoredBy === 'bwalletx' && p.sponsoredPlaysLeft > 0 && (
        <div className="mt-2 font-semibold" style={{ color: GOLD }}>
          Free to listen — sponsored by bWalletX
        </div>
      )}
      <h3 className="mt-5 text-xl font-bold">Backers</h3>
      <p className="text-[13px] mt-1" style={{ color: MUTED }}>
        Fans who lock BSV behind this artist: your BSV, held until a date, then back to you.
      </p>
      <ol className="mt-2">
        {p.backers.slice(0, 20).map((b, i) => (
          <li key={i} className="flex gap-3 py-1.5 text-sm border-b" style={{ borderColor: '#222' }}>
            <span className="flex-1 truncate">{b.name.slice(0, 32)}</span>
            {b.earlyBacker && (
              <span className="text-[11px] font-bold uppercase" style={{ color: GOLD }}>
                Early backer
              </span>
            )}
            <span style={{ color: '#777' }}>{b.daysLeft} days left</span>
          </li>
        ))}
      </ol>
      {!guest && (
        <button
          onClick={() => navigate(`/m/lock/locks?artist=${encodeURIComponent(slug)}`)}
          className="mt-3 px-5 py-2 rounded-full font-bold text-black"
          style={{ background: GOLD }}
        >
          Back this artist
        </button>
      )}
    </div>
  );
};
