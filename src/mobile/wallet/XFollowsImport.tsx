/**
 * Wallet › Friends › "Find people you follow on X" (roadmap; site /invite). Behind
 * X_FOLLOWS_IMPORT_ENABLED: on by default outside store builds (bit-sign #295 live, owner cap set). Hidden whenever the server says 'disabled' (404).
 *
 * Flow: estimate → (Allow X, if the X sign-in lacks follows.read) → one confirm sheet with count and
 * cost → import → matches become friends with paymails (join-match lookup) → "Invite the rest"
 * opens Open Drops (room › Invites) → "Remove imported list".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import {
  blockedReason,
  estimateLines,
  explainError,
  filterUnmatched,
  usd,
  XFollowsApi,
  type XFollowMatch,
  type XFollowsEstimate,
  type XFollowsResult,
} from '../chat/xFollowsApi';
import { lookupBwalletx } from './useJoinMatch';
import { resolveCallee } from '../calls/peer';
import { addFriend } from '../calls/friends';
import { MAX_INVITES_PER_BATCH } from '../chat/xInvites';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const MUTED = '#98A2B3';
const card = { background: 'var(--bw-surface)', border: '1px solid rgb(var(--bw-accent-rgb)/0.27)' };
const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold border-0';
const primary = { background: 'var(--bw-accent)', color: '#000' };
const soft = { background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' };

/** Hand the X permission page to the browser: the system browser on the phone, a new tab on the web. */
export const openReauth = (
  url: string,
  native = isNative,
  open: (u: string, t: string) => unknown = (u, t) => window.open(u, t, t === '_blank' ? 'noopener' : undefined),
) => {
  open(url, native ? '_system' : '_blank');
};

/** Add one match as a friend: handle → paymail through the join-match resolver, then its identity key. */
export const addMatch = async (
  m: XFollowMatch,
  lookup: (name: string) => Promise<string | null> = lookupBwalletx,
  resolve: (raw: string) => Promise<{ key: string; label: string }> = (raw) => resolveCallee(f, raw),
  add: (p: { key: string; name: string }) => Promise<void> = addFriend,
): Promise<string> => {
  const paymail = await lookup(m.handle);
  if (!paymail) throw new Error(`${m.handle} has no bWalletX paymail yet`);
  const peer = await resolve(paymail);
  await add({ key: peer.key, name: peer.label || paymail });
  return paymail;
};

/** What happens next, in plain words: your room's Invites shows the cost and asks once. */
export const inviteNote = (n: number, batch = MAX_INVITES_PER_BATCH) =>
  n === 0
    ? 'Choose who to invite. Each invite is an Open Drop from your room.'
    : n > batch
      ? `Your room's Invites will show the cost and ask once for the first ${batch}; then invite the next ${batch}.`
      : `Your room's Invites will show the cost and ask you once.`;

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'estimate'; e: XFollowsEstimate }
  | { kind: 'confirm'; e: XFollowsEstimate }
  | { kind: 'importing' };

