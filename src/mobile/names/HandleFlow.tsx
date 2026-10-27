import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { payNameFee } from './nameFee';
import { X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getPaymail, setPaymail } from './accountName';
import { syncBchatHandle } from './bchatHandle';
import {
  claimPaymail,
  isGmailName,
  lookupPaymail,
  type NameFee,
  paymailConfig,
  nameChangeBlocked,
  paymailAvailable,
  paymailAvailability,
  paymailEnabled,
  PAYMAIL_ALIAS_RE,
  SOCIAL_ALIAS_RE,
  toAlias,
  DISPLAY_NAME_MAX,
  cleanDisplayName,
  defaultDisplayName,
} from './paymail';
import { clearSocial, socialProof } from '../social/socialLogin';
import { checkXOffer, forgetXHandle, rememberedXHandle, xAlias, type XOffer } from '../social/xHandle';
import {
  SOURCE_LABEL,
  canClaimSelection,
  claimOrder,
  forgetLinkedHandles,
  handleFromLinked,
  linkedSuggestions,
  rememberedLinkedHandles,
  resolvePrimary,
  type HandleSource,
} from '../social/linkedHandles';
import { getLinks } from '../social/links';
import { addExtraName, extraFeeLabel, nextExtraNameFee, type ExtraNameFee } from './extraNames';
import { ensureNameRooms } from './nameRooms';
import { BWALLET_PAYMAIL_API, BWALLET_PAYMAIL_DOMAIN, SIBLING_PAYMAIL_DOMAINS } from './config';
import { AvatarPicker } from './AvatarPicker';
import { paymailAvatar } from './avatar';
import { adoptSocialAvatar } from './socialAvatar';
import { getMyName } from './myName';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useTheme } from '../../hooks/useTheme';
import { handleTitle, suggestHandle } from './handlePrompt';
import { useBackClose } from '../backStack';

