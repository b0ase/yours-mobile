/**
 * bSpaces in a token room: a "Live now" banner with Join when the room has a live space, and for the
 * token's issuer or the room's admin a "Start a bSpace" row when it has none (docs/BSPACES-PLAN.md).
 */
import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from '../chat/api';
import { claimIssuerAdmin, onIssuerClaimed } from '../chat/autoClaim';
import { claimDepsFor } from '../chat/claimDeps';
import { audienceCount, audienceLine, canHostRoom, parseSpaceState, stageOf, type SpaceState } from './model';
import { SpaceScreen } from './SpaceScreen';
import { DoorKeeper } from './DoorKeeper';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const POLL_MS = 20_000;

export const LiveBanner = ({
  client,
  ctx,
  ticker,
  roomName,
  me,
  createdBy,
}: {
  client: BchatClient;
  /** The wallet, for the inline "Claim admin" fallback when starting is refused. */
  ctx?: OneSatContext;
  ticker: string;
  roomName: string;
  me: string;
  createdBy?: string | null;
}) => {
  const [state, setState] = useState<SpaceState | null>(null);
  const [issuer, setIssuer] = useState(false);
  const [open, setOpen] = useState<{ start?: string } | null>(null);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (open) return;
    let live = true;
    const load = () =>
      client
        .space(ticker)
        .then((d) => live && setState(parseSpaceState(d, me)))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, ticker, me, open]);

  useEffect(() => {
    let live = true;
    const read = () =>
      client
        .issuerChallenge(ticker)
        .then((c) => live && setIssuer(c.youAreIssuer))
        .catch(() => undefined);
    void read();
    // A background issuer claim (chat/autoClaim.ts) just made this account the admin.
    const off = onIssuerClaimed((t) => t === ticker && void read());
    return () => {
      live = false;
      off();
    };
  }, [client, ticker]);

  /** Inline fallback after a refusal: run the same issuer claim, then start again. */
  const claimAdmin = ctx
    ? async (): Promise<boolean> => {
        const r = await claimIssuerAdmin(ticker, me, claimDepsFor(client, ctx), { force: true });
        if (r !== 'claimed' && r !== 'already') return false;
        setIssuer(true);
        const again = open;
        setOpen(null);
        setTimeout(() => setOpen(again ?? {}), 0);
        return true;
      }
    : undefined;

  const host = canHostRoom({ me, createdBy, youAreIssuer: issuer });
  const space = state?.space ?? null;

  return (
    <>
      {space ? (
        <button
          onClick={() => setOpen({})}
          className="mx-3 mt-2 flex items-center gap-3 rounded-xl px-3 py-2 text-left"
          style={{ background: 'linear-gradient(90deg, #2a1d05, #1a1408)', border: `1px solid ${GOLD}55` }}
        >
          <span
            className="relative flex h-8 w-8 items-center justify-center rounded-full"
            style={{ background: '#D92D20' }}
          >
            <Radio size={16} color="#fff" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-semibold text-white truncate">
              Live now{space.title ? `: ${space.title}` : ''}
            </span>
            <span className="block text-[11px]" style={{ color: MUTED }}>
              {stageOf(state!)
                .slice(0, 3)
                .map((p) => `$${p.handle}`)
                .join(', ')}{' '}
              · {audienceLine(audienceCount(state!))}
            </span>
          </span>
          <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: GOLD, color: '#010101' }}>
            Join
          </span>
        </button>
      ) : (
        host &&
        state && (
          <button
            onClick={() => setNaming(true)}
            className="mx-3 mt-2 flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-[12px] font-semibold"
            style={{ border: `1px dashed ${GOLD}66`, color: GOLD }}
          >
            <Radio size={14} /> Start a bSpace
          </button>
        )
      )}

      {naming && (
        <div
          className="fixed inset-0 z-[999] flex items-end"
          style={{ background: 'rgba(0,0,0,.55)' }}
          onClick={() => setNaming(false)}
        >
          <form
            className="w-full rounded-t-2xl p-5"
            style={{ background: '#121316', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setNaming(false);
              setOpen({ start: title.trim() || roomName });
            }}
          >
            <p className="text-white font-semibold">Start a bSpace</p>
            <p className="mt-1 text-xs" style={{ color: MUTED }}>
              Stage mode: you speak, holders listen and can raise a hand. Only holders of this token can join.
            </p>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 80))}
              placeholder={`What’s it about? (${roomName})`}
              className="mt-3 w-full rounded-xl px-3 py-3 text-sm text-white outline-none"
              style={{ background: '#1a1b1f' }}
            />
            <button
              type="submit"
              className="mt-3 w-full rounded-full py-3 font-semibold"
              style={{ background: GOLD, color: '#010101' }}
            >
              Go live
            </button>
          </form>
        </div>
      )}

      {open && <DoorKeeper client={client} ticker={ticker} me={me} />}
      {open && (
        <SpaceScreen
          client={client}
          ticker={ticker}
          roomName={roomName}
          me={me}
          startTitle={open.start}
          onClaimAdmin={claimAdmin}
          onClose={() => {
            setOpen(null);
            setState(null);
          }}
        />
      )}
    </>
  );
};
