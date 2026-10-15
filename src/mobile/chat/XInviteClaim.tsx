/**
 * Opening a room X invite link (owner, 15 Oct 2026): show the room and the invited @handle, make sure
 * this account's X matches (bit-sign verify; sign in with X here if needed), then collect the token
 * and sats from the link's one-time key into this wallet, and tell bit-sign "swept". The key comes
 * from the link's fragment, lives only in memory here, and is never sent anywhere.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from './api';
import { forwardWarning, InvitesApi, type PublicInvite } from './invitesApi';
import { sweepInvite, type XInviteLink } from './xInvites';
import { useBackClose } from '../backStack';
import { SocialSignIn } from '../social/SocialSignIn';
import { socialProof } from '../social/socialLogin';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const XInviteClaim = ({
  client,
  ctx,
  link,
  identityAddress,
  onOpenRoom,
  onClose,
}: {
  client: BchatClient;
  ctx: OneSatContext;
  link: XInviteLink;
  identityAddress: string;
  onOpenRoom: (ticker: string) => void;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  const api = useMemo(() => new InvitesApi((m, p, b, a) => client.request(m, p, b, a)), [client]);
  const [inv, setInv] = useState<PublicInvite | null | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [needX, setNeedX] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .lookup(link.code)
      .then(setInv)
      .catch(() => setInv(null));
  }, [api, link.code]);

  const claim = async () => {
    if (!inv) return;
    setError('');
    if (!client.handle) return setError('Open Chat once to sign in, then open this link again.');
    if (!link.txid) return setError('This link is incomplete. Ask the host to copy it again.');
    try {
      setBusy('Checking your X account…');
      // Record this wallet's X sign-in on the bChat account (the existing Continue with X proof).
      const proof = socialProof(identityAddress);
      if (proof?.profile.provider === 'x') await client.socialClaim(proof.ticket, proof.secret).catch(() => undefined);
      const v = await api.verify(link.code);
      if (!v.ok) {
        if (v.reason === 'signed_out') return setError('Open Chat once to sign in, then open this link again.');
        if (v.reason === 'x') {
          setNeedX(true);
          return setError(`Sign in with the X account @${inv.x_handle} to accept this invite.`);
        }
        return setError(v.message || 'This invite was refused.');
      }
      setNeedX(false);
      setBusy('Collecting your invite…');
      const r = await sweepInvite(ctx, link.wif, link.txid);
      const txid = r.tokenTxid ?? r.satsTxid;
      if (txid) await api.swept(link.code, txid).catch(() => undefined);
      setDone(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const ticker = inv?.room.ticker ?? '';
  const name = inv?.room.name || (ticker ? `$${ticker}` : 'this room');
  const closed = inv && (inv.status === 'swept' || inv.status === 'revoked');

  return createPortal(
    <div className="fixed inset-0 z-[160] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">Room invite</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {inv === undefined ? (
          <p className="text-sm py-6 text-center" style={{ color: MUTED }}>
            Loading…
          </p>
        ) : inv === null ? (
          <p className="text-sm py-6 text-center" style={{ color: MUTED }}>
            This invite wasn&apos;t found.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              {inv.room.icon && <img src={inv.room.icon} alt="" className="w-12 h-12 rounded-full object-cover" />}
              <div>
                <div className="text-white font-semibold">{name}</div>
                <div className="text-sm" style={{ color: MUTED }}>
                  for @{inv.x_handle}
                </div>
              </div>
            </div>
            {done ? (
              <>
                <p className="text-sm text-white mb-4">You&apos;re in. The token is in your wallet.</p>
                <button
                  onClick={() => onOpenRoom(ticker)}
                  className="w-full rounded-2xl py-2.5 font-bold"
                  style={{ background: GOLD, color: '#1a1300' }}
                >
                  Open the room
                </button>
              </>
            ) : closed ? (
              <p className="text-sm" style={{ color: MUTED }}>
                This invite has {inv.status === 'swept' ? 'already been used' : 'been taken back by the host'}.
              </p>
            ) : (
              <>
                <p className="text-xs mb-4" style={{ color: '#F5B94A' }}>
                  {forwardWarning(inv.room.gate_symbol)}
                </p>
                {needX && (
                  <div className="mb-3">
                    <SocialSignIn owner={identityAddress} onProfile={() => setError('')} />
                  </div>
                )}
                {error && (
                  <p className="text-sm mb-3" style={{ color: '#F97066' }}>
                    {error}
                  </p>
                )}
                <button
                  onClick={() => void claim()}
                  disabled={!!busy}
                  className="w-full rounded-2xl py-2.5 font-bold disabled:opacity-50"
                  style={{ background: GOLD, color: '#1a1300' }}
                >
                  {busy || 'Accept invite'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
