import { useEffect, useMemo, useState } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { bavatarSvg } from '../../bavatar/bavatar';
import {
  badgeLabel,
  boardState,
  displayName,
  getBoard,
  getMyStats,
  listened,
  myLine,
  optOut,
  setBoardChoice,
  type Board,
  type BoardWindow,
  type MyStats,
} from './board';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#111216';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const WINDOWS: { id: BoardWindow; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: '30d', label: '30 days' },
  { id: '7d', label: '7 days' },
];

const Avatar = ({ seed }: { seed: string }) => {
  const src = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(bavatarSvg(seed, { size: 64 }))}`, [seed]);
  return <img src={src} alt="" className="w-8 h-8 shrink-0" style={{ borderRadius: '50%' }} />;
};

export const Chip = ({ children }: { children: string }) => (
  <span
    className="px-1.5 py-0.5 text-[9px] font-bold uppercase"
    style={{ border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 3 }}
  >
    {children}
  </span>
);

/** "Top listeners" on the album page: public board only (no artist-only data). */
export default function ListenerBoard(p: {
  albumId: string;
  artist: string;
  identityKey: string | null;
  wallet?: Pick<WalletInterface, 'createSignature' | 'getPublicKey'>;
  /** Bumped after a claim so the board and "You" line reload. */
  refresh?: number;
}) {
  const [win, setWin] = useState<BoardWindow>('all');
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<MyStats | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setBoard(null);
    setError(null);
    getBoard(p.albumId, win)
      .then((b) => live && setBoard(b))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    if (p.identityKey)
      getMyStats(p.identityKey, p.albumId)
        .then((x) => live && setMe(x))
        .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [p.albumId, p.identityKey, win, p.refresh, n]);

  const state = boardState(board, error);
  const onBoard = !!me && typeof me.rank === 'number' && me.rank > 0;
  const leave = async () => {
    if (!p.wallet) return;
    try {
      await optOut(p.wallet);
      setBoardChoice(p.artist, 'no');
      setNote(`You're off ${p.artist}'s listener board.`);
      setN((x) => x + 1);
    } catch (e) {
      setNote(`Couldn't opt out: ${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <section
      className="flex flex-col gap-2 p-3"
      style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 6 }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-black text-white">Top listeners</h3>
        <div className="flex">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWin(w.id)}
              aria-pressed={win === w.id}
              className="px-2 py-0.5 text-[11px] font-bold"
              style={{ border: `1px solid ${win === w.id ? GOLD : LINE}`, color: win === w.id ? GOLD : MUTED }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {p.identityKey && (
        <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: onBoard ? GOLD : MUTED }}>
          <span>{myLine(me)}</span>
          {onBoard && p.wallet && (
            <button
              onClick={() => void leave()}
              className="underline-offset-4 hover:underline"
              style={{ color: MUTED }}
            >
              Take me off the board
            </button>
          )}
        </div>
      )}
      {note && (
        <div className="text-xs" style={{ color: MUTED }}>
          {note}
        </div>
      )}
      {state === 'loading' && (
        <div className="text-xs py-2" style={{ color: MUTED }}>
          Loading the board…
        </div>
      )}
      {state === 'error' && (
        <div className="text-xs py-2" style={{ color: MUTED }}>
          The board is unavailable right now.
        </div>
      )}
      {state === 'empty' && (
        <div className="text-xs py-2" style={{ color: MUTED }}>
          No one on the board yet. Listen and opt in to be the first.
        </div>
      )}
      {state === 'list' && (
        <ol className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
          {board!.listeners.map((l) => (
            <li
              key={l.identityKey}
              className="flex items-center gap-2.5 py-1.5"
              style={{ borderBottom: `1px solid ${LINE}` }}
            >
              <span className="w-6 text-xs text-right font-bold" style={{ color: l.rank <= 3 ? GOLD : MUTED }}>
                {l.rank}
              </span>
              <Avatar seed={l.handle?.trim() || l.identityKey} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-white truncate">{displayName(l)}</span>
                <span className="block text-[10px]" style={{ color: MUTED }}>
                  {listened(l.secondsTotal)} · {listened(l.secondsSelfPaid)} self-paid · {listened(l.secondsSponsored)}{' '}
                  sponsored
                </span>
              </span>
              <span className="hidden sm:flex flex-wrap justify-end gap-1 max-w-[50%]">
                {l.badges.map((b) => (
                  <Chip key={b}>{badgeLabel(b)}</Chip>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
      {board && board.anonCount > 0 && (
        <div className="text-[11px]" style={{ color: MUTED }}>
          + {board.anonCount.toLocaleString()} anonymous listener{board.anonCount === 1 ? '' : 's'} ·{' '}
          {listened(board.anonSeconds)}
        </div>
      )}
    </section>
  );
}
