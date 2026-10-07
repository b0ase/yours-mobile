import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BadgeCheck, Check, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { claimPaymail } from '../names/paymail';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { SocialSignIn } from '../social/SocialSignIn';
import { clearSocial, onSocialChange, socialProof } from '../social/socialLogin';
import { deployPersonalToken, openPersonalRoom, PERSONAL_FEE_ESTIMATE_SATS, PERSONAL_NETWORK_FEE_SATS } from '../names/claimPersonal';
import { DEFAULT_SUPPLY, personalTicker, rememberPersonal } from '../names/personalToken';
import { setPaymail } from '../names/accountName';
import { adoptSocialAvatar } from '../names/socialAvatar';
import { showOnWallet } from '../tokens/indexFund';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useTheme } from '../../hooks/useTheme';
import { moneyNow } from '../money/money';
import { PAID_FEATURES_ENABLED, paidFeaturesEnabled } from '../storeBuild';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Settings › Identity › Connect X / Google (owner, 4 Oct 2026): for wallets made before Continue with
 * X, or that skipped it. Signs in, then claims the verified name (b0asex.x@bwalletx.com), which becomes
 * the wallet's identity (the paymail server answers lookups with it; an older plain name still receives).
 */
export const ConnectSocial = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const [proof, setProof] = useState(socialProof);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [claimed, setClaimed] = useState('');
  const { theme } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [minting, setMinting] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');
  // Token icon: the X / Google photo by default; "Choose a different image" overrides it.
  const [socialAvatar, setSocialAvatar] = useState('');
  const [iconImage, setIconImage] = useState<File | null>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const iconPreview = iconImage ? URL.createObjectURL(iconImage) : socialAvatar;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const claimedAlias = claimed.split('@')[0];
  const ticker = personalTicker(claimedAlias);

  /**
   * $B0ASEX + its room for the verified name. One identity per wallet (owner, 4 Oct 2026): the
   * verified name wins, so its token becomes this wallet's personal token.
   */
  const mint = async () => {
    setConfirming(false);
    setMinting(true);
    setTokenMsg('');
    try {
      const l = await deployPersonalToken(apiContext, {
        identityAddress,
        name: claimedAlias,
        supply: DEFAULT_SUPPLY,
        payAddress: account?.addresses?.bsvAddress,
        avatar: socialAvatar || account?.settings?.socialProfile?.avatar || account?.icon,
        iconImage,
      });
      rememberPersonal({ name: l.name, tokenId: l.tokenId });
      void showOnWallet(chromeStorageService, l.tokenId);
      setTokenMsg(`$${l.ticker} minted. Opening its room…`);
      openPersonalRoom(apiContext, identityAddress, l)
        .then(() => setTokenMsg(`$${l.ticker} minted and its room is open. Invite = send 1 $${l.ticker}.`))
        .catch(() => setTokenMsg(`$${l.ticker} minted. Set up its room from Settings › My tokens when you're ready.`));
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Token mint failed');
    } finally {
      setMinting(false);
    }
  };
  useEffect(() => onSocialChange(() => setProof(socialProof())), []);

  const claim = async () => {
    if (!proof?.profile.alias) return;
    setBusy(true);
    setError('');
    try {
      const pm = await claimPaymail(f, apiContext.wallet, proof.profile.alias, {
        ordAddress: account?.addresses?.ordAddress,
        name: proof.profile.provider === 'x' ? proof.profile.name : proof.profile.display || undefined,
        avatar: proof.profile.avatar || undefined,
        social: { ticket: proof.ticket, secret: proof.secret },
      });
      setPaymail(identityAddress, pm);
      setSocialAvatar(proof.profile.avatar || '');
      await adoptSocialAvatar(chromeStorageService, proof.profile.avatar);
      setClaimed(pm);
      clearSocial();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not claim the name');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Connect X or Google</span>
      </div>
      <div className="flex flex-col items-center px-5 pb-10 overflow-y-auto">
        {claimed ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <Check size={36} color="#2ecc71" />
            <p className="mt-3 text-lg font-bold text-white">{claimed} is yours</p>
            <p className="mt-2 text-sm" style={{ color: '#98A2B3' }}>
              {PAID_FEATURES_ENABLED
                ? "This is now your wallet's name. Your token and chat room are named after it. For a different name, add another account."
                : "This is now your wallet's name. For a different name, add another account."}
            </p>
            {paidFeaturesEnabled() && ticker && !tokenMsg.includes('minted') && (
              <div className="mt-6 flex items-center gap-3">
                {iconPreview ? (
                  <img src={iconPreview} alt="" className="w-12 h-12 rounded-full object-cover" />
                ) : (
                  <div className="w-12 h-12 rounded-full" style={{ background: '#17191E' }} />
                )}
                <div className="flex flex-col items-start text-left">
                  <span className="text-xs" style={{ color: '#98A2B3' }}>
                    ${ticker}'s icon (permanent once minted)
                  </span>
                  <button
                    type="button"
                    onClick={() => iconInput.current?.click()}
                    className="text-xs font-semibold bg-transparent border-0 p-0"
                    style={{ color: '#F5B800' }}
                  >
                    Choose a different image
                  </button>
                  <input
                    ref={iconInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => setIconImage(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>
            )}
            {paidFeaturesEnabled() && ticker && !tokenMsg.includes('minted') && (
              <button
                onClick={() => setConfirming(true)}
                disabled={minting}
                className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl py-3 font-bold border-0"
                style={{ background: '#F5B800', color: '#000', opacity: minting ? 0.6 : 1 }}
              >
                {minting && <Loader2 size={16} className="animate-spin" />}
                Create ${ticker} token and room
              </button>
            )}
            {tokenMsg && (
              <p className="mt-3 text-sm" style={{ color: tokenMsg.includes('minted') ? '#D0D5DD' : '#FDA29B' }}>
                {tokenMsg}
              </p>
            )}
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-xl py-3 font-bold"
              style={{ background: 'transparent', color: '#98A2B3', border: '1px solid #2b2f36' }}
            >
              Done
            </button>
            <SendConfirmation
              show={confirming}
              theme={theme}
              lineItems={[
                {
                  address: `$${ticker ?? 'NAME'} + room`.slice(0, 16),
                  amount: `${Number(DEFAULT_SUPPLY).toLocaleString()} tokens`,
                },
                { address: 'Network fee', amount: `~${moneyNow(PERSONAL_NETWORK_FEE_SATS)}` },
              ]}
              total={`~${moneyNow(PERSONAL_FEE_ESTIMATE_SATS)}`}
              isProcessing={minting}
              onConfirm={() => void mint()}
              onCancel={() => setConfirming(false)}
            />
          </div>
        ) : (
          <>
            <p className="text-sm text-center mt-4 mb-5" style={{ color: '#98A2B3' }}>
              Prove your X account or Gmail address to get a verified name like{' '}
              <span className="text-white">yourname.x@{BWALLET_PAYMAIL_DOMAIN}</span>. It becomes this wallet's name, token
              and chat room.
            </p>
            <SocialSignIn onProfile={() => setProof(socialProof())} />
            {proof?.profile.alias && (
              <button
                onClick={() => void claim()}
                disabled={busy}
                className="mt-2 w-[92%] flex items-center justify-center gap-2 rounded-xl py-3 font-bold border-0"
                style={{ background: '#F5B800', color: '#000', opacity: busy ? 0.6 : 1 }}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <BadgeCheck size={16} />}
                Claim {proof.profile.alias}@{BWALLET_PAYMAIL_DOMAIN}
              </button>
            )}
            {proof && !proof.profile.alias && (
              <p className="text-xs mt-2 text-center" style={{ color: '#FDA29B' }}>
                {proof.profile.provider === 'google'
                  ? 'Only @gmail.com addresses get a .gmail name.'
                  : "That X username can't be used as a name."}
              </p>
            )}
            {error && (
              <p className="text-xs mt-3 text-center" style={{ color: '#FDA29B' }}>
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
