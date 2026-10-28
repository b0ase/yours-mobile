import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Loader2, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { onSocialChange, socialProof, startSocial } from '../social/socialLogin';
import { setPaymail } from './accountName';
import { bindMyNames, claimPaymail, cleanDisplayName, mintNameToken, nameTokenStatus, proveName } from './paymail';
import { paymailAvatar } from './avatar';
import {
  NAME_PROVIDER_LABEL,
  clearNameChoice,
  nextNameStep,
  onNameChoiceStep,
  pendingNameChoice,
  type NameChoice,
} from './nameChoice';

const f = (u: string, i?: RequestInit) => fetch(u, i);
type Phase = 'idle' | 'claiming' | 'minting' | 'done' | 'error';

/**
 * "Your name" (owner, 28 Oct 2026): finishes the name chosen on the first screen once the wallet exists. It claims the
 * social handle as the account's main paymail, signs its binding, and mints the name as a free 1:1 name token (bCorp
 * pays the network fee). Shown on the wallet home beside the link card.
 *
 * Kept apart from "Create a token" (fungible tokens a user issues and may sell): its own card, its own words, its own
 * server call (name-token-mint), no shared button. A name token is your paymail; you can give or sell it like any
 * token, and the Proven badge stays only while the account behind it holds it.
 */
export const YourName = ({ owner }: { owner: string }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const [choice, setChoice] = useState<NameChoice | null>(() => pendingNameChoice());
  const [proof, setProof] = useState(() => socialProof(owner));
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState('');
  const [origin, setOrigin] = useState('');
  const [hidden, setHidden] = useState(false);
  const running = useRef(false);
  useEffect(() => onSocialChange(() => setProof(socialProof(owner))), [owner]);
  useEffect(() => onNameChoiceStep(() => setChoice(pendingNameChoice())), []);
  const step = nextNameStep(choice, proof);

  // Claim, sign, mint. Each step can be retried; a name already claimed by this wallet just continues.
  useEffect(() => {
    if (step !== 'claim' || !choice || !proof || !apiContext?.wallet || running.current) return;
    running.current = true;
    const wallet = apiContext.wallet;
    void (async () => {
      try {
        setPhase('claiming');
        const pm = await claimPaymail(f, wallet, choice.alias, {
          ordAddress,
          name: cleanDisplayName(proof.profile.display) || undefined,
          avatar: paymailAvatar(proof.profile.avatar ?? undefined),
          social: { ticket: proof.ticket, secret: proof.secret },
        });
        setPaymail(owner, pm);
        // Google: a sign-in that carries this wallet's key also stores the "Proven by Google" proof.
        if (choice.provider === 'google' && proof.profile.id_token)
          await proveName(f, wallet, choice.alias, proof).catch(() => undefined);
        const { publicKey } = await wallet.getPublicKey({ identityKey: true });
        await bindMyNames(f, wallet, publicKey);
        setPhase('minting');
        const existing = await nameTokenStatus(f, choice.alias);
        const m = existing ?? (await mintNameToken(f, wallet, choice.alias, ordAddress));
        setOrigin(m.origin);
        setPhase('done');
        clearNameChoice();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Something went wrong');
        setPhase('error');
      } finally {
        running.current = false;
      }
    })();
  }, [step, choice, proof, apiContext, ordAddress, owner]);

  if (hidden || (!choice && phase !== 'done')) return null;
  const signIn = async (provider: NameChoice['provider']) => {
    setMsg('');
    try {
      const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
      await startSocial(provider, owner, undefined, publicKey);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Sign-in is unavailable right now');
    }
  };
  const name = choice?.alias ?? '';
  return (
    <div
      className="w-[92%] mt-3 rounded-2xl px-4 py-3 flex flex-col gap-1.5"
      style={{ background: 'var(--bw-surface)', border: '1px solid var(--bw-line, #3a2f0c)' }}
      data-testid="your-name-card"
    >
      <div className="flex items-center gap-2">
        <BadgeCheck size={16} color="var(--bw-accent-hi)" />
        <span className="flex-1 min-w-0 text-sm font-bold truncate" style={{ color: 'var(--bw-accent-hi)' }}>
          Your name{name ? `: ${name}` : ''}
        </span>
        {phase === 'done' || phase === 'error' ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setHidden(true)}
            className="p-1 bg-transparent border-0"
          >
            <X size={14} color="#98A2B3" />
          </button>
        ) : null}
      </div>
      <div className="text-[12px]" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
        {step === 'confirm-linkedin' && choice
          ? 'One more LinkedIn sign-in ties this name to your LinkedIn account and to this wallet.'
          : step === 'sign-in-again' && choice
            ? `Your ${NAME_PROVIDER_LABEL[choice.provider]} sign-in ran out. Sign in again to claim ${name}.`
            : phase === 'claiming'
              ? 'Setting up your name…'
              : phase === 'minting'
                ? 'Minting your name token. It is free: we cover the network fee.'
                : phase === 'done'
                  ? 'Your name token is in your wallet. It is yours to keep, give or sell. If it changes hands, the Proven badge stays with the account you signed in with.'
                  : phase === 'error'
                    ? msg
                    : ''}
      </div>
      {phase === 'claiming' || phase === 'minting' ? <Loader2 size={14} className="animate-spin" /> : null}
      {origin ? (
        <div className="text-[10px] truncate" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
          Token {origin}
        </div>
      ) : null}
      {(step === 'confirm-linkedin' || step === 'sign-in-again' || phase === 'error') && choice ? (
        <button
          type="button"
          onClick={() => void signIn(choice.provider)}
          className="h-10 rounded-lg text-[13px] font-semibold border-0 cursor-pointer"
          style={{ background: 'var(--bw-accent-hi)', color: '#15202B' }}
          data-testid="your-name-sign-in"
        >
          {step === 'confirm-linkedin'
            ? 'Confirm with LinkedIn'
            : `Sign in with ${NAME_PROVIDER_LABEL[choice.provider]}`}
        </button>
      ) : null}
      {msg && phase !== 'error' ? (
        <div className="text-[11px]" style={{ color: '#FDA29B' }}>
          {msg}
        </div>
      ) : null}
    </div>
  );
};