/**
 * "Choose your handle": a full-screen sheet shown after create / restore (HandleOnboarding) and
 * from the Wallet "Get your $name" card. It claims the paymail name@bwallet.space (signed by the identity key).
 * Owner, 26 Oct 2026: every linked account (X, Google, GitHub, LinkedIn, HandCash) suggests its own $name; the user
 * may claim several and picks exactly one primary (social/linkedHandles.ts), and each claimed name gets its free
 * room (nameRooms.ts). The personal $NAME token + room launcher is no longer here: it moved, unchanged, to
 * PersonalTokenLauncher ("Launch your tokens" card on the wallet home). Optional: a photo (local).
 * The on-chain OpNS name is NOT offered here: it stays a quiet optional link in Settings → Identity.
 * Nothing is broadcast without a confirmation; the user can skip.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#2b2f36';
const GRAY = '#98A2B3';

const f = (u: string, i?: RequestInit) => fetch(u, i);
type AliasState = 'idle' | 'checking' | 'free' | 'mine' | 'taken' | 'reserved' | 'invalid' | 'error';

export const HandleFlow = ({
  onClose,
  title = 'Choose your handle',
  onClaimed,
  suggest,
}: {
  onClose: () => void;
  title?: string;
  /** A verified name to prefill (Sign in with HandCash: first claim on the HandCash handle). */
  suggest?: string;
  /** bChat sign-in waiting on a handle (needs_handle): the caller finishes the sign-in with this name. */
  onClaimed?: (paymail: string) => Promise<void> | void;
}) => {
  useBackClose(true, onClose);
  // The X handle kept from Create is for this sheet only: forget it when the sheet closes.
  useEffect(() => () => forgetXHandle(), []);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const profileName = account?.settings?.socialProfile?.displayName ?? '';
  const [paymail, setPm] = useState(getPaymail(identityAddress));
  const [alias, setAlias] = useState(() => suggest || suggestHandle(profileName, account?.name ?? ''));
  // Optional "Your name" (owner, 15 Oct 2026): shown to people who pay the paymail. Blank → the server uses the handle.
  const [yourName, setYourName] = useState(() => cleanDisplayName(profileName));
  const [state, setState] = useState<AliasState>('idle');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const enabled = paymailEnabled();
  const { theme } = useTheme();
  const claimed = (paymail ? paymail.split('@')[0] : '') || getMyName(identityAddress);
  // 1¢ to claim a new name (anti-squatting, owner 10 Oct 2026); null = free (server fee off).
  const [nameFee, setNameFee] = useState<NameFee | null>(null);
  const [feeConfirm, setFeeConfirm] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void paymailConfig(f).then((c) => live && setNameFee(c.nameFee));
    return () => {
      live = false;
    };
  }, [enabled]);
  // A restored wallet already owns its name: show it instead of suggesting a new one. (The background
  // name sync may not have finished when this opens.) The server answers with the wallet's identity,
  // the handle it chose first, so a stale name stored here is replaced.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => lookupPaymail(f, publicKey))
      .then((p) => {
        if (!live || !p || p === paymail) return;
        setPaymail(identityAddress, p);
        setPm(p);
        if (!socialProof(identityAddress)) setAlias(p.split('@')[0]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Continue with X / Google: nothing is registered for the user (owner, 9 Oct 2026: users choose their
  // handle). X prefills its @name as a suggestion they can change; Google suggests nothing (an email-derived
  // name published the address). Old servers send only `alias` (b0asex.x): its X part is the suggestion.
  const [_suggested] = useState<string | null>(() => {
    const p = socialProof(identityAddress)?.profile;
    if (suggest || !p || p.provider !== 'x') return null;
    const a = toAlias(p.suggested_handle || p.name || '');
    if (a) setTimeout(() => setAlias(a), 0);
    return a || null;
  });
  // Linked X on Create (owner, 24 Oct 2026): propose $handle only when handle@<domain> is free, else free
  // alternatives. The user confirms with a tap; nothing is claimed automatically. Owner, 26 Oct 2026: X is now one
  // of the linked-account suggestions below (same check and alternatives, checkXOffer), not the only one.
  const [xHandle] = useState(() =>
    suggest ? '' : xAlias(socialProof(identityAddress)?.profile) || rememberedXHandle(),
  );

  // All linked accounts, one primary (owner, 26 Oct 2026: it chose the X @name and ignored the Google account linked
  // just before). One suggestion per linked account; never anything from an email the user didn't link.
  const [suggestions] = useState(() => {
    if (suggest) return [];
    const found: Partial<Record<HandleSource, string>> = { ...rememberedLinkedHandles(identityAddress) };
    if (xHandle) found.x = xHandle;
    const p = socialProof(identityAddress)?.profile;
    if (p && p.provider !== 'x' && !found[p.provider])
      found[p.provider] = handleFromLinked(p.provider, p.provider === 'linkedin' ? p.display : p.name);
    for (const l of getLinks(identityAddress)) {
      if (found[l.provider]) continue;
      if (l.provider === 'linkedin') found.linkedin = handleFromLinked('linkedin', l.display);
      else if (l.provider !== 'google' && l.handle) found[l.provider] = handleFromLinked(l.provider, l.handle);
    }
    return linkedSuggestions(found);
  });
  const [offers, setOffers] = useState<Record<string, XOffer>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [extrasDone, setExtrasDone] = useState<string[]>([]);
  const [extraFee, setExtraFee] = useState<(ExtraNameFee & { alias: string }) | null>(null);
  const queue = useRef<string[]>([]);
  const pending = useRef('');
  const roomsFor = useRef<{ names: string[]; primary: string }>({ names: [], primary: '' });
  useEffect(() => {
    if (!enabled || paymail || !suggestions.length) return;
    let live = true;
    for (const s of suggestions)
      void checkXOffer(s.alias, (a) => paymailAvailable(f, a)).then((o) => {
        if (!live) return;
        setOffers((m) => ({ ...m, [s.alias]: o }));
        if (o.kind === 'take') setPicks((m) => ({ ...m, [s.alias]: s.alias }));
        else if (o.kind === 'taken' && o.alternatives[0]) setPicks((m) => ({ ...m, [s.alias]: o.alternatives[0] }));
      });
    return () => {
      live = false;
    };
  }, [enabled, paymail, suggestions]);
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...new Set([...selected, name])] : selected.filter((a) => a !== name);
    setSelected(next);
    setPrimary(resolvePrimary(next, primary));
  };
  const choose = (src: string, from: string, to: string) => {
    setPicks((m) => ({ ...m, [src]: to }));
    if (selected.includes(from)) {
      const next = selected.map((a) => (a === from ? to : a));
      setSelected(next);
      setPrimary(primary === from ? to : resolvePrimary(next, primary));
    }
  };
  /** Claim the selection: the primary through the normal claim (it becomes the main paymail), then the others. */
  const claimSelection = () => {
    const order = claimOrder(selected, primary);
    if (!order.length) return;
    queue.current = order.slice(1);
    pending.current = order[0];
    roomsFor.current = { names: order, primary: order[0] };
    setAlias(order[0]);
    if (nameFee) setFeeConfirm(true);
    else void claim({}, order[0]);
  };
  /**
   * The other names, one after another through the existing extra-name call (Settings › Names: bit-sign then the
   * paymail server). No atomic multi-claim endpoint exists. A name with a fee asks first (its own confirmation).
   */
  const addExtras = async (approved: ExtraNameFee | null = null) => {
    while (queue.current.length) {
      const a = queue.current[0];
      if (!approved) {
        const fee = await nextExtraNameFee(apiContext, f);
        if (fee) return setExtraFee({ alias: a, ...fee });
      }
      await addExtraName(apiContext, f, a, approved);
      approved = null;
      queue.current = queue.current.slice(1);
      setExtrasDone((d) => [...d, a]);
    }
    await finishRooms();
  };
  const finishRooms = async () => {
    const r = roomsFor.current;
    roomsFor.current = { names: [], primary: '' };
    if (r.names.length) await ensureNameRooms(apiContext, identityAddress, r.names, r.primary).catch(() => undefined);
    forgetLinkedHandles(identityAddress);
  };
  const runExtras = (approved: ExtraNameFee | null) => {
    setExtraFee(null);
    setBusy(true);
    addExtras(approved)
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not add that name'))
      .finally(() => setBusy(false));
  };

  // Live availability, debounced.
  useEffect(() => {
    if (!enabled) return;
    if (!alias) return setState('idle');
    // An existing .x / .gmail name of this wallet's stays valid (it keeps receiving); new ones are plain.
    const current = paymail ? paymail.split('@')[0] : '';
    if (!PAYMAIL_ALIAS_RE.test(alias) && !(SOCIAL_ALIAS_RE.test(alias) && alias === current))
      return setState('invalid');
    if (paymail && paymail.split('@')[0] === alias) return setState('free');
    setState('checking');
    let live = true;
    const t = setTimeout(() => {
      apiContext.wallet
        .getPublicKey({ identityKey: true })
        .then(async ({ publicKey }) => {
          const a = await paymailAvailability(f, alias, publicKey);
          if (a.state === 'free' || a.state === 'mine' || a.state === 'reserved') return live && setState(a.state);
          if (a.state === 'invalid') return live && setState('invalid');
          // Taken — by this wallet? Then it's ours (e.g. claimed a moment ago, or a restored wallet).
          const mine =
            (await lookupPaymail(f, publicKey).catch(() => undefined))?.split('@')[0] === alias ||
            (await fetch(`${BWALLET_PAYMAIL_API}/api/paymail/id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((j: { pubkey?: string } | null) => j?.pubkey === publicKey)
              .catch(() => false));
          if (live) setState(mine ? 'mine' : 'taken');
        })
        .catch(() => live && setState('error'));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [alias, enabled, paymail, apiContext.wallet]);

  /** Pay the 1¢ name fee with the normal wallet send, then claim with its txid. */
  const payAndClaim = async () => {
    setFeeConfirm(false);
    if (!nameFee) return claim();
    setBusy(true);
    setMsg('');
    try {
      await claim(await payNameFee(apiContext, nameFee), pending.current || alias);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
      setBusy(false);
    }
  };

  const claim = async (fee: { feeTxid?: string; feeTx?: string } = {}, name = alias) => {
    setBusy(true);
    setMsg('');
    try {
      // The sign-in only lends its photo and display name; the handle is the one typed here.
      const proof = socialProof(identityAddress);
      const pm = await claimPaymail(f, apiContext.wallet, name, {
        ordAddress,
        name:
          cleanDisplayName(yourName) ||
          cleanDisplayName(proof?.profile.display) ||
          cleanDisplayName(profileName) ||
          undefined,
        avatar: paymailAvatar(proof?.profile.avatar || account?.settings?.socialProfile?.avatar),
        ...fee,
      });
      if (proof) {
        await adoptSocialAvatar(chromeStorageService, proof.profile.avatar);
        clearSocial();
      }
      forgetXHandle();
      setPaymail(identityAddress, pm);
      setPm(pm);
      // bChat handle = paymail name, before any token room is opened under it. A sign-in that was
      // waiting on a handle finishes with its own claim token instead (onClaimed).
      if (onClaimed) await onClaimed(pm);
      else await syncBchatHandle(apiContext, pm, { signIn: true });
      // Owner, 26 Oct 2026: no token here any more (PersonalTokenLauncher). The other selected names follow, then
      // each claimed name's free room (nameRooms.ts: no payment, no mint).
      pending.current = '';
      if (!roomsFor.current.names.length) roomsFor.current = { names: [name], primary: name };
      await addExtras();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const owned = (!!paymail && paymail.split('@')[0] === alias) || state === 'mine';
  const blocked = nameChangeBlocked(paymail, alias);
  const stateText: Record<AliasState, string> = {
    idle: '',
    checking: 'Checking…',
    free: owned ? 'Yours ✓' : 'Available',
    mine: 'Yours ✓',
    taken: 'Taken. Try another.',
    reserved: 'Reserved. This name is kept for the bWalletX team. Try another.',
    invalid: 'Use a-z, 0-9, - or _',
    error: "Couldn't check. Check your connection.",
  };

  // Portalled to <body>: opened from inside the wallet page (WalletCard, TopNav), a transformed ancestor such as
  // the pull-to-refresh container became the containing block of this fixed sheet, so it drew inside the page
  // between the card and the token list and its Close/Done were hard or impossible to reach (owner, 11 Oct 2026).
  return createPortal(
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
            A name people can pay instead of a long address. You choose it; change it any time in Settings → Identity,
            and your old name keeps receiving.
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
              <span className="text-[10px] font-semibold" style={{ color: nameFee ? GOLD : '#2ecc71' }}>
                {nameFee ? '1¢ · instant' : paymail ? 'Free · instant' : 'Your first name is free'}
              </span>
            </div>
            {!paymail && suggestions.length > 0 && (
              <div
                className="rounded-xl p-3 flex flex-col gap-2"
                style={{ background: '#0b0c0f', border: `1px solid ${GOLD}` }}
                data-testid="linked-handles"
              >
                <p className="text-xs m-0" style={{ color: GRAY }}>
                  From your linked accounts. Claim one or more (each is your own paymail, same wallet) and pick one{' '}
                  <b className="text-white">primary</b>: it becomes your main name.
                </p>
                {suggestions.map((sg) => {
                  const o = offers[sg.alias];
                  const name = picks[sg.alias] || '';
                  const on = !!name && selected.includes(name);
                  return (
                    <div key={sg.source} className="flex flex-col gap-1.5 rounded-lg p-2" style={{ background: PANEL }}>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!name || busy}
                          onChange={(e) => toggle(name, e.target.checked)}
                          aria-label={`Claim $${name || sg.alias}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-white truncate">
                            <b style={{ color: GOLD }}>${name || sg.alias}</b>
                          </div>
                          <div className="text-[11px]" style={{ color: GRAY }}>
                            {SOURCE_LABEL[sg.source]} · {sg.source === 'x' ? `@${sg.alias}` : sg.alias}
                            {!o || o.kind === 'none'
                              ? ' · checking…'
                              : o.kind === 'take'
                                ? ' · available'
                                : ` · ${sg.alias}@${BWALLET_PAYMAIL_DOMAIN} is taken`}
                          </div>
                        </div>
                        <label className="flex items-center gap-1 text-[11px]" style={{ color: on ? '#fff' : GRAY }}>
                          <input
                            type="radio"
                            name="primary-handle"
                            checked={on && primary === name}
                            disabled={!on || busy}
                            onChange={() => setPrimary(name)}
                          />
                          Primary
                        </label>
                      </div>
                      {o?.kind === 'taken' && (
                        <div className="flex flex-wrap gap-2">
                          {o.alternatives.length ? (
                            o.alternatives.map((alt) => (
                              <button
                                key={alt}
                                type="button"
                                onClick={() => choose(sg.alias, name, alt)}
                                className="h-7 px-3 rounded-full text-xs font-semibold border-0 cursor-pointer"
                                style={
                                  name === alt
                                    ? { background: GOLD, color: '#000' }
                                    : { background: BORDER, color: '#fff' }
                                }
                              >
                                ${alt}
                              </button>
                            ))
                          ) : (
                            <span className="text-[11px]" style={{ color: GRAY }}>
                              No free alternative found; type one below.
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={busy || !canClaimSelection(selected, primary)}
                  onClick={claimSelection}
                  className="h-10 rounded-lg text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                  style={{ background: GOLD, color: '#000' }}
                  data-testid="claim-linked"
                >
                  {busy
                    ? 'Claiming…'
                    : !selected.length
                      ? 'Tick the names to claim'
                      : !primary
                        ? 'Pick your primary name'
                        : `Claim ${selected.length === 1 ? `$${primary}` : `${selected.length} names`} · primary $${primary}${nameFee ? ' · 1¢' : ''}`}
                </button>
              </div>
            )}
            {extrasDone.length > 0 && (
              <p className="text-xs text-white m-0">Also yours: {extrasDone.map((a) => `$${a} ✓`).join(', ')}</p>
            )}
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
                color:
                  state === 'free' || state === 'mine'
                    ? '#2ecc71'
                    : state === 'checking' || state === 'idle'
                      ? GRAY
                      : '#ff4444',
              }}
            >
              {stateText[state]}
            </span>
            {!!alias && (state === 'free' || state === 'mine') && SIBLING_PAYMAIL_DOMAINS.length > 0 && (
              <span className="text-[11px]" style={{ color: GRAY }}>
                Also yours, same key: {SIBLING_PAYMAIL_DOMAINS.map((d) => `${alias}@${d}`).join(', ')}
              </span>
            )}
            {isGmailName(paymail) && (
              <p className="text-xs" style={{ color: GOLD }}>
                Choose a name — your current address shows your Gmail. Your old address keeps receiving for 90 days.
              </p>
            )}
            {paymail && (
              <p className="text-xs text-white">
                <b style={{ color: GOLD }}>{paymail} ✓</b> receives BSV and tokens from any paymail wallet.
              </p>
            )}
            {!owned && blocked && (
              <p className="text-xs" style={{ color: GRAY }}>
                {blocked}
              </p>
            )}
            {!paymail && (
              <input
                value={yourName}
                maxLength={DISPLAY_NAME_MAX}
                placeholder={`Your name (optional), e.g. ${defaultDisplayName(alias) || 'Mike Smith'}`}
                aria-label="Your name"
                onChange={(e) => setYourName(e.target.value)}
                className="rounded-xl px-3 h-11 outline-none text-sm text-white"
                style={{ background: '#0b0c0f', border: `1px solid ${BORDER}` }}
              />
            )}
            {/* With a paymail already, offer "Change to" only once a different name is typed (owner, 11 Oct 2026). */}
            {!owned && !blocked && (!paymail || (!!alias && `${alias}@${BWALLET_PAYMAIL_DOMAIN}` !== paymail)) && (
              <button
                type="button"
                disabled={busy || state !== 'free'}
                onClick={() => (nameFee ? setFeeConfirm(true) : void claim())}
                className="h-11 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                style={{ background: GOLD, color: '#000' }}
              >
                {busy
                  ? 'Claiming…'
                  : `${paymail ? 'Change to' : 'Claim'} ${alias || 'name'}@${BWALLET_PAYMAIL_DOMAIN}${nameFee ? ' · 1¢' : ''}`}
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
          show={feeConfirm}
          theme={theme}
          lineItems={[{ address: `Claim $${alias}`.slice(0, 16), amount: '1¢' }]}
          total="1¢"
          isProcessing={busy}
          onConfirm={() => void payAndClaim()}
          onCancel={() => setFeeConfirm(false)}
        />
        <SendConfirmation
          show={!!extraFee}
          theme={theme}
          lineItems={[
            {
              address: `Add $${extraFee?.alias ?? ''}`.slice(0, 16),
              amount: extraFeeLabel(extraFee),
            },
          ]}
          total={extraFeeLabel(extraFee)}
          isProcessing={busy}
          onConfirm={() => extraFee && runExtras(extraFee)}
          onCancel={() => (setExtraFee(null), (queue.current = []), void finishRooms())}
        />
      </div>
    </div>,
    document.body,
  );
};
