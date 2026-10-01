import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getPaymail, setPaymail } from './accountName';
import { syncBchatHandle } from './bchatHandle';
import { claimPaymail, paymailAvailable, paymailEnabled, PAYMAIL_ALIAS_RE, toAlias } from './paymail';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import {
  PERSONAL_FEE_ESTIMATE_SATS,
  PERSONAL_INDEX_SATS,
  PERSONAL_NETWORK_FEE_SATS,
  deployPersonalToken,
  openPersonalRoom,
  recoverPersonalLink,
} from './claimPersonal';
import { getFundRecord, showOnWallet } from '../tokens/indexFund';
import { FinishIndexing } from '../tokens/FinishIndexing';
import { AvatarPicker } from './AvatarPicker';
import { paymailAvatar } from './avatar';
import { DEFAULT_SUPPLY, getPersonalLink, onPersonalChange, personalTicker, validateSupply } from './personalToken';
import { getMyName } from './myName';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useTheme } from '../../hooks/useTheme';
import { handleTitle, suggestHandle } from './handlePrompt';
import { useBackClose } from '../backStack';

/**
 * "Choose your handle": a full-screen sheet shown after create / restore (HandleOnboarding) and
 * from the Wallet "Get your $name" card. Step 1 claims the free paymail name@bwallet.space (signed by
 * the identity key, no transaction). Step 2, on by default: the personal $NAME token + its
 * holder-only room (claimPersonal), after the standard confirmation sheet shows the fee (network
 * + creator-paid indexing). Optional: a photo (local; publishing it is a separate confirmed step).
 * The on-chain OpNS name is NOT offered here: it stays a quiet optional link in Settings → Identity.
 * Nothing is broadcast without a confirmation; the user can skip.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const BORDER = '#2b2f36';
const GRAY = '#98A2B3';

const f = (u: string, i?: RequestInit) => fetch(u, i);
type AliasState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'error';

export const HandleFlow = ({ onClose, title = 'Choose your handle' }: { onClose: () => void; title?: string }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const profileName = account?.settings?.socialProfile?.displayName ?? '';
  const [paymail, setPm] = useState(getPaymail(identityAddress));
  const [alias, setAlias] = useState(() => suggestHandle(profileName, account?.name ?? ''));
  const [state, setState] = useState<AliasState>('idle');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const enabled = paymailEnabled();
  const { theme } = useTheme();
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  const [withToken, setWithToken] = useState(true);
  const [supply, setSupply] = useState(DEFAULT_SUPPLY);
  const [confirming, setConfirming] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);
  // The token is named after the claimed handle (paymail alias, else OpNS name), else what's typed.
  const claimed = (paymail ? paymail.split('@')[0] : '') || getMyName(identityAddress);
  const tokenName = claimed || alias;
  const ticker = personalTicker(tokenName);
  const supplyError = validateSupply(supply);
  // A token minted earlier whose local link was lost: find this wallet's own deploy (read-only).
  useEffect(() => {
    if (link || !claimed || !apiContext) return;
    recoverPersonalLink(apiContext, identityAddress, claimed)
      .then((l) => l && setLink(l))
      .catch(() => undefined);
  }, [apiContext, identityAddress, claimed, link]);

  const mintToken = async (name = tokenName) => {
    setConfirming(false);
    setBusy(true);
    setTokenMsg('');
    try {
      const l = await deployPersonalToken(apiContext, { identityAddress, name, supply });
      // Its balance is local: show it on the Wallet tab now, not when an indexer catches up.
      void showOnWallet(chromeStorageService, l.tokenId);
      setTokenMsg(`$${l.ticker} minted. Opening your room…`);
      // Signatures only; a fresh token may not be indexed yet. Chat retries until it is.
      openPersonalRoom(apiContext, identityAddress, l)
        .then(() => setTokenMsg(`$${l.ticker} minted and your room is open. Invite = send 1 $${l.ticker}.`))
        .catch(() => setTokenMsg(`$${l.ticker} minted. Your room opens in Chat once the token is indexed.`));
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Token mint failed');
    } finally {
      setBusy(false);
    }
  };

  // Live availability, debounced.
  useEffect(() => {
    if (!enabled) return;
    if (!alias) return setState('idle');
    if (!PAYMAIL_ALIAS_RE.test(alias)) return setState('invalid');
    if (paymail === `${alias}@${BWALLET_PAYMAIL_DOMAIN}`) return setState('free');
    setState('checking');
    let live = true;
    const t = setTimeout(() => {
      paymailAvailable(f, alias)
        .then((free) => live && setState(free ? 'free' : 'taken'))
        .catch(() => live && setState('error'));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [alias, enabled, paymail]);

  const claim = async () => {
    setBusy(true);
    setMsg('');
    try {
      const pm = await claimPaymail(f, apiContext.wallet, alias, {
        ordAddress,
        name: profileName,
        avatar: paymailAvatar(account?.settings?.socialProfile?.avatar),
      });
      setPaymail(identityAddress, pm);
      setPm(pm);
      // bChat handle = paymail name, before any token room is opened under it.
      await syncBchatHandle(apiContext, pm, { signIn: true });
      // Token + room is part of the flow: go straight to its fee confirmation.
      if (withToken && !getPersonalLink(identityAddress) && personalTicker(pm.split('@')[0]) && !supplyError)
        setConfirming(true);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const owned = !!paymail && paymail === `${alias}@${BWALLET_PAYMAIL_DOMAIN}`;
  const stateText: Record<AliasState, string> = {
    idle: '',
    checking: 'Checking…',
    free: owned ? 'Yours' : 'Available',
    taken: 'Taken. Try another.',
    invalid: 'Use a-z, 0-9, - or _',
    error: "Couldn't check. Check your connection.",
  };

  return (
    <div
      className="fixed inset-0 z-[400] flex flex-col overflow-y-auto"
      style={{
        background: '#0b0c0f',
        paddingTop: 'calc(env(safe-area-inset-top) + 12px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
      }}
      role="dialog"
      aria-label={title}
    >
      <div className="flex items-center justify-between px-4 h-12">
        <span className="text-base font-bold text-white">{title}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 bg-transparent border-0">
          <X size={18} color={GRAY} />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 pt-2">
        <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
          <AvatarPicker displayName={profileName || claimed || alias} />
          <span className="text-2xl font-bold" style={{ color: GOLD }}>
            {handleTitle(paymail ? paymail.split('@')[0] : alias)}
          </span>
          <p className="text-xs max-w-[300px]" style={{ color: GRAY }}>
            A name people can pay instead of a long address. You can change it later in Settings → Identity.
          </p>
        </div>

        {enabled ? (
          <div
            className="flex flex-col gap-2 rounded-2xl p-4"
            style={{ background: PANEL, border: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: GRAY }}>
                Your paymail
              </span>
              <span className="text-[10px] font-semibold" style={{ color: '#2ecc71' }}>
                Free · instant
              </span>
            </div>
            <div
              className="flex items-center gap-1 rounded-xl px-3 h-11"
              style={{ background: '#0b0c0f', border: `1px solid ${BORDER}` }}
            >
              <input
                value={alias}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="yourname"
                aria-label="Handle"
                onChange={(e) => setAlias(toAlias(e.target.value))}
                className="flex-1 min-w-0 bg-transparent outline-none border-0 text-sm text-white"
              />
              <span className="text-sm whitespace-nowrap" style={{ color: GRAY }}>
                @{BWALLET_PAYMAIL_DOMAIN}
              </span>
            </div>
            <span
              className="text-[11px] min-h-[16px]"
              style={{
                color: state === 'free' ? '#2ecc71' : state === 'checking' || state === 'idle' ? GRAY : '#ff4444',
              }}
            >
              {stateText[state]}
            </span>
            {paymail && (
              <p className="text-xs text-white">
                <b style={{ color: GOLD }}>{paymail} ✓</b> receives BSV and tokens from any paymail wallet.
              </p>
            )}
            {!owned && (
              <button
                type="button"
                disabled={busy || state !== 'free'}
                onClick={claim}
                className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                style={{ background: GOLD, color: '#000' }}
              >
                {busy ? 'Claiming…' : `${paymail ? 'Change to' : 'Claim'} ${alias || 'name'}@${BWALLET_PAYMAIL_DOMAIN}`}
              </button>
            )}
            {msg && (
              <p className="text-xs" style={{ color: '#ff4444' }}>
                {msg}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs" style={{ color: GRAY }}>
            Paymail isn't available in this build. You can still register an on-chain name below.
          </p>
        )}

        <div
          className="flex flex-col gap-2 rounded-2xl p-4"
          style={{ background: PANEL, border: `1px solid ${BORDER}` }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest" style={{ color: GRAY }}>
              Your token + room
            </span>
            <span className="text-[10px] font-semibold" style={{ color: GOLD }}>
              ~{PERSONAL_FEE_ESTIMATE_SATS} sats
            </span>
          </div>
          {link ? (
            <p className="text-xs text-white">
              <b style={{ color: GOLD }}>${link.ticker} ✓</b> · {Number(link.supply).toLocaleString()} minted ·{' '}
              {link.roomTicker ? 'room open' : 'room opens once indexed'}.
            </p>
          ) : null}
          {link && !busy && !getFundRecord(link.tokenId) ? (
            <FinishIndexing tokenId={link.tokenId} ticker={link.ticker} compact />
          ) : null}
          {link ? null : (
            <>
              <p className="text-[11px]" style={{ color: GRAY }}>
                A personal token, <b className="text-white">${ticker ?? 'NAME'}</b>, all to your wallet, and a chat room
                only holders can enter. Invite someone by sending 1 ${ticker ?? 'NAME'}. It's for access, not trading.
                About {PERSONAL_FEE_ESTIMATE_SATS.toLocaleString()} sats: ~{PERSONAL_NETWORK_FEE_SATS} network fee plus{' '}
                {PERSONAL_INDEX_SATS.toLocaleString()} so other wallets and your room can see the token (1Sat indexing,
                paid once). You confirm it before anything is sent.
              </p>
              <label className="text-[11px] flex items-center gap-2" style={{ color: GRAY }}>
                <input type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.target.checked)} />
                Create my token and room with my handle
              </label>
              {withToken && (
                <label className="text-[11px] flex items-center gap-2" style={{ color: GRAY }}>
                  Supply
                  <input
                    value={supply}
                    inputMode="numeric"
                    onChange={(e) => setSupply(e.target.value)}
                    className="flex-1 rounded-lg px-2 py-1 text-xs bg-transparent outline-none text-white"
                    style={{ border: `1px solid ${supplyError ? '#ff4444' : BORDER}` }}
                  />
                </label>
              )}
              {withToken && supplyError && (
                <span className="text-[11px]" style={{ color: '#ff4444' }}>
                  {supplyError}
                </span>
              )}
              {withToken && claimed && (
                <button
                  type="button"
                  disabled={busy || !ticker || !!supplyError}
                  onClick={() => setConfirming(true)}
                  className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                  style={{ background: GOLD, color: '#000' }}
                >
                  Create ${ticker ?? 'NAME'} token + room
                </button>
              )}
            </>
          )}
          {tokenMsg && (
            <p className="text-xs" style={{ color: GRAY }}>
              {tokenMsg}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl text-sm font-semibold cursor-pointer"
          style={
            claimed
              ? { background: GOLD, color: '#000', border: 0 }
              : { background: 'transparent', color: GRAY, border: `1px solid ${BORDER}` }
          }
        >
          {claimed ? 'Done' : 'Skip for now'}
        </button>
        <SendConfirmation
          show={confirming}
          theme={theme}
          lineItems={[
            // SendConfirmation truncates labels over 16 characters: keep them short.
            {
              address: `$${ticker ?? 'NAME'} + room`.slice(0, 16),
              amount: `${Number(supply || 0).toLocaleString()} tokens`,
            },
            { address: 'Network fee', amount: `~${PERSONAL_NETWORK_FEE_SATS.toLocaleString()} sats` },
            { address: 'Indexing', amount: `${PERSONAL_INDEX_SATS.toLocaleString()} sats` },
          ]}
          total={`~${PERSONAL_FEE_ESTIMATE_SATS.toLocaleString()} sats`}
          isProcessing={busy}
          onConfirm={() => void mintToken()}
          onCancel={() => setConfirming(false)}
        />
      </div>
    </div>
  );
};
