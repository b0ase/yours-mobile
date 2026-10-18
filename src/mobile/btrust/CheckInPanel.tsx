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
import { ownerSigner, signCheckIn, verifySpend } from './sign';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const TONE = { ok: '#32D583', soon: GOLD, open: '#F97066' } as const;
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold border-0 cursor-pointer';

type Props = {
  plan: InheritancePlan;
  height: number;
  months: number;
  /** Called with the re-dated plan (save it and give each heir a copy). */
  onPreview: (next: InheritancePlan) => void;
};

export const CheckInPanel = ({ plan, height, months, onPreview }: Props) => {
  const { apiContext } = useServiceContext();
  const [note, setNote] = useState('');
  const [locks, setLocks] = useState<FoundLock[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState<{ tx: Transaction; next: InheritancePlan } | null>(null);
  const c = countdown(plan, height);
  const headline =
    c.tone === 'open'
      ? 'Your heirs can claim now. Check in to push the date back.'
      : `${aboutBlocks(c.heirsBlocks).replace(/^a/, 'A')} until your heirs can claim`;
  const fail = (e: unknown) => setNote(e instanceof Error ? e.message : 'Check-in failed');

  const tap = () => {
    try {
      const next = checkIn(plan, height, months);
      onPreview(next);
      setNote(`Next date: block ${next.heirsHeight.toLocaleString('en-GB')} (about ${months} months).`);
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
      <div className="rounded-xl p-3 border" style={{ borderColor: TONE[c.tone] }}>
        <div className="font-bold" style={{ color: TONE[c.tone] }}>
          {headline}
        </div>
        <div className="text-xs" style={{ color: MUTED }}>
          Block {height.toLocaleString('en-GB')} now. Heirs from block {plan.heirsHeight.toLocaleString('en-GB')}, lead
          heir alone in {aboutBlocks(c.leadBlocks)}.
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
        <div key={`${l.txid}:${l.vout}`} className="flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: MUTED }}>
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
        </div>
      ))}
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
