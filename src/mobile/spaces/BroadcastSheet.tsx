import { ExternalLink, MonitorUp, X } from 'lucide-react';
import { STORE_BUILD } from '../storeBuild';
import { studioRoomParam } from './broadcast';

/**
 * Broadcast (host and speakers): send a tab or screen into the Space, or open bTV: AIVJ's studio
 * (aivj.website) whose "Go live" publishes the mixer into this Space. Phones cannot capture a tab,
 * so there only the studio option shows, with a note. The studio link is bWalletX only: bTV: AIVJ
 * sells viewing minutes on its own site, which the store editions do not link to.
 */
const MUTED = '#8a8f98';
const GOLD = 'var(--bw-accent-hi)';

export const BroadcastSheet = ({
  canShare,
  ticker,
  profileUrl,
  onShare,
  onClose,
}: {
  canShare: boolean;
  ticker: string;
  profileUrl: string;
  onShare: () => void;
  onClose: () => void;
}) => (
  <div
    className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-3 sm:items-center"
    role="dialog"
    aria-label="Broadcast"
    onClick={onClose}
  >
    <div
      className="w-full max-w-sm rounded-3xl p-5"
      style={{ background: '#0B0A08', border: '1px solid #F5C54240' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold text-white">Broadcast</h2>
        <button aria-label="Close" onClick={onClose} className="p-1">
          <X size={18} color="#fff" />
        </button>
      </div>
      <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
        Everyone in the Space sees it large, above the speakers. It also plays pinned on your bChatX profile.
      </p>
      {canShare ? (
        <button
          onClick={onShare}
          className="mt-4 flex w-full items-center gap-3 rounded-2xl p-3 text-left"
          style={{ background: GOLD, color: '#010101' }}
        >
          <MonitorUp size={22} />
          <span>
            <span className="block font-bold">Share a tab or screen</span>
            <span className="block text-[12px]">Pick your AV mixer tab and tick &ldquo;Share tab audio&rdquo;.</span>
          </span>
        </button>
      ) : (
        <p className="mt-4 rounded-2xl p-3 text-[13px]" style={{ border: '1px solid #ffffff2a', color: MUTED }}>
          This device can&rsquo;t share a tab. Use bWalletX in Chrome on a computer, or open the studio.
        </p>
      )}
      {!STORE_BUILD && (
        <a
          href={`https://aivj.website/studio?room=${studioRoomParam(ticker)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className="mt-2 flex w-full items-center gap-3 rounded-2xl p-3 text-white"
          style={{ border: '1px solid #ffffff2a' }}
        >
          <ExternalLink size={20} />
          <span>
            <span className="block font-bold">Open AIVJ (aivj.website)</span>
            <span className="block text-[12px]" style={{ color: MUTED }}>
              bTV: AIVJ studio. &ldquo;Go live&rdquo; sends the mixer into this Space.
            </span>
          </span>
        </a>
      )}
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 block text-center text-[12px] underline"
        style={{ color: MUTED }}
      >
        Watch where it plays: {profileUrl.replace('https://www.', '')}
      </a>
    </div>
  </div>
);
