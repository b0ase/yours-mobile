import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getChatAccount } from '../chat/chatAccount';
import { useBackClose } from '../backStack';
import { nativeSealRoute } from '../chat/nativeSeal';
import { signDocUrl } from '../chat/pendingDoc';
import { bchatxFrameRoute, docHashFor } from '../chat/signLink';
import { openDappBrowser } from '../dappBrowser';
import { DocView } from '../bureau/DocView';
import type { DocContent } from '../bureau/api';
import { bureauClient } from '../bureau/session';
import { heldFor, olderHeld, paidRefusedFor, readHeldSeals } from './held';
import { loadCachedSync, loadLocal, onSignedChange } from './localStore';
import { busyHeld, finishHeld, sessionGet, sessionHandle, signInToBchat } from './session';
import { refreshSignedBadge } from './refresh';
import { syncSigned, type SyncState } from './sync';
import { TABS, mergeRows, rowTitle, rowsIn, type SignedRow, type SignedTab } from './signedList';
import { HashChip, HeldBanner, OlderHeldNote, PageStatus, Row, SealLink, SyncNote } from './SignedParts';
import { EMPTY_TEXT, TAB_EMPTY, artFor, fmtDate, type FinishState } from './text';
import './signed.css';

/**
 * Signed (/m/signed, ☰ › Signed; owner, 23 Nov 2026): every document this wallet is a party to, in three tabs, with
 * the seals held on this device on top. The list is the wallet's OWN record merged with bit-sign's (signedList.ts),
 * so it shows what this wallet sealed even when bChatX is down or signed out.
 *
 * Signing in: opening the page and the shared sync never sign in. Two things may, and only on the user's tap: the Sign
 * in buttons (the list's, and Finish's when bit-sign wants a fresh session), and opening a signed document, whose
 * preview (bureau/session.ts) signs in with the wallet's key when there is no session.
 */

