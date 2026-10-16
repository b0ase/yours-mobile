/**
 * Pay by text, recipient screen (web.bwalletx.com/claim/t/<code>#k=…). Works signed out: it shows
 * who sent how much and until when. No wallet → "Create my wallet" opens the normal onboarding and
 * this screen comes back after it. Wallet → collect the sats into it (the X invites sweep), then tell
 * bit-sign "claimed" with the txid. The key comes from claimLink.ts and is never sent anywhere.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OneSatContext } from '@1sat/actions';
import { ChatApiError } from '../chat/api';
import { sharedChatClient } from '../chat/sharedRooms';
import { sweepInvite } from '../chat/xInvites';
import {
  ClaimApi,
  claimView,
  clearClaim,
  isTerminal,
  senderName,
  type ClaimLink,
  type Lookup,
  type Phase,
} from './claimLink';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sats = (n: number) => `${n.toLocaleString('en-GB')} sats`;
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
};

export const SmsClaim = ({
  link,
  ctx,
  hasWallet,
  unlocked,
  onWallet,
  onClose,
}: {
  link: ClaimLink;
  ctx: OneSatContext;
  hasWallet: boolean;
  unlocked: boolean;
  /** Hide this screen so the onboarding / unlock screen underneath can be used. */
  onWallet: () => void;
  onClose: () => void;
}) => {
  const api = useMemo(() => new ClaimApi((m, p, b, a) => sharedChatClient().request(m, p, b, a)), []);
  const [lookup, setLookup] = useState<Lookup>({ kind: 'loading' });
  const [phase, setPhase] = useState<Phase>('idle');

  const load = useCallback(() => {
    setLookup({ kind: 'loading' });
    api
      .lookup(link.code)
      .then((drop) => setLookup(drop ? { kind: 'ok', drop } : { kind: 'not_found' }))
      .catch((e) =>
        setLookup(e instanceof ChatApiError && e.status === 404 ? { kind: 'not_found' } : { kind: 'network' }),
      );
  }, [api, link.code]);
  useEffect(load, [load]);

  const view = claimView({ lookup, phase, hasWallet, unlocked });
  useEffect(() => {
    if (isTerminal(view)) clearClaim();
  }, [view]);

  const claim = async () => {
    if (!link.txid) return setPhase({ error: 'This link is incomplete. Ask the sender to send it again.' });
    setPhase('claiming');
    try {
      const r = await sweepInvite(ctx, link.wif, link.txid);
      if (!r.satsTxid) throw new Error('Nothing to collect at this link');
      // the sats are already ours; the report only updates the sender's list (it retries on their side)
      await api.claimed(link.code, r.satsTxid).catch(() => undefined);
      setPhase('done');
    } catch (e) {
      const m = errText(e);
      setPhase({
        error: /nothing to collect/i.test(m) ? 'This money has already been collected.' : m || 'Could not collect it.',
      });
    }
  };

  const drop = lookup.kind === 'ok' ? lookup.drop : null;
  const from = drop ? senderName(drop.sender_paymail) : '';
  const primary = 'w-full rounded-2xl py-3 font-bold text-base border-0 disabled:opacity-50';
  const primaryStyle = { background: 'var(--bw-accent-hi)', color: 'var(--bw-on-accent)' };
  const muted = { color: 'var(--bw-muted)' };

  const body = (() => {
    switch (view) {
      case 'loading':
        return <p style={muted}>Loading…</p>;
      case 'not_found':
        return <p style={muted}>This link isn&apos;t valid any more. Ask the sender to send it again.</p>;
      case 'network':
        return (
          <>
            <p style={muted}>We couldn&apos;t reach bWalletX. Check your connection and try again.</p>
            <button className={primary} style={primaryStyle} onClick={load}>
              Try again
            </button>
          </>
        );
      case 'already_claimed':
        return <p style={muted}>This money has already been collected.</p>;
      case 'reclaimed':
        return <p style={muted}>The sender has taken this money back.</p>;
      case 'expired':
        return <p style={muted}>This link has expired. The sender can take the money back or send it again.</p>;
      case 'need_wallet':
        return (
          <>
            <p style={muted}>
              Create a free wallet to keep it. It takes about a minute, and this page comes back after.
            </p>
            <button className={primary} style={primaryStyle} onClick={onWallet}>
              Create my wallet
            </button>
          </>
        );
      case 'need_unlock':
        return (
          <>
            <p style={muted}>Unlock your wallet to collect it.</p>
            <button className={primary} style={primaryStyle} onClick={onWallet}>
              Unlock
            </button>
          </>
        );
      case 'ready':
      case 'claiming':
      case 'failed':
        return (
          <>
            {typeof phase === 'object' && (
              <p className="text-sm" style={{ color: 'var(--bw-danger)' }}>
                {phase.error}
              </p>
            )}
            <button
              className={primary}
              style={primaryStyle}
              disabled={view === 'claiming'}
              onClick={() => void claim()}
            >
              {view === 'claiming' ? 'Collecting…' : view === 'failed' ? 'Try again' : 'Collect it'}
            </button>
          </>
        );
      case 'done':
        return (
          <>
            <p style={{ color: 'var(--bw-text)' }}>Done. It&apos;s in your wallet.</p>
            <button className={primary} style={primaryStyle} onClick={onClose}>
              Open my wallet
            </button>
          </>
        );
    }
  })();

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center px-4"
      style={{ background: 'var(--bw-bg)', color: 'var(--bw-text)' }}
      role="dialog"
      aria-label="Collect money sent by text"
    >
      <div
        className="w-full max-w-sm rounded-3xl p-6 flex flex-col gap-4 text-center"
        style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line)' }}
      >
        <p className="text-sm" style={muted}>
          {drop ? `${from} sent you` : 'Money sent by text'}
        </p>
        {drop && (
          <p className="text-3xl font-bold" style={{ color: 'var(--bw-text)' }}>
            {sats(drop.amount_sats)}
          </p>
        )}
        {drop && view !== 'done' && !isTerminal(view) && day(drop.expires_at) && (
          <p className="text-xs" style={muted}>
            Collect by {day(drop.expires_at)}
          </p>
        )}
        <div className="flex flex-col gap-3 text-sm">{body}</div>
        {view !== 'done' && (
          <button className="text-sm bg-transparent border-0 py-1" style={muted} onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
