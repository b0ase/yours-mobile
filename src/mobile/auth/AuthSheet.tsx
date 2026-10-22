import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Check, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { SignInHero } from '../../components/approval/ApprovalHeroes';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { offerAuthLink, onAuthLink, takeAuthLink, type AuthLink } from './authLink';
import { SiteThemeOffer } from '../theme/SiteThemeOffer';
import { familySite } from '../theme/themeSites';
import { answerAuthRequest, cleanMatchCode, fetchAuthRequest, scopeLabel, type AuthRequest } from './authApi';

type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string; req?: AuthRequest }
  | { k: 'ready'; req: AuthRequest }
  | { k: 'busy'; req: AuthRequest }
  | { k: 'done'; req: AuthRequest };

/**
 * "Sign in to <app>" — one sheet (one-sheet permission rule): who is asking, what they get, one Allow button.
 * Allow signs the request with the identity key; nothing is paid and no key leaves the wallet.
 */
export function AuthSheet({ link, onClose }: { link: AuthLink; onClose: () => void }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const accountKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  const [state, setState] = useState<State>({ k: 'loading' });
  const [details, setDetails] = useState(false);
  const [match, setMatch] = useState('');
  useBackClose(true, onClose);

  useEffect(() => {
    let off = false;
    fetchAuthRequest(link)
      .then((req) =>
        off
          ? undefined
          : setState(
              req.status === 'pending'
                ? { k: 'ready', req }
                : { k: 'error', msg: 'This sign-in was already answered.' },
            ),
      )
      .catch((e) => !off && setState({ k: 'error', msg: e instanceof Error ? e.message : String(e) }));
    return () => {
      off = true;
    };
  }, [link]);

  const req = 'req' in state ? state.req : undefined;
  const answer = async (action: 'approve' | 'deny') => {
    if (!req) return onClose();
    const wallet = apiContext?.wallet;
    if (!wallet) return setState({ k: 'error', msg: 'Unlock your wallet first.', req });
    setState({ k: 'busy', req });
    try {
      await answerAuthRequest(wallet, link, req, action, fetch, Date.now(), match);
      if (action === 'deny') return onClose();
      setState({ k: 'done', req });
    } catch (e) {
      setState({ k: 'error', msg: e instanceof Error ? e.message : String(e), req });
    }
  };
  const busy = state.k === 'busy';

  return createPortal(
    <div
      className="fixed inset-0 z-[430] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        testId="auth-sheet"
        site={req?.client.site || 'Sign in'}
        siteSub={req ? req.client.name : undefined}
        onClose={() => (state.k === 'ready' ? void answer('deny') : onClose())}
        closeLabel="Close"
        closeDisabled={busy}
        hero={<SignInHero />}
        title={
          state.k === 'done' ? (
            <>
              Signed in to <span style={{ color: CARD.gold }}>{req?.client.name}</span>
            </>
          ) : (
            <>
              Sign in to <span style={{ color: CARD.gold }}>{req?.client.name ?? '…'}</span>
            </>
          )
        }
        primary={
          state.k === 'ready' || busy
            ? {
                label: busy ? 'Signing…' : 'Allow',
                onClick: () => void answer('approve'),
                disabled: busy || match.length !== 4,
                busy,
              }
            : state.k === 'done'
              ? { label: 'Done', onClick: onClose }
              : undefined
        }
        secondary={
          state.k === 'ready' || busy
            ? { label: 'Not now', onClick: () => void answer('deny'), disabled: busy }
            : state.k === 'error'
              ? { label: 'Close', onClick: onClose }
              : undefined
        }
        details={
          req ? (
            <span>
              Your wallet signs this sign-in with your identity key. {req.client.site} gets the items above and nothing
              else: no keys, no balance, no payments. You return to {req.redirectHost}.
            </span>
          ) : undefined
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
        error={state.k === 'error' ? state.msg : undefined}
      >
        {state.k === 'loading' && (
          <p className="m-0" style={{ color: CARD.muted }}>
            Loading…
          </p>
        )}
        {state.k === 'done' && (
          <>
            <p className="m-0" style={{ color: CARD.muted }}>
              Go back to your browser. {req?.client.site} will finish signing you in.
            </p>
            {/* A family site may offer its colours (theme/siteTheme.ts); only after the sign-in, never applied unasked. */}
            <SiteThemeOffer site={familySite(req?.client.site)} account={accountKey} style={{ marginTop: 12 }} />
          </>
        )}
        {req && state.k !== 'done' && (
          <>
            <div className="flex flex-col" style={{ gap: 8 }}>
              {req.scopes.map((s) => (
                <div key={s} className="flex items-center" style={{ gap: 10, fontSize: 16 }}>
                  <Check />
                  {scopeLabel(s)}
                </div>
              ))}
            </div>
            <label className="flex flex-col" style={{ gap: 6, fontSize: 14, color: CARD.muted }}>
              Type the 4-digit code shown on {req.client.site}
              <input
                data-testid="auth-match-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={match}
                disabled={busy}
                onChange={(e) => setMatch(cleanMatchCode(e.target.value))}
                placeholder="0000"
                style={{
                  fontSize: 28,
                  letterSpacing: 10,
                  textAlign: 'center',
                  padding: '8px 12px',
                  borderRadius: 12,
                  border: `1px solid ${CARD.gold}`,
                  background: 'transparent',
                  color: 'inherit',
                }}
              />
            </label>
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              <Chip>No password</Chip>
              <Chip>Nothing paid</Chip>
            </div>
            <p className="m-0" style={{ color: CARD.muted, fontSize: 14 }}>
              Only allow if you just tapped Sign in on {req.client.site} yourself and can see the code there. If someone
              sent you this link or told you a code, tap Not now.
            </p>
          </>
        )}
      </ApprovalCard>
    </div>,
    document.body,
  );
}

/**
 * Mounted once (PhoneShell, or TopNav with the phone layout off): shows the sheet for a sign-in link from the
 * phone's deep link, the extension, or the web wallet's own URL.
 */
export function AuthRequestHost() {
  const [link, setLink] = useState<AuthLink | null>(null);
  useEffect(() => {
    if (typeof location !== 'undefined' && offerAuthLink(location.href)) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* ignore */
      }
    }
    const show = () => {
      const l = takeAuthLink();
      if (l) setLink(l);
    };
    show();
    return onAuthLink(show);
  }, []);
  return link ? <AuthSheet link={link} onClose={() => setLink(null)} /> : null;
}

export default AuthRequestHost;