const SignedPage = () => {
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityKey = account?.pubKeys?.identityPubKey ?? '';
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const [version, setVersion] = useState(0);
  const [sync, setSync] = useState<SyncState>({ k: 'idle' });
  const [serverRows, setServerRows] = useState<SignedRow[] | null>(null);
  const [tab, setTab] = useState<SignedTab | null>(null);
  const [open, setOpen] = useState<SignedRow | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [finish, setFinish] = useState<Record<string, FinishState>>({});
  useBackClose(!!open, () => setOpen(null));

  useEffect(() => onSignedChange(() => setVersion((v) => v + 1)), []);

  /** The shared, throttled sync (sync.ts); `force` only on the user's own tap. */
  const runSync = useCallback(
    async (force = false) => {
      setSync({ k: 'loading' });
      const r = await syncSigned(identityKey, sessionGet(), sessionHandle(), {
        force,
        account: { account: identityAddress, chatAccount: getChatAccount },
      });
      setSync(r.state);
      if (r.rows) setServerRows(r.rows);
      refreshSignedBadge(identityKey);
    },
    [identityKey, identityAddress],
  );
  useEffect(() => {
    void runSync();
  }, [runSync]);

  // `version` re-reads storage after a write (onSignedChange) or a Finish.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cached = useMemo(() => loadCachedSync(identityKey), [identityKey, version]);
  const rows = useMemo(
    () => mergeRows(loadLocal(identityKey), serverRows ?? cached?.rows ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey, serverRows, cached, version],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const held = useMemo(() => heldFor(identityKey, readHeldSeals()), [identityKey, version, finish]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const busy = useMemo(() => busyHeld(identityKey), [identityKey, version, finish]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const older = useMemo(() => olderHeld(readHeldSeals()), [version]);
  const heldDocs = useMemo(() => new Set(held.map((p) => p.documentId)), [held]);
  // Held seals change in other tabs and windows (settled, claimed, paid): re-read them on a storage event, and every
  // 10 s while any are shown.
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener('storage', bump);
    const t = held.length ? setInterval(bump, 10_000) : null;
    return () => {
      window.removeEventListener('storage', bump);
      if (t) clearInterval(t);
    };
  }, [held.length]);
  const shownTab: SignedTab = tab ?? TABS.find((t) => rowsIn(rows, t.id).length)?.id ?? 'waiting';
  const list = rowsIn(rows, shownTab);

  const titleOf = (documentId: string) => {
    const r = rows.find((x) => x.documentId === documentId || x.signatureId === documentId);
    return r ? rowTitle(r) : `Document ${documentId.slice(0, 8)}`;
  };

  const onFinish = async (documentId: string) => {
    setFinish((f) => ({ ...f, [documentId]: { k: 'working' } }));
    const r = await finishHeld(apiContext, documentId, identityKey, identityAddress);
    setFinish((f) => ({ ...f, [documentId]: r }));
    setVersion((v) => v + 1);
    refreshSignedBadge(identityKey);
    if (r.k === 'recorded') void runSync(true);
  };

  /** Finish asked for a sign-in: the user taps Sign in, then that Finish runs again. */
  const onFinishSignIn = async (documentId: string) => {
    setFinish((f) => ({ ...f, [documentId]: { k: 'working' } }));
    try {
      await signInToBchat(apiContext);
    } catch {
      setFinish((f) => ({ ...f, [documentId]: { k: 'sign_in' } }));
      return;
    }
    await onFinish(documentId);
  };

  const onSignIn = async () => {
    setSync({ k: 'loading' });
    try {
      await signInToBchat(apiContext);
    } catch (e) {
      setSync({ k: 'error', text: e instanceof Error ? e.message : 'Could not sign in.' });
      return;
    }
    void runSync(true);
  };

  const openRow = (r: SignedRow) => {
    if (r.status === 'waiting' && r.room) {
      // The wallet's own Sign page; where that isn't built, bChatX's page for the same document.
      const native = nativeSealRoute(r.room, r.signatureId);
      if (native) return navigate(native);
      const href = signDocUrl(r.room, r.signatureId, docHashFor(r.room, r.signatureId));
      const route = bchatxFrameRoute(href);
      if (route) return navigate(route);
      if (href) return void openDappBrowser(href).catch(() => setOpen(r));
    }
    setOpen(r);
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    setContent(null);
    if (!open.signatureId) {
      setContent({ kind: 'empty', reason: 'bChatX has not listed this document yet. Its seal is on Bitcoin.' });
      return;
    }
    bureauClient(apiContext)
      .preview(open.signatureId)
      .then((c) => live && setContent(c))
      .catch((e: Error) => live && setContent({ kind: 'empty', reason: e.message || 'Could not open it just now.' }));
    return () => {
      live = false;
    };
  }, [open, apiContext]);

  const nothing = !rows.length && !held.length;

  return (
    <div className="sg" data-testid="signed-page">
      <TopNav />
      <div className="sg-col">
        <header className="sg-head">
          <h1 className="sg-title">Signed</h1>
          <p className="sg-sub">Every document you have signed, or been asked to sign.</p>
        </header>
        <HeldBanner
          held={held}
          titleOf={titleOf}
          onFinish={(id) => void onFinish(id)}
          onSignIn={(id) => void onFinishSignIn(id)}
          states={finish}
          busy={busy}
          refusedText={(id) => paidRefusedFor(id, held)}
        />
        <OlderHeldNote show={older} />
        <SyncNote
          state={sync}
          cachedAt={cached?.at ?? null}
          onSignIn={() => void onSignIn()}
          onRetry={() => void runSync(true)}
        />
        {nothing && sync.k !== 'loading' && sync.k !== 'idle' ? (
          <div className="sg-empty" data-testid="signed-empty">
            <img src={artFor('signed', 240)} alt="" width={120} height={120} />
            <p>{EMPTY_TEXT}</p>
          </div>
        ) : (
          <>
            <div className="sg-tabs" role="tablist" aria-label="Signed documents">
              {TABS.map((t) => {
                const n = rowsIn(rows, t.id).length;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={shownTab === t.id}
                    className={`sg-tab${shownTab === t.id ? ' on' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                    {n > 0 && <span className="sg-tab-n">{n}</span>}
                  </button>
                );
              })}
            </div>
            {list.length ? (
              <ul className="sg-list">
                {list.map((r) => (
                  <Row
                    key={r.key}
                    row={r}
                    onOpen={openRow}
                    finishing={heldDocs.has(r.documentId) || heldDocs.has(r.signatureId)}
                  />
                ))}
              </ul>
            ) : (
              <div className="sg-empty sg-empty-small">
                <img src={artFor(shownTab, 160)} alt="" width={72} height={72} />
                <p>{TAB_EMPTY[shownTab]}</p>
              </div>
            )}
          </>
        )}
        <PageStatus />
      </div>
      {open && (
        <div className="sg-detail bw-between-bars" role="dialog" aria-label={rowTitle(open)}>
          <div className="sg-detail-bar">
            <button type="button" className="sg-btn sg-back" onClick={() => setOpen(null)}>
              <ChevronLeft size={16} aria-hidden /> Signed
            </button>
            <div className="sg-detail-head">
              <div className="sg-row-title">{rowTitle(open)}</div>
              <div className="sg-row-sub">
                {open.room ? `$${open.room} · ` : ''}
                {fmtDate(open.at)}
              </div>
            </div>
          </div>
          <div className="sg-row-chips sg-detail-chips">
            <HashChip hash={open.docHash} />
            {open.status === 'sealed' && <SealLink txid={open.sealTxid} />}
            {open.status === 'waiting' && !open.room && (
              <span className="sg-note">Open it in its bChatX room to sign it.</span>
            )}
          </div>
          <div className="sg-paper">
            {content ? <DocView content={content} title={rowTitle(open)} /> : <p className="bu-note">Opening…</p>}
          </div>
        </div>
      )}
    </div>
  );
};

export default SignedPage;
