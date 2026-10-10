/**
 * A Space opened from a link (inviteLinks.ts → /m/spaces?invite=<code> or ?space=<slug>). Shows the
 * public card from bit-sign, then either Join (you are in the room) or the entry requirement with
 * the ways in: Pay at the door (DoorButton: pay the host, the host's phone sends a ticket), open the token's
 * room (a holder is admitted there) and Buy in the Market.
 * An expired, revoked or used-up invite says so and offers the permanent Space page.
 */
import { useEffect, useState } from 'react';
import { Radio, X } from 'lucide-react';
import { ChatApiError, type BchatClient } from '../chat/api';
import { BuyTokenButton, OpenTokenRoomButton } from '../chat/OpenTokenRoomButton';
import { parseSpaceState } from './model';
import { parsePage, parseSpaceInvite, type SpacePage } from './invite';
import { DoorButton } from './DoorButton';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

type Access = 'checking' | 'member' | 'locked' | 'signed-out';

export type SpaceLink = { kind: 'invite'; code: string } | { kind: 'space'; slug: string };

export const InviteCard = ({
  client,
  link,
  me,
  onJoin,
  onOpenSpacePage,
  onClose,
}: {
  client: BchatClient;
  link: SpaceLink;
  me: string;
  onJoin: (inv: SpacePage) => void;
  onOpenSpacePage: (slug: string) => void;
  onClose: () => void;
}) => {
  const [inv, setInv] = useState<SpacePage | null>(null);
  const [expired, setExpired] = useState<SpacePage | null>(null);
  const [error, setError] = useState('');
  const [access, setAccess] = useState<Access>('checking');
  const linkKey = link.kind === 'invite' ? `i:${link.code}` : `s:${link.slug}`;

  useEffect(() => {
    let live = true;
    setInv(null);
    setExpired(null);
    setError('');
    setAccess('checking');
    (async () => {
      try {
        let got: SpacePage | null = null;
        if (link.kind === 'invite') {
          // Opening counts one use (once per visitor); the server answers the state after it.
          const i = parseSpaceInvite(await client.openInvite(link.code));
          if (i && i.target.kind === 'space') {
            if (i.state !== 'ok') {
              if (live) setExpired(i.target);
              return;
            }
            got = i.target;
          }
        } else {
          const p = parsePage(await client.spacePage(link.slug));
          got = p?.kind === 'space' ? p : null;
        }
        if (!live) return;
        if (!got) throw new Error('This invite isn’t available.');
        setInv(got);
        if (!client.handle) return setAccess('signed-out');
        try {
          parseSpaceState(await client.space(got.ticker), me);
          if (live) setAccess('member');
        } catch (e) {
          if (live)
            setAccess(e instanceof ChatApiError && (e.status === 403 || e.status === 402) ? 'locked' : 'member');
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof ChatApiError && e.status === 404
              ? 'This invite isn’t available.'
              : String((e as Error)?.message ?? e),
          );
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- linkKey stands for link
  }, [client, linkKey, me]);

  return (
    <div className="mx-4 mt-4 rounded-2xl p-4" style={{ border: `1px solid ${GOLD}`, background: '#0b0b0d' }}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
            {link.kind === 'invite' ? 'Invite' : 'Space'}
          </div>
          {inv ? (
            <>
              <div className="mt-1 flex items-center gap-2">
                {inv.live && (
                  <span className="rounded px-1.5 py-[1px] text-[10px] font-bold" style={{ background: '#D92D20' }}>
                    LIVE
                  </span>
                )}
                <span className="font-semibold truncate">{inv.title}</span>
              </div>
              <div className="text-xs mt-0.5 truncate" style={{ color: MUTED }}>
                {inv.host ? `$${inv.host} · ` : ''}
                {inv.roomName}
                {inv.live ? '' : ` · ${inv.statusLine}`}
              </div>
              <div className="mt-3 text-sm font-semibold" style={{ color: GOLD }}>
                {inv.entry.line}
              </div>
            </>
          ) : (
            !error && !expired && <Radio size={20} color={GOLD} className="mt-2 animate-pulse" />
          )}
          {expired && (
            <>
              <div className="mt-1 font-semibold">This invite has expired</div>
              <div className="text-xs mt-0.5 truncate" style={{ color: MUTED }}>
                Space: {expired.title}
              </div>
              <button
                onClick={() => onOpenSpacePage(expired.slug)}
                className="mt-3 w-full h-10 rounded-xl text-sm font-semibold"
                style={{ border: `1px solid ${GOLD}`, color: GOLD }}
              >
                See the Space page
              </button>
            </>
          )}
          {error && (
            <div className="flex flex-col gap-1.5">
              <p className="mt-2 text-sm">{error}</p>
              <ErrorActions message={String(error)} />
            </div>
          )}
        </div>
        <button onClick={onClose} className="p-1" aria-label="Dismiss invite">
          <X size={18} color={MUTED} />
        </button>
      </div>

      {inv && access === 'member' && inv.live && (
        <button
          onClick={() => onJoin(inv)}
          className="mt-4 w-full h-11 rounded-xl font-bold"
          style={{ background: GOLD, color: '#010101' }}
        >
          Join
        </button>
      )}
      {inv && access === 'member' && !inv.live && (
        <p className="mt-3 text-xs" style={{ color: MUTED }}>
          You’re in this room. Come back when it goes live.
        </p>
      )}
      {inv && access === 'locked' && (
        <div className="mt-3" style={{ borderTop: `1px solid ${LINE}` }}>
          <p className="pt-3 text-xs" style={{ color: MUTED }}>
            {inv.gate
              ? `You need ${inv.entry.kind === 'token' ? `${inv.entry.amount} $${inv.entry.symbol}` : 'the room’s token'} to enter. Already hold it? Open the room and you’re let in.`
              : 'This room is members only. Ask the host to add you.'}
          </p>
          {inv.gate?.kind === 'bsv21' && inv.host && inv.entry.kind === 'token' && inv.entry.mode === 'hold' && (
            <DoorButton
              ticker={inv.ticker}
              host={inv.host}
              entryUsd={inv.entry.usd}
              live={inv.live}
              isMember={async () => {
                try {
                  parseSpaceState(await client.space(inv.ticker), me);
                  return true;
                } catch {
                  return false;
                }
              }}
              onAdmitted={() => setAccess('member')}
            />
          )}
          {inv.gate?.id && inv.gate.kind && (
            <div className="mt-3 flex gap-2">
              <BuyTokenButton kind={inv.gate.kind} id={inv.gate.id} />
              <OpenTokenRoomButton kind={inv.gate.kind} id={inv.gate.id} />
            </div>
          )}
        </div>
      )}
      {inv && access === 'signed-out' && (
        <p className="mt-3 text-xs" style={{ color: MUTED }}>
          Open Chat once to sign in to rooms, then open the link again.
        </p>
      )}
    </div>
  );
};
