import { useEffect, useState } from 'react';
import { AtSign, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { GetYourName, NODE_SCRIPT_ESTIMATE, PHONE_HASHRATE, REGISTER_FEE_ESTIMATE_SATS } from './GetYourName';
import { getPaymail, setPaymail } from './accountName';
import { claimPaymail, paymailAvailable, paymailEnabled, PAYMAIL_ALIAS_RE, toAlias } from './paymail';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import { PERSONAL_FEE_ESTIMATE_SATS } from './claimPersonal';
import { estimateMintFee } from './opnsMint';
import { EXPECTED_HASHES } from './opnsPow';
import { formatEta } from './opnsRegister';
import { handleTitle, suggestHandle } from './handlePrompt';

/**
 * "Choose your handle": a full-screen sheet shown after create / restore (HandleOnboarding) and
 * from the Wallet "Get your $name" card. Step 1 claims the free paymail name@b0ase.com (signed by
 * the identity key, no transaction). Step 2 is opt-in: the on-chain OpNS name and the personal
 * $NAME token + room, both via the existing Settings flow (GetYourName), which shows every fee
 * on the standard confirmation sheet before anything is broadcast.
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const BORDER = '#2b2f36';
const GRAY = '#98A2B3';

const f = (u: string, i?: RequestInit) => fetch(u, i);
type AliasState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'error';

export const HandleFlow = ({ onClose, title = 'Choose your handle' }: { onClose: () => void; title?: string }) => {
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
  const [more, setMore] = useState(false);
  const enabled = paymailEnabled();

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
      const pm = await claimPaymail(f, apiContext.wallet, alias, { ordAddress, name: profileName });
      setPaymail(identityAddress, pm);
      setPm(pm);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const perChar = estimateMintFee(NODE_SCRIPT_ESTIMATE);
  const perCharTime = formatEta(EXPECTED_HASHES / PHONE_HASHRATE);
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
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: PANEL, border: `2px solid ${GOLD}` }}
          >
            <AtSign size={26} color={GOLD} />
          </span>
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
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            className="flex items-center justify-between bg-transparent border-0 p-0 cursor-pointer"
            aria-expanded={more}
          >
            <span className="text-sm font-semibold text-white">Go on-chain (optional)</span>
            {more ? <ChevronUp size={16} color={GRAY} /> : <ChevronDown size={16} color={GRAY} />}
          </button>
          <ul className="flex flex-col gap-1.5 text-[11px] list-none p-0 m-0" style={{ color: GRAY }}>
            <li>
              <b className="text-white">OpNS name</b>: mined on this phone, one transaction per new character. About{' '}
              {perChar.toLocaleString()} sats network fee and {perCharTime} of mining per character, plus{' '}
              {REGISTER_FEE_ESTIMATE_SATS} sats to bind it. Keep the app open while it mines.
            </li>
            <li>
              <b className="text-white">Personal $NAME token + room</b>: about {PERSONAL_FEE_ESTIMATE_SATS} sats. A
              token for access (not trading) and a chat room only holders can enter.
            </li>
            <li>Nothing is sent until you confirm the fee on the next sheet.</li>
          </ul>
          {more && (
            <div className="pt-2">
              <GetYourName profileName={paymail ? paymail.split('@')[0] : alias || profileName} />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl text-sm font-semibold cursor-pointer"
          style={
            paymail
              ? { background: GOLD, color: '#000', border: 0 }
              : { background: 'transparent', color: GRAY, border: `1px solid ${BORDER}` }
          }
        >
          {paymail ? 'Done' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
};