export const XFollowsImport = ({ onInviteRest }: { onInviteRest: ((handles: string[]) => void) | null }) => {
  const api = useMemo(
    () =>
      new XFollowsApi((m, p, b) => {
        const session = loadSession();
        return new BchatClient(defaultHttp(isNative), session).request(m, p, b);
      }),
    [],
  );
  const [hidden, setHidden] = useState(false);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [result, setResult] = useState<XFollowsResult | null>(null);
  const [msg, setMsg] = useState('');
  const [added, setAdded] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [awaitingReauth, setAwaitingReauth] = useState(false);
  // "Invite the rest": pick who to invite from the people you follow who aren't on bChatX yet.
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const fail = useCallback((e: unknown) => {
    const x = explainError(e);
    if (x.kind === 'disabled') setHidden(true);
    else if (x.kind === 'signed_out') setMsg('Sign in to bChat first, then try again.');
    else setMsg(x.message);
    if (x.kind === 'scope' && x.reauthUrl) {
      setAwaitingReauth(true);
      openReauth(x.reauthUrl);
    }
    return x;
  }, []);

  // A previous import, if any. 404 = the feature is off on the server: show nothing.
  useEffect(() => {
    let live = true;
    api
      .result()
      .then((r) => live && r.imported > 0 && setResult(r))
      .catch((e) => {
        if (live && explainError(e).kind === 'disabled') setHidden(true);
      });
    return () => {
      live = false;
    };
  }, [api]);

  const loadEstimate = useCallback(async () => {
    setMsg('');
    setView({ kind: 'loading' });
    try {
      setView({ kind: 'estimate', e: await api.estimate() });
    } catch (e) {
      fail(e);
      setView({ kind: 'idle' });
    }
  }, [api, fail]);

  // Back from the X permission page (system browser or another tab): check again.
  useEffect(() => {
    if (!awaitingReauth) return;
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      setAwaitingReauth(false);
      void loadEstimate();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, [awaitingReauth, loadEstimate]);

  const runImport = async () => {
    setMsg('');
    setView({ kind: 'importing' });
    try {
      const r = await api.runImport();
      setResult({ ...r, lastImportAt: new Date().toISOString() });
      setMsg(
        r.imported === 0
          ? 'Nothing new to import.'
          : `Looked up ${r.imported.toLocaleString()} accounts. ${r.matched.length.toLocaleString()} ${r.matched.length === 1 ? 'is' : 'are'} on bWalletX.`,
      );
    } catch (e) {
      fail(e);
    }
    setView({ kind: 'idle' });
  };

  const addAll = async (list: XFollowMatch[]) => {
    setAdding(true);
    setMsg('');
    let ok = 0;
    for (const m of list) {
      if (added[m.handle]) continue;
      try {
        const paymail = await addMatch(m);
        setAdded((a) => ({ ...a, [m.handle]: paymail }));
        ok++;
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Could not add that friend');
      }
    }
    if (ok) setMsg(`${ok} added to your friends.`);
    setAdding(false);
  };

  const remove = async () => {
    setMsg('');
    try {
      await api.remove();
      setResult(null);
      setPicking(false);
      setPicked(new Set());
      setAdded({});
      setMsg('Imported list removed. Friends you added stay.');
    } catch (e) {
      fail(e);
    }
  };

  if (hidden) return null;
  const busy = view.kind === 'loading' || view.kind === 'importing';
  const rest = result?.unmatched ?? [];
  const shownRest = filterUnmatched(rest, query);
  const allShownPicked = shownRest.length > 0 && shownRest.every((u) => picked.has(u.xUsername));
  const toggle = (name: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const toggleAllShown = () =>
    setPicked((p) => {
      const n = new Set(p);
      for (const u of shownRest) {
        if (allShownPicked) n.delete(u.xUsername);
        else n.add(u.xUsername);
      }
      return n;
    });

  return (
    <div className="flex flex-col gap-2 rounded-xl px-3 py-3" style={card}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white">Find people you follow on X</div>
          <div className="text-xs" style={{ color: MUTED }}>
            See who is already on bWalletX and add them as friends.
          </div>
        </div>
        {view.kind === 'idle' && (
          <button type="button" className={`shrink-0 ${btn}`} style={soft} onClick={() => void loadEstimate()}>
            {result ? 'Check again' : 'Find'}
          </button>
        )}
      </div>

      {busy && (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {view.kind === 'importing' ? 'Importing from X…' : 'Checking…'}
        </p>
      )}

      {view.kind === 'estimate' && (
        <div className="flex flex-col gap-2">
          {estimateLines(view.e).map((l) => (
            <p key={l} className="text-xs m-0 text-white">
              {l}
            </p>
          ))}
          {blockedReason(view.e) && (
            <p className="text-xs m-0" style={{ color: MUTED }}>
              {blockedReason(view.e)}
            </p>
          )}
          <div className="flex gap-2">
            {view.e.allowed && !view.e.hasScope && view.e.reauthUrl && (
              <button
                type="button"
                className={btn}
                style={primary}
                onClick={() => {
                  setAwaitingReauth(true);
                  openReauth(view.e.reauthUrl!);
                }}
              >
                Allow X to share who you follow
              </button>
            )}
            {view.e.allowed && view.e.hasScope && (
              <button
                type="button"
                className={btn}
                style={primary}
                onClick={() => setView({ kind: 'confirm', e: view.e })}
              >
                Import {view.e.accounts.toLocaleString()}
              </button>
            )}
            <button type="button" className={btn} style={soft} onClick={() => setView({ kind: 'idle' })}>
              Not now
            </button>
          </div>
          {awaitingReauth && (
            <p className="text-xs m-0" style={{ color: MUTED }}>
              Finish on X, then come back here.
            </p>
          )}
        </div>
      )}

      {view.kind === 'confirm' && (
        <div
          role="dialog"
          aria-label="Confirm X import"
          className="fixed inset-0 z-[110] flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setView({ kind: 'estimate', e: view.e })}
        >
          <div
            className="w-full max-w-md rounded-t-2xl p-5 flex flex-col gap-3"
            style={{ background: 'var(--bw-surface)' }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="text-base font-bold text-white">Import {view.e.accounts.toLocaleString()} accounts?</div>
            <p className="text-sm m-0 text-white">
              X charges about {usd(view.e.estimatedUsd)} to look them up. We keep only their X name, to match them to
              bWalletX. You can remove the list any time.
            </p>
            <p className="text-xs m-0" style={{ color: MUTED }}>
              One import every 30 days.
            </p>
            <div className="flex gap-2">
              <button type="button" className={`flex-1 ${btn} py-2.5`} style={primary} onClick={() => void runImport()}>
                Import
              </button>
              <button
                type="button"
                className={`flex-1 ${btn} py-2.5`}
                style={soft}
                onClick={() => setView({ kind: 'estimate', e: view.e })}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {msg}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-2">
          {result.matched.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">On bWalletX ({result.matched.length})</span>
                <button
                  type="button"
                  className={btn}
                  style={soft}
                  disabled={adding || result.matched.every((m) => added[m.handle])}
                  onClick={() => void addAll(result.matched)}
                >
                  {adding ? 'Adding…' : 'Add all'}
                </button>
              </div>
              <ul className="m-0 p-0 list-none flex flex-col gap-1">
                {result.matched.map((m) => (
                  <li key={m.handle} className="flex items-center justify-between gap-2 text-sm text-white">
                    <span className="min-w-0 truncate">
                      {m.xUsername ? `@${m.xUsername}` : m.handle}{' '}
                      <span style={{ color: MUTED }}>· {added[m.handle] ?? `$${m.handle}`}</span>
                    </span>
                    {added[m.handle] ? (
                      <span className="text-xs" style={{ color: MUTED }}>
                        Added
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={btn}
                        style={soft}
                        disabled={adding}
                        aria-label={`Add ${m.handle}`}
                        onClick={() => void addAll([m])}
                      >
                        Add
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs m-0" style={{ color: MUTED }}>
              None of the people you follow are on bWalletX yet.
            </p>
          )}
          {rest.length > 0 && onInviteRest && !picking && (
            <button type="button" className={btn} style={primary} onClick={() => setPicking(true)}>
              Invite the rest ({rest.length.toLocaleString()})
            </button>
          )}
          {rest.length > 0 && onInviteRest && picking && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-white">Not on bChatX yet ({rest.length.toLocaleString()})</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search @names"
                aria-label="Search people to invite"
                autoCapitalize="none"
                autoCorrect="off"
                className="rounded-xl bg-[var(--bw-bg,#000)] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
              />
              <label className="flex items-center gap-2 text-xs text-white">
                <input type="checkbox" checked={allShownPicked} onChange={toggleAllShown} />
                {query.trim() ? `Select all ${shownRest.length.toLocaleString()} shown` : 'Select all'}
              </label>
              <ul className="m-0 p-0 list-none flex flex-col gap-1 max-h-64 overflow-y-auto">
                {shownRest.map((u) => (
                  <li key={u.xUsername}>
                    <label className="flex items-center gap-2 text-sm text-white">
                      <input type="checkbox" checked={picked.has(u.xUsername)} onChange={() => toggle(u.xUsername)} />@
                      {u.xUsername}
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs m-0" style={{ color: MUTED }}>
                {inviteNote(picked.size)}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btn}
                  style={{ ...primary, opacity: picked.size ? 1 : 0.4 }}
                  disabled={!picked.size}
                  onClick={() => onInviteRest(rest.map((u) => u.xUsername).filter((n) => picked.has(n)))}
                >
                  Invite {picked.size.toLocaleString()}
                </button>
                <button type="button" className={btn} style={soft} onClick={() => setPicking(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="text-xs self-start border-0 bg-transparent p-0"
            style={{ color: MUTED }}
            onClick={() => void remove()}
          >
            Remove imported list
          </button>
        </div>
      )}
    </div>
  );
};
