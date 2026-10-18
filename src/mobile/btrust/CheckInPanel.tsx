/**
 * bTrust check-in ("I'm still here"): countdown to the heirs' date, a seed-only scan for your bTrust locks
 * (derive.ts: no plan file, no server) and a real check-in for each live lock: the wallet signs the owner
 * branch (sign.ts), the app verifies the spend locally, and only then offers to broadcast it.
 */
import { useState } from 'react';
import type { Transaction } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { aboutBlocks, BTRUST_PROTOCOL, checkIn, type InheritancePlan } from './inheritance';
import { countdown } from './checkin';
import { planLabel } from './planFile';
import { broadcast, scanForLocks, wocChain, type FoundLock } from './derive';
import { ownerSigner, signCheckIn, signWithdraw, verifySpend } from './sign';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const TONE = { ok: '#32D583', soon: GOLD, open: '#F97066' } as const;
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold border-0 cursor-pointer';

type Props = {
  /** The plan on screen (step 2), if any. Finding and checking in your locks works without one. */
  plan: InheritancePlan | null;
  height: number;
  months: number;
  /** Called with the re-dated plan (save it and give each heir a copy). */
  onPreview: (next: InheritancePlan) => void;
};

export const CheckInPanel = ({ plan, height, months, onPreview }: Props) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [withdraw, setWithdraw] = useState<{ tx: Transaction; to: string } | null>(null);
  const [note, setNote] = useState('');
  const [locks, setLocks] = useState<FoundLock[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState<{ tx: Transaction; next: InheritancePlan } | null>(null);
  const c = plan ? countdown(plan, height) : null;
  const headline = !c
    ? ''
    : c.tone === 'open'
      ? 'Your heirs can claim now. Check in to push the date back.'
      : `${aboutBlocks(c.heirsBlocks).replace(/^a/, 'A')} until your heirs can claim`;
  const fail = (e: unknown) => setNote(e instanceof Error ? e.message : 'Check-in failed');

  // Preview only: never rewrites the plan on screen (that plan may be about to be funded). The real check-in is
  // per lock below, signed and verified.
  const tap = () => {
    if (!plan) return;
    try {
      const next = checkIn(plan, height, months);
      setNote(
        `Checking in would move the date to block ${next.heirsHeight.toLocaleString('en-GB')} ` +
          `(in ${aboutBlocks(next.heirsHeight - height)}). Use Find my locks, then Check in on a lock.`,
      );
    } catch (e) {
      fail(e);
    }
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote('');
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const scan = () =>
    run(async () => {
      const keys = async (keyID: string) =>
        (await apiContext.wallet.getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID, counterparty: 'self' })).publicKey;
      const live = (await scanForLocks(keys, wocChain())).locks.filter((l) => !l.spent);
      setLocks(live);
      if (!live.length) setNote('No live bTrust locks found for this wallet.');
    });

  const sign = (lock: FoundLock) =>
    run(async () => {
      const next = checkIn(lock.plan, height, months);
      const tx = await signCheckIn({
        lockTx: lock.tx,
        vout: lock.vout,
        plan: lock.plan,
        next,
        owner: await ownerSigner(apiContext.wallet, lock.slot),
      });
      setSigned({ tx, next });
    });

  // Cancel a lock: owner branch back to this account's own receive address (any time, no heirs involved).
  const signOut = (lock: FoundLock) =>
    run(async () => {
      const to = chromeStorageService.getCurrentAccountObject().account?.addresses?.bsvAddress;
      if (!to) throw new Error('Could not find this account’s receive address.');
      const tx = await signWithdraw({
        lockTx: lock.tx,
        vout: lock.vout,
        plan: lock.plan,
        owner: await ownerSigner(apiContext.wallet, lock.slot),
        payTo: to,
      });
      setSigned(null);
      setWithdraw({ tx, to });
    });

  const sendOut = () =>
    run(async () => {
      if (!withdraw || !verifySpend(withdraw.tx)) throw new Error('That did not verify, so it was not sent.');
      const txid = await broadcast(withdraw.tx);
      setWithdraw(null);
      setLocks(null);
      setNote(`Moved back to your wallet. Transaction ${txid}. It shows in your balance once the wallet sees it.`);
    });

  const send = () =>
    run(async () => {
      if (!signed || !verifySpend(signed.tx)) throw new Error('That check-in did not verify, so it was not sent.');
      const txid = await broadcast(signed.tx);
      onPreview(signed.next);
      setSigned(null);
      setLocks(null);
      setNote(`Checked in. Transaction ${txid}. Save the new plan and give each heir a copy.`);
    });

  return (
    <div className="flex flex-col gap-2 text-sm text-white" aria-label="Check in">
      {plan && c && (
        <>
          <div className="rounded-xl p-3 border" style={{ borderColor: TONE[c.tone] }}>
            <div className="font-bold" style={{ color: TONE[c.tone] }}>
              {headline}
            </div>
            <div className="text-xs" style={{ color: MUTED }}>
              Block {height.toLocaleString('en-GB')} now. Heirs from block {plan.heirsHeight.toLocaleString('en-GB')},
              lead heir alone in {aboutBlocks(c.leadBlocks)}.
            </div>
          </div>
          <button
            type="button"
            className="rounded-xl px-3 py-3 text-base font-bold border-0 cursor-pointer"
            style={{ background: GOLD }}
            disabled={!height}
            onClick={tap}
          >
            I&apos;m still here
          </button>
        </>
      )}
      <button
        type="button"
        className={BTN}
        style={{ background: '#2b2f36', color: 'white' }}
        disabled={busy}
        onClick={() => void scan()}
      >
        Find my locks (from this wallet&apos;s seed)
      </button>
      {locks?.map((l) => (
        <div key={`${l.txid}:${l.vout}`} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs w-full" style={{ color: MUTED }}>
            {planLabel(l.plan)} · {l.sats.toLocaleString('en-GB')} sats · heirs from block{' '}
            {l.plan.heirsHeight.toLocaleString('en-GB')}
          </span>
          <button
            type="button"
            className={BTN}
            style={{ background: GOLD }}
            disabled={busy || !height}
            onClick={() => void sign(l)}
          >
            Check in
          </button>
          <button
            type="button"
            className={BTN}
            style={{ background: 'transparent', color: GOLD, border: `1px solid ${GOLD}` }}
            disabled={busy}
            onClick={() => void signOut(l)}
          >
            Move to my wallet
          </button>
        </div>
      ))}
      {withdraw && (
        <div className="flex flex-col gap-1">
          <span className="text-xs break-all" style={{ color: MUTED }}>
            Signed and verified on this device. Moves {withdraw.tx.outputs[0].satoshis?.toLocaleString('en-GB')} sats to
            your wallet ({withdraw.to}) and ends this lock.
          </span>
          <button
            type="button"
            className={BTN}
            style={{ background: GOLD }}
            disabled={busy}
            onClick={() => void sendOut()}
          >
            Send to my wallet
          </button>
        </div>
      )}
      {signed && (
        <div className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: MUTED }}>
            Signed and verified on this device. Re-locks {signed.tx.outputs[0].satoshis?.toLocaleString('en-GB')} sats
            until block {signed.next.heirsHeight.toLocaleString('en-GB')}.
          </span>
          <button
            type="button"
            className={BTN}
            style={{ background: GOLD }}
            disabled={busy}
            onClick={() => void send()}
          >
            Send check-in
          </button>
        </div>
      )}
      {note && (
        <p className="m-0 text-xs break-all" style={{ color: MUTED }}>
          {note}
        </p>
      )}
    </div>
  );
};
