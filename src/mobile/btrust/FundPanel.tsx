/**
 * bTrust funding: choose an amount, approve it on one sheet (amount, heirs, timings), and the wallet locks it
 * under the plan from its normal balance (fund.ts). The plan is kept on this device and offered as a download.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fmtSats } from '../money/money';
import { fundLock, MIN_LOCK_SATS, savePlanLocally } from './fund';
import { planFileName, planJson, planLabel, withFunding } from './planFile';
import { aboutBlocks, type InheritancePlan } from './inheritance';
import { TEST_BANNER } from './testMode';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const INPUT = 'w-full rounded-xl bg-[#0f1115] border border-[#2b2f36] p-2 text-white text-sm';
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold border-0 cursor-pointer';

type Props = {
  plan: InheritancePlan;
  slot: number;
  height: number;
  download: (name: string, text: string) => void;
  /** The plan with slot, funding txid, vout and createdAt, after funding. */
  onFunded?: (plan: InheritancePlan) => void;
};

export const FundPanel = ({ plan, slot, height, download, onFunded }: Props) => {
  const { apiContext } = useServiceContext();
  const [sats, setSats] = useState(10_000);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [funded, setFunded] = useState<InheritancePlan | null>(null);
  const file = (p: InheritancePlan = funded ?? plan) => download(planFileName(p), planJson(p));

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      const f = await fundLock({ wallet: apiContext.wallet, plan, slot, sats });
      const full = withFunding(plan, { slot, fundingTxid: f.txid, vout: f.vout });
      savePlanLocally({ txid: f.txid, slot, plan: full, savedAt: Date.now() });
      setSheet(false);
      setDone(f.txid);
      setFunded(full);
      onFunded?.(full);
      file(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not lock the coins');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm text-white" aria-label="Fund the lock">
      <label className="flex gap-2 items-center">
        Lock
        <input
          type="number"
          className={INPUT}
          style={{ width: 140 }}
          min={MIN_LOCK_SATS}
          value={sats}
          onChange={(e) => setSats(Math.floor(Number(e.target.value)))}
        />
        sats
      </label>
      <button
        type="button"
        className={BTN}
        style={{ background: GOLD }}
        disabled={busy || sats < MIN_LOCK_SATS || !!done}
        onClick={() => setSheet(true)}
      >
        Lock for my heirs
      </button>
      {done && (
        <>
          <span style={{ color: MUTED }} className="break-all">
            Locked. Transaction {done}. The plan is saved on this device; give each heir a copy.
          </span>
          <button type="button" className={BTN} style={{ background: GOLD }} onClick={() => file()}>
            Download the plan again
          </button>
        </>
      )}
      {sheet &&
        createPortal(
          <div
            className="fixed inset-0 z-[420] flex flex-col"
            style={{
              background: CARD.bg,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <ApprovalCard
              ours
              site="bWalletX"
              siteSub="bTrust · Passing on"
              onClose={() => setSheet(false)}
              closeDisabled={busy}
              hero={<PayHero amount={fmtSats(sats)} sub="locked for your heirs, yours until then" badge="LOCK" />}
              title={
                <>
                  Lock <span style={{ color: CARD.gold }}>{fmtSats(sats)}</span> for your heirs
                  <div style={{ fontSize: 14, opacity: 0.7 }}>{planLabel(plan)}</div>
                </>
              }
              primary={{ label: 'Allow', onClick: () => void approve(), busy, disabled: busy }}
              secondary={{ label: 'Not now', onClick: () => setSheet(false), disabled: busy }}
              error={error}
            >
              {plan.test && (
                <div
                  role="alert"
                  className="rounded-2xl p-4 text-center text-lg font-extrabold text-white"
                  style={{ background: '#D92D20' }}
                >
                  {TEST_BANNER}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {plan.heirs.map((h, i) => (
                  <Chip key={h.pubKey} solid={i === 0}>
                    {h.name}
                    {i === 0 ? ' (lead)' : ''}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip>You: any time</Chip>
                <Chip>Any 2 heirs: in {aboutBlocks(plan.heirsHeight - height)}</Chip>
                <Chip>Lead alone: in {aboutBlocks(plan.leadHeight - height)}</Chip>
                <Chip>Check in to push back</Chip>
              </div>
            </ApprovalCard>
          </div>,
          document.body,
        )}
    </div>
  );
};
