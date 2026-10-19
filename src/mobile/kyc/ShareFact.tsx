import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import { useKyc } from './useKyc';
import {
  buildGrant,
  DURATIONS,
  FACTS,
  factAvailable,
  factPreview,
  isAppKey,
  appNames,
  factOfGrant,
  listGrants,
  nameApp,
  revokeGrant,
  sendGrant,
  shortKey,
  type Fact,
  type ServerGrant,
} from './factShare';

/**
 * Settings › Identity › Share one fact. Pick one fact, see exactly what goes to which app, then
 * Allow or Deny on one sheet. Theme tokens only, so light themes get light cards.
 */

const card = {
  background: 'var(--bw-card)',
  border: '1px solid var(--bw-line)',
  color: 'var(--bw-text)',
} as const;
const muted = { color: 'var(--bw-muted)' } as const;

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const ShareFact = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext } = useServiceContext();
  const { identityKey, kyc, loading } = useKyc();
  const [fact, setFact] = useState<Fact | null>(null);
  const [appName, setAppName] = useState('');
  const [appKey, setAppKey] = useState('');
  const [days, setDays] = useState<number>(30);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [grants, setGrants] = useState<ServerGrant[]>([]);
  const [listNote, setListNote] = useState('');

  const refresh = useCallback(async () => {
    const session = loadSession();
    if (!session) return setListNote('Open Chat once to sign in to see your shares.');
    const r = await listGrants(defaultHttp(isNative), session.token);
    if (r.ok) {
      setGrants(r.grants);
      setListNote('');
    } else
      setListNote(
        r.reason === 'unavailable'
          ? 'Not available yet.'
          : r.reason === 'signin'
            ? 'Open Chat once to sign in to see your shares.'
            : 'Could not load your shares.',
      );
  }, []);

  useEffect(() => {
    if (identityKey) void refresh();
  }, [identityKey, refresh]);

  const ready = !!fact && factAvailable(fact) && isAppKey(appKey) && !!kyc;
  const app = appName.trim() || 'This app';
  const until = new Date(Date.now() + days * 86_400_000).toISOString();

  const allow = async () => {
    if (!fact || !apiContext) return;
    const session = loadSession();
    setBusy(true);
    setNote('');
    try {
      if (!session) {
        setNote('Open Chat once to sign in, then try again. Nothing was shared.');
        return;
      }
      const grant = await buildGrant({ ctx: apiContext, grantee: appKey, fact, days });
      const r = await sendGrant(defaultHttp(isNative), session.token, grant);
      if (!r.ok) {
        setNote(r.message);
        return;
      }
      if (appName.trim()) nameApp(grant.grantee, appName.trim());
      void refresh();
      setNote(`Shared ${fact.label.toLowerCase()} with ${app}.`);
      setFact(null);
      setAppKey('');
      setAppName('');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not sign. Nothing was shared.');
    } finally {
      setBusy(false);
      setSheet(false);
    }
  };

  const stop = async (g: ServerGrant) => {
    const session = loadSession();
    if (!session || !apiContext) return setNote('Open Chat once to sign in, then try again.');
    try {
      const r = await revokeGrant({
        http: defaultHttp(isNative),
        token: session.token,
        ctx: apiContext,
        grantId: g.id,
      });
      if (!r.ok) return setNote(r.message);
      setNote(`Stopped sharing with ${appNames()[g.grantee.toLowerCase()] ?? shortKey(g.grantee)}.`);
      void refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not sign. Still sharing.');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'var(--bw-bg)', color: 'var(--bw-text)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: '1px solid var(--bw-line)' }}
      >
        <button onClick={onClose} aria-label="Back" className="p-2" style={{ color: 'var(--bw-text)' }}>
          <ArrowLeft size={20} />
        </button>
        <span className="text-[16px] font-bold">Share one fact</span>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 bw-dock-pad">
        <p className="m-0 mb-3 text-[12px] leading-snug" style={muted}>
          Prove one thing about you to one app, and nothing else. bit-sign vouches for it until the date you pick.
        </p>
        {loading ? null : !kyc ? (
          <div className="rounded-xl p-3 mb-3 text-[13px]" style={card}>
            Verify your identity first. Then you can share single facts from it.
          </div>
        ) : null}

        <div className="text-[12px] font-semibold mb-1.5">1. Pick one fact</div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {FACTS.map((f) => {
            const on = fact?.id === f.id;
            const avail = factAvailable(f);
            return (
              <button
                key={f.id}
                type="button"
                disabled={!avail}
                onClick={() => setFact(f)}
                className="rounded-xl p-2.5 text-left"
                style={{
                  ...card,
                  border: on ? '1.5px solid var(--bw-accent)' : card.border,
                  opacity: avail ? 1 : 0.5,
                }}
              >
                <div className="flex items-center gap-1 text-[13px] font-semibold">
                  {on && <Check size={13} color="var(--bw-accent)" />}
                  {f.label}
                </div>
                <div className="text-[11px] leading-snug mt-0.5" style={muted}>
                  {avail ? f.shares : 'Not available yet'}
                </div>
              </button>
            );
          })}
        </div>

        <div className="text-[12px] font-semibold mb-1.5">2. Which app</div>
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="App name (for your list)"
          className="w-full rounded-xl px-3 py-2 mb-2 text-[13px]"
          style={card}
        />
        <input
          value={appKey}
          onChange={(e) => setAppKey(e.target.value)}
          placeholder="App's public key (66 characters, starts 02 or 03)"
          className="w-full rounded-xl px-3 py-2 mb-1 font-mono text-[12px]"
          style={card}
          spellCheck={false}
          autoCapitalize="off"
        />
        {appKey && !isAppKey(appKey) && (
          <div className="text-[11px] mb-1" style={{ color: 'var(--bw-danger)' }}>
            That is not a public key.
          </div>
        )}

        <div className="text-[12px] font-semibold mt-3 mb-1.5">3. For how long</div>
        <div className="flex gap-2 mb-4">
          {DURATIONS.map((d) => (
            <button
              key={d.days}
              type="button"
              onClick={() => setDays(d.days)}
              className="flex-1 rounded-xl py-2 text-[13px]"
              style={{ ...card, border: days === d.days ? '1.5px solid var(--bw-accent)' : card.border }}
            >
              {d.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!ready}
          onClick={() => setSheet(true)}
          className="w-full rounded-xl py-3 text-[14px] font-bold"
          style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)', opacity: ready ? 1 : 0.4 }}
        >
          Review
        </button>
        {note && (
          <p className="mt-3 text-[12px]" role="status">
            {note}
          </p>
        )}

        <div className="text-[12px] font-semibold mt-6 mb-1.5">Active shares</div>
        {listNote || grants.length === 0 ? (
          <p className="m-0 text-[12px]" style={muted}>
            {listNote || 'You are not sharing anything.'}
          </p>
        ) : (
          grants.map((g) => (
            <div key={g.id} className="rounded-xl p-3 mb-2 flex items-center gap-2" style={card}>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold truncate">
                  {factOfGrant(g)?.label ?? g.fields.join(', ')} → {appNames()[g.grantee.toLowerCase()] ?? 'App'}
                </div>
                <div className="text-[11px]" style={muted}>
                  {shortKey(g.grantee)} · until {fmt(g.expires_at)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void stop(g)}
                className="rounded-lg px-2.5 py-1.5 text-[12px]"
                style={{ border: '1px solid var(--bw-line)', color: 'var(--bw-danger)' }}
              >
                Stop sharing
              </button>
            </div>
          ))
        )}
      </div>

      {sheet && fact && (
        <div className="fixed inset-0 z-[120] flex items-end" style={{ background: 'rgba(0,0,0,0.45)' }}>
          <div
            className="w-full rounded-t-2xl p-4"
            style={{ ...card, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
            role="dialog"
            aria-label="Share one fact"
          >
            <div className="text-[16px] font-bold mb-1">Share with {app}?</div>
            <div className="text-[11px] font-mono mb-3" style={muted}>
              {shortKey(appKey.trim())}
            </div>
            <div className="rounded-xl p-3 mb-2" style={{ border: '1px solid var(--bw-accent)' }}>
              <div className="text-[12px]" style={muted}>
                {fact.label}
              </div>
              <div className="text-[18px] font-bold">{factPreview(fact, kyc)}</div>
            </div>
            <p className="m-0 mb-4 text-[12px] leading-snug" style={muted}>
              Until {fmt(until)}. Nothing else: not your name, photo, birth date or ID number.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSheet(false)}
                disabled={busy}
                className="flex-1 rounded-xl py-3 text-[14px] font-semibold"
                style={{ border: '1px solid var(--bw-line)', color: 'var(--bw-text)' }}
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => void allow()}
                disabled={busy}
                className="flex-1 rounded-xl py-3 text-[14px] font-bold"
                style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
              >
                {busy ? 'Signing…' : 'Allow'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};
