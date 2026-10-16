/**
 * bTrust heir claim: an heir opens the plan file the owner gave them, sees whether the chain would
 * accept a claim yet, and which seat is theirs. The heir's key is derived from their own seed
 * (BTRUST_PROTOCOL, keyID 'heir'); no server is involved. Building and signing the claim
 * (heirsUnlock / leadHeirUnlock) is not wired yet, so the claim button stays off.
 */
import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BTRUST_PROTOCOL, type InheritancePlan } from './inheritance';
import { claimPath, countdown, heirIndex, parsePlan } from './checkin';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const INPUT = 'w-full rounded-xl bg-[#0f1115] border border-[#2b2f36] p-2 text-white text-sm';

export const HeirClaimPanel = ({ height }: { height: number }) => {
  const { apiContext } = useServiceContext();
  const [myKey, setMyKey] = useState('');
  const [plan, setPlan] = useState<InheritancePlan | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiContext.wallet
      .getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID: 'heir', counterparty: 'self' })
      .then((r) => setMyKey(r.publicKey))
      .catch(() => setMyKey(''));
  }, [apiContext]);

  const onFile = async (f: File | undefined) => {
    setError('');
    setPlan(null);
    if (!f) return;
    try {
      setPlan(parsePlan(await f.text()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that plan');
    }
  };

  const seat = plan && myKey ? heirIndex(plan, myKey) : -1;
  const path = plan ? claimPath(plan, height) : 'none';
  const c = plan ? countdown(plan, height) : null;
  const status = !plan
    ? ''
    : path === 'none'
      ? `Not yet. Any two heirs can claim in about ${c?.heirsDays} days if the owner does not check in.`
      : path === 'heirs'
        ? 'Any two heirs can claim together now. You will need one other heir to sign with you.'
        : `${plan.heirs[0].name} can now claim alone, or any two heirs together.`;

  return (
    <div className="flex flex-col gap-2 text-sm text-white" aria-label="Heir claim">
      <p className="m-0" style={{ color: MUTED }}>
        Named as an heir? Give the owner your heir key below. When the time comes, open the plan file they gave you.
      </p>
      <label className="flex flex-col gap-1">
        Your heir key
        <input readOnly className={INPUT} value={myKey || 'Loading…'} spellCheck={false} aria-label="Your heir key" />
      </label>
      <label>
        Open a plan file <input type="file" accept=".json" onChange={(e) => void onFile(e.target.files?.[0])} />
      </label>
      {error && (
        <p role="alert" className="m-0" style={{ color: '#F97066' }}>
          {error}
        </p>
      )}
      {plan && (
        <div className="flex flex-col gap-1">
          <span>{status}</span>
          <span style={{ color: MUTED }}>
            {seat >= 0
              ? `You are ${seat === 0 ? 'the lead heir' : `heir ${seat + 1}`} (${plan.heirs[seat].name}).`
              : 'Your heir key is not in this plan.'}
          </span>
          <button
            type="button"
            className="rounded-xl px-3 py-2 font-bold border-0"
            style={{ background: GOLD, opacity: 0.5 }}
            disabled
          >
            Claim (coming soon)
          </button>
        </div>
      )}
    </div>
  );
};
