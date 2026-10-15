/**
 * Room host › Invites (owner, 15 Oct 2026): invite X users by @handle. One transaction funds a fresh
 * one-time key per handle with the room's gate amount plus a few sats; each link carries its key in
 * the fragment only. Links stay on this device (encrypted); bit-sign only learns handle + address.
 * Shown only when bit-sign says this user manages the room (chat/invitesApi.ts). bWalletX only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Share2, X } from 'lucide-react';
import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from './api';
import { InvitesApi, type HostInvite } from './invitesApi';
import {
  addressOf,
  fundInvites,
  inviteAmountRaw,
  inviteLink,
  inviteSats,
  loadStoredInvites,
  MAX_INVITES_PER_BATCH,
  newInviteKey,
  parseHandles,
  rememberInvites,
  saveStoredInvites,
  sweepInvite,
  type StoredInvite,
} from './xInvites';
import { copyLink, shareText } from './shareLink';
import { formatRaw, type TokenGate } from './tokenRooms';
import { useBackClose } from '../backStack';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const PANEL = '#0b0b0d';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface XInvitesSheetProps {
  client: BchatClient;
  ctx: OneSatContext;
  ticker: string;
  roomName: string;
  gate: TokenGate;
  onClose: () => void;
}

type Step =
  | { kind: 'list' }
  | { kind: 'confirm'; handles: string[]; satsEach: number }
  | { kind: 'busy'; line: string };

export const XInvitesSheet = ({ client, ctx, ticker, roomName, gate, onClose }: XInvitesSheetProps) => {
  useBackClose(true, onClose);
  const api = useMemo(() => new InvitesApi((m, p, b, a) => client.request(m, p, b, a)), [client]);
  const tokenId = gate.key.replace(/^bsv21:/, '');
  const amountRaw = inviteAmountRaw(gate);
  const amountLabel = `${formatRaw(amountRaw.toString(), gate.dec)} $${gate.symbol}`;

  const [server, setServer] = useState<HostInvite[] | null>(null);
  const [local, setLocal] = useState<StoredInvite[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<StoredInvite[]>([]);

  const load = useCallback(async () => {
    setLocal(await loadStoredInvites(ctx.wallet, ticker));
    setServer(await api.list(ticker).catch(() => null));
  }, [api, ctx.wallet, ticker]);
  useEffect(() => void load(), [load]);

  const addTyped = (text: string) => {
    const hs = parseHandles(text);
    if (hs.length) setChips((c) => [...c, ...hs.filter((h) => !c.includes(h))].slice(0, MAX_INVITES_PER_BATCH));
    setTyped('');
  };

  const review = async () => {
    const handles = [...chips, ...parseHandles(typed).filter((h) => !chips.includes(h))];
    if (!handles.length) return setError('Add at least one @handle');
    setError('');
    setStep({ kind: 'busy', line: 'Checking…' });
    try {
      const d = await ctx.services?.bsv21.getTokenDetails(tokenId, { fresh: true });
      setStep({ kind: 'confirm', handles, satsEach: inviteSats(d?.status?.fee_per_output) });
    } catch (e) {
      setError(errText(e));
      setStep({ kind: 'list' });
    }
  };

  const create = async (handles: string[], satsEach: number) => {
    setError('');
    setStep({ kind: 'busy', line: 'Sending…' });
    // Keys are made here and live only in memory, the encrypted local store and the links.
    const keys = handles.map(() => newInviteKey());
    const addresses = keys.map(addressOf);
    try {
      const funded = await fundInvites(ctx, { tokenId, amountRaw, addresses, satsEach, ticker });
      const pairs = handles.map((h, i) => ({ x_handle: h, funded_address: addresses[i] }));
      // Keep the keys on this device before anything else can fail, so the tokens are never stranded.
      const pre: StoredInvite[] = pairs.map((p, i) => ({
        code: `pending-${funded.txid.slice(0, 8)}-${i}`,
        ...p,
        wif: keys[i].toWif(),
        txid: funded.txid,
        url: '',
        created_at: new Date().toISOString(),
      }));
      await rememberInvites(ctx.wallet, ticker, pre);
      setStep({ kind: 'busy', line: 'Registering…' });
      const created = await api.create(ticker, pairs, funded.txid, funded.beef);
      const byAddr = new Map(pre.map((p) => [p.funded_address, p]));
      const done: StoredInvite[] = created.flatMap((c) => {
        const p = byAddr.get(c.funded_address);
        return p ? [{ ...p, code: c.code, url: inviteLink(c.url_base, p.wif, p.txid) }] : [];
      });
      const doneAddr = new Set(done.map((d) => d.funded_address));
      const kept = (await loadStoredInvites(ctx.wallet, ticker)).filter(
        (s) => !(s.code.startsWith('pending-') && doneAddr.has(s.funded_address)),
      );
      await saveStoredInvites(ctx.wallet, ticker, [...kept, ...done]);
      setFresh(done);
      setChips([]);
      setTyped('');
      await load();
      setStep({ kind: 'list' });
    } catch (e) {
      setError(errText(e));
      await load();
      setStep({ kind: 'list' });
    }
  };

  const revoke = async (s: StoredInvite) => {
    setError('');
    setStep({ kind: 'busy', line: `Taking back @${s.x_handle}'s invite…` });
    try {
      const r = await sweepInvite(ctx, s.wif, s.txid);
      if (!s.code.startsWith('pending-')) await api.revoke(ticker, s.code, r.tokenTxid ?? r.satsTxid ?? null);
      else {
        const rest = (await loadStoredInvites(ctx.wallet, ticker)).filter((x) => x.code !== s.code);
        await saveStoredInvites(ctx.wallet, ticker, rest);
      }
      await load();
    } catch (e) {
      setError(errText(e));
    }
    setStep({ kind: 'list' });
  };

  const copy = async (url: string) => setNote((await copyLink(url)) === 'copied' ? 'Link copied' : 'Copy failed');
  const share = async (s: StoredInvite) => {
    const r = await shareText(`@${s.x_handle}, you're invited to ${roomName}.\n${s.url}`);
    setNote(r === 'copied' ? 'Link copied' : r === 'failed' ? 'Share failed' : '');
  };

  const localByCode = new Map(local.map((l) => [l.code, l]));
  const pendingLocal = local.filter((l) => l.code.startsWith('pending-'));

  const body =
    step.kind === 'busy' ? (
      <p className="text-sm py-10 text-center" style={{ color: MUTED }}>
        {step.line}
      </p>
    ) : step.kind === 'confirm' ? (
      <div>
        <p className="text-sm text-white mb-2">
          Send {step.handles.length} invite{step.handles.length === 1 ? '' : 's'} in one transaction:
        </p>
        <ul className="text-sm mb-3" style={{ color: MUTED }}>
          <li>
            {step.handles.length} × {amountLabel} (from your wallet)
          </li>
          <li>
            {step.handles.length} × {step.satsEach.toLocaleString()} sats, so each person can collect it
          </li>
          <li>plus the network and token overlay fees</li>
        </ul>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          {step.handles.map((h) => `@${h}`).join(', ')}
        </p>
        <p className="text-xs mb-4" style={{ color: MUTED }}>
          Each link can be used by whoever opens it. You can take back any invite that is still open.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setStep({ kind: 'list' })}
            className="flex-1 rounded-2xl py-2.5 font-semibold text-white"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            Back
          </button>
          <button
            onClick={() => void create(step.handles, step.satsEach)}
            className="flex-1 rounded-2xl py-2.5 font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Allow
          </button>
        </div>
      </div>
    ) : (
      <div>
        {fresh.length > 0 && (
          <div className="mb-4 rounded-2xl p-3" style={{ background: PANEL, border: `1px solid ${GOLD}` }}>
            <div className="text-sm font-semibold text-white mb-2">Send each person their link</div>
            {fresh.map((s) => (
              <LinkRow key={s.code} s={s} onCopy={copy} onShare={share} />
            ))}
          </div>
        )}
        <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: MUTED }}>
          Invite by X handle
        </div>
        <div
          className="flex flex-wrap gap-1.5 rounded-2xl px-3 py-2 mb-2"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          {chips.map((h) => (
            <span
              key={h}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-sm"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              @{h}
              <button aria-label={`Remove @${h}`} onClick={() => setChips((c) => c.filter((x) => x !== h))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            value={typed}
            onChange={(e) => (/[\s,;]$/.test(e.target.value) ? addTyped(e.target.value) : setTyped(e.target.value))}
            onPaste={(e) => {
              e.preventDefault();
              addTyped(typed + ' ' + e.clipboardData.getData('text'));
            }}
            onKeyDown={(e) => e.key === 'Enter' && addTyped(typed)}
            placeholder={chips.length ? '' : '@handle, or paste a list'}
            className="flex-1 min-w-[8rem] bg-transparent py-1 text-white outline-none"
            aria-label="X handles"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Each invite holds {amountLabel} for that person. Only the X account you name can enter the room early.
        </p>
        <button
          onClick={() => void review()}
          disabled={!chips.length && !parseHandles(typed).length}
          className="w-full rounded-2xl py-2.5 font-bold mb-5 disabled:opacity-40"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Create invites
        </button>

        <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: MUTED }}>
          Your invites
        </div>
        {pendingLocal.map((s) => (
          <div key={s.code} className="py-2 flex items-center gap-2" style={{ borderTop: `1px solid ${LINE}` }}>
            <span className="flex-1 text-sm text-white">@{s.x_handle}</span>
            <span className="text-xs" style={{ color: MUTED }}>
              not registered
            </span>
            <button onClick={() => void revoke(s)} className="text-xs font-semibold" style={{ color: '#F97066' }}>
              Take back
            </button>
          </div>
        ))}
        {server === null ? (
          <p className="text-xs" style={{ color: MUTED }}>
            Loading…
          </p>
        ) : !server.length && !pendingLocal.length ? (
          <p className="text-xs" style={{ color: MUTED }}>
            No invites yet.
          </p>
        ) : (
          server.map((inv) => {
            const s = localByCode.get(inv.code);
            return (
              <div key={inv.code} className="py-2" style={{ borderTop: `1px solid ${LINE}` }}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-white">@{inv.x_handle}</span>
                  <span className="text-xs" style={{ color: inv.status === 'swept' ? GOLD : MUTED }}>
                    {inv.status === 'swept' ? 'joined' : inv.status}
                    {inv.claimed_by ? ` · $${inv.claimed_by}` : ''}
                  </span>
                  {s && (inv.status === 'open' || inv.status === 'verified') && (
                    <button
                      onClick={() => void revoke(s)}
                      className="text-xs font-semibold"
                      style={{ color: '#F97066' }}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                {s?.url && inv.status !== 'revoked' && inv.status !== 'swept' && (
                  <LinkRow s={s} onCopy={copy} onShare={share} compact />
                )}
                {!s && inv.status === 'open' && (
                  <p className="text-[11px]" style={{ color: MUTED }}>
                    Link made on another device
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    );

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 max-h-[90vh] overflow-y-auto"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">Invites · {roomName}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {error && (
          <p className="text-sm mb-3" style={{ color: '#F97066' }}>
            {error}
          </p>
        )}
        {note && (
          <p className="text-xs mb-2" style={{ color: GOLD }}>
            {note}
          </p>
        )}
        {body}
      </div>
    </div>,
    document.body,
  );
};

const LinkRow = ({
  s,
  onCopy,
  onShare,
  compact = false,
}: {
  s: StoredInvite;
  onCopy: (url: string) => void;
  onShare: (s: StoredInvite) => void;
  compact?: boolean;
}) => (
  <div className={`flex items-center gap-2 ${compact ? 'mt-1' : 'mb-2'}`}>
    {!compact && <span className="flex-1 text-sm text-white">@{s.x_handle}</span>}
    {compact && <span className="flex-1" />}
    <button
      onClick={() => onCopy(s.url)}
      className="rounded-xl px-3 py-1.5 text-xs font-semibold flex items-center gap-1"
      style={{ border: `1px solid ${GOLD}`, color: GOLD }}
    >
      <Copy size={12} /> Copy
    </button>
    <button
      onClick={() => onShare(s)}
      className="rounded-xl px-3 py-1.5 text-xs font-semibold flex items-center gap-1"
      style={{ border: `1px solid ${GOLD}`, color: GOLD }}
    >
      <Share2 size={12} /> Share
    </button>
  </div>
);
