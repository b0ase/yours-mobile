/**
 * Every bApp's room as a card (bappRooms.ts): icon, name, what it's for, and how to get in. Shown under
 * Chat › bApps and on /chat/bapps (Desktop, web, phone). You see every room whether or not you're a member.
 *
 * Store builds show the rooms but sell no entry (paid entry is a digital sale, storeBuild.ts): a member opens
 * their room; anyone else is pointed at bWalletX. The ticket button and its sheet are a lazy chunk the store
 * bundle never includes.
 */
import { lazy, Suspense } from 'react';
import { ExternalLink } from 'lucide-react';
import { BSPACES_ENABLED } from '../storeBuild';
import { bavatarSvg } from '../bavatar/bavatar';
import { BAPPS, type Bapp } from './bappRooms';

const BappTicketButton = BSPACES_ENABLED ? lazy(() => import('./BappTicketButton')) : null;

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const iconOf = (b: Bapp) =>
  b.icon ?? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(b.ticker, { size: 96 }));

export const BappRoomCards = ({
  me,
  memberTickers,
  onOpen,
  onJoinFree,
  wide = false,
}: {
  me: string | null;
  /** Upper-case tickers of rooms I'm in. */
  memberTickers: ReadonlySet<string>;
  /** Open a room I'm in (after entering, too). */
  onOpen: (b: Bapp) => void;
  /** Walk into a room that is free (bRadio Lounge today). */
  onJoinFree: (b: Bapp) => Promise<void>;
  /** Desktop / tablet: a grid of cards instead of rows. */
  wide?: boolean;
}) => (
  <ul
    className={wide ? 'grid gap-3 px-4 pb-4' : 'w-full'}
    style={wide ? { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } : undefined}
    data-testid="bapp-room-cards"
  >
    {BAPPS.map((b) => {
      const member = memberTickers.has(b.ticker);
      return (
        <li
          key={b.id}
          className={wide ? 'flex items-center gap-3 rounded-2xl p-3' : 'flex items-center gap-3 px-4 py-[10px]'}
          style={wide ? { border: `1px solid ${LINE}`, background: 'rgba(255,255,255,0.02)' } : undefined}
        >
          <button
            type="button"
            onClick={() => member && onOpen(b)}
            className="shrink-0 border-0 p-0 bg-transparent"
            style={{ cursor: member ? 'pointer' : 'default' }}
            aria-label={b.name}
          >
            <img
              src={iconOf(b)}
              alt=""
              className="rounded-2xl object-cover"
              style={{ width: wide ? 56 : 44, height: wide ? 56 : 44, border: `1px solid ${LINE}` }}
            />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-[15px] font-semibold text-white">
              <span className="truncate">{b.name}</span>
              {b.site && (
                <a
                  href={b.site}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0"
                  aria-label={`${b.name} site`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={12} color={MUTED} />
                </a>
              )}
            </div>
            <div className="text-[12px] leading-snug line-clamp-2" style={{ color: MUTED }}>
              {b.purpose}
            </div>
          </div>
          {BappTicketButton ? (
            <Suspense fallback={null}>
              <BappTicketButton
                bapp={b}
                me={me}
                member={member}
                onEnter={() => onOpen(b)}
                onJoinFree={() => onJoinFree(b)}
              />
            </Suspense>
          ) : member ? (
            <button
              type="button"
              onClick={() => onOpen(b)}
              className="rounded-xl px-3 py-1.5 text-xs font-extrabold bg-transparent cursor-pointer"
              style={{ color: GOLD, border: `1px solid ${GOLD}` }}
            >
              Open
            </button>
          ) : (
            <span className="text-[11px] text-right max-w-[110px]" style={{ color: MUTED }}>
              Open in bWalletX
            </span>
          )}
        </li>
      );
    })}
  </ul>
);
