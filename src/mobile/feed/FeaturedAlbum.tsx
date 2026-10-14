import { Play } from 'lucide-react';
import { openBapp } from '../bappFrame/bappFrame';
import { SHARE_ALBUMS, albumPublicPath } from '../media/shareAlbums';
import vexvoidCover from '../media/featured/vexvoid-cover.jpg';

const DESKTOP = 'https://desktop.bwalletx.com';
/** Covers for the featured albums (square, bundled). */
const COVERS: Record<string, string> = { 'first-12': vexvoidCover };

/**
 * bMusic feed (bWalletX): the featured album stays at the top as one compact banner card, then the bMusic reel
 * below it (owner, 14 Oct 2026). A card, not a reel slide, so the reel still mounts only its one video player.
 * Tapping opens the album in bMusic, as the album row did before the reel.
 */
export const FeaturedAlbum = ({ color }: { color: string }) => {
  const a = SHARE_ALBUMS[0];
  if (!a) return null;
  const open = () => void openBapp('bMusic', `${DESKTOP}${albumPublicPath(a)}`);
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Featured: ${a.title} by ${a.artist}. Play in bMusic`}
      className="mx-4 mb-2 mt-2 flex items-center gap-3 rounded-2xl p-2.5 text-left active:opacity-80"
      style={{ background: '#0d0d0f', border: `1px solid ${color}` }}
    >
      {COVERS[a.id] && (
        <img src={COVERS[a.id]} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" draggable={false} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
          Featured
        </span>
        <span className="block truncate text-sm font-bold text-white">{a.title}</span>
        <span className="block truncate text-xs" style={{ color: '#8a8f98' }}>
          {a.artist}
        </span>
      </span>
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: color, color: '#010101' }}
        aria-hidden="true"
      >
        <Play size={18} fill="currentColor" />
      </span>
    </button>
  );
};
