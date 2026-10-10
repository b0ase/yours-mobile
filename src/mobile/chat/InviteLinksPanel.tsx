/**
 * Invite links `/i/<code>` (docs/BSPACES-PLAN.md, "Invite links and tickets"): make one with an
 * expiry and an optional use limit, share or copy it, and see your links with their uses and a
 * Revoke button. Used by the Space share sheet and the token room invite sheet; the caller passes
 * the endpoints, so the same panel serves a Space or a room.
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';
import {
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  parseManagedInvites,
  parseMaxUses,
  parseSpaceInvite,
  STATE_LINE,
  usesLine,
  type ExpiryChoice,
  type ManagedInvite,
} from '../spaces/invite';
import { copyLink, shareText } from './shareLink';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const PANEL = '#0b0b0d';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface InviteLinksPanelProps {
  create: (opts: { expires_in: string; max_uses?: number }) => Promise<unknown>;
  list: () => Promise<unknown>;
  revoke: (code: string) => Promise<unknown>;
  /** Title for the share sheet, e.g. the Space or room name. */
  title: string;
  onNote: (s: string) => void;
}

export const InviteLinksPanel = ({ create, list, revoke, title, onNote }: InviteLinksPanelProps) => {
  const [expiry, setExpiry] = useState<ExpiryChoice>(DEFAULT_EXPIRY);
  const [maxUses, setMaxUses] = useState('');
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<ManagedInvite[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    list()
      .then((d) => setInvites(parseManagedInvites(d)))
      .catch((e) => setError(errText(e)));
  }, [list]);
  useEffect(load, [load]);

  const make = async (how: 'share' | 'copy') => {
    const mu = parseMaxUses(maxUses);
    if (mu === null) return setError('Max uses: a whole number from 1 to 100000, or leave it empty.');
    setBusy(true);
    setError('');
    try {
      const inv = parseSpaceInvite(await create({ expires_in: expiry, ...(mu === '' ? {} : { max_uses: mu }) }));
      if (!inv?.url) throw new Error('No link came back.');
      const r =
        how === 'share'
          ? await shareText(`${inv.target.live ? 'Live now: ' : ''}${title}\n${inv.url}`)
          : await copyLink(inv.url);
      if (r === 'copied') onNote('Invite link copied.');
      if (r === 'failed') onNote(inv.url);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async (code: string) => {
    try {
      await revoke(code);
      onNote('Invite revoked.');
      load();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: MUTED }}>
        Invite link expires
      </div>
      <div className="flex flex-wrap gap-2">
        {EXPIRY_CHOICES.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setExpiry(k)}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={
              k === expiry ? { background: GOLD, color: '#010101' } : { border: `1px solid ${LINE}`, color: '#fff' }
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="mt-3 flex items-center gap-2 rounded-xl px-3"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <span className="text-xs" style={{ color: MUTED }}>
          Max uses
        </span>
        <input
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ''))}
          inputMode="numeric"
          placeholder="No limit"
          className="flex-1 bg-transparent py-2 text-white outline-none text-sm"
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void make('share')}
          disabled={busy}
          className="flex-1 h-11 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: GOLD, color: '#010101' }}
        >
          <Share2 size={15} /> Create invite link
        </button>
        <button
          onClick={() => void make('copy')}
          disabled={busy}
          className="h-11 px-4 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          aria-label="Create and copy invite link"
        >
          <Copy size={15} /> Copy
        </button>
      </div>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-[#F97066] mt-2">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}

      <div className="text-[11px] font-semibold uppercase tracking-wide mt-5 mb-2" style={{ color: MUTED }}>
        Invites
      </div>
      {invites === null ? (
        <p className="text-xs" style={{ color: MUTED }}>
          Loading…
        </p>
      ) : invites.length === 0 ? (
        <p className="text-xs" style={{ color: MUTED }}>
          No invite links yet.
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {invites.map((i) => (
            <div key={i.code} className="flex items-center gap-2 py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
              <Link2 size={14} color={i.state === 'ok' ? GOLD : MUTED} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono truncate">{i.code}</div>
                <div className="text-[11px]" style={{ color: MUTED }}>
                  {usesLine(i)} · {STATE_LINE[i.state]}
                  {i.state === 'ok' && i.expiresAt ? ` · until ${new Date(i.expiresAt).toLocaleString()}` : ''}
                </div>
              </div>
              {i.state === 'ok' && (
                <>
                  <button
                    onClick={() =>
                      void copyLink(i.url).then((r) => onNote(r === 'copied' ? 'Invite link copied.' : i.url))
                    }
                    className="p-1.5"
                    aria-label="Copy invite link"
                  >
                    <Copy size={14} color={MUTED} />
                  </button>
                  <button
                    onClick={() => void doRevoke(i.code)}
                    className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    style={{ border: '1px solid #F97066', color: '#F97066' }}
                  >
                    Revoke
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
