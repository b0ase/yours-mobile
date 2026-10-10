import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../backStack';
import { parseUsdInput } from '../money/money';
import { ErrorActions } from '../errors/ErrorActions';
import { reschedulePotReminders } from './notifyPots';
import { addSubscription } from './pots';
import {
  FUND_AMOUNTS,
  FUND_MONTHS,
  existingFundPot,
  fundMemo,
  fundPlan,
  fundProblem,
  fundSub,
  startFundPot,
} from './fund';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';

const chip = (on: boolean) => ({ background: on ? GOLD : LINE, color: on ? '#000' : '#fff' });

/**
 * Back bWalletX: pick $ a month and how many months to set aside. With no fund pot yet, Create pot makes one
 * (Add account, then the subscription is attached by agentCreate.ts); with one, Start adds the monthly payment.
 */
export const BackFundSheet = ({
  rate,
  identityPubKey,
  onClose,
  onCreatePot,
}: {
  rate: number;
  identityPubKey: string | undefined;
  onClose: () => void;
  /** Opens Add account for the new pot (PotsScreen's create, after startFundPot has named it). */
  onCreatePot: () => void;
}) => {
  useBackClose(true, onClose);
  const [usd, setUsd] = useState<number>(10);
  const [custom, setCustom] = useState('');
  const [months, setMonths] = useState<number>(6);
  const [error, setError] = useState('');
  const monthly = custom.trim() ? (parseUsdInput(custom) ?? 0) : usd;
  const plan = fundPlan(monthly, months, rate);
  const pot = existingFundPot();
  const problem = fundProblem(monthly, months) ?? (identityPubKey ? null : 'Open your main account first');

  const go = () => {
    if (problem) return setError(problem);
    try {
      if (pot) {
        addSubscription(fundSub(pot.identityAddress, monthly, fundMemo(identityPubKey as string)), rate);
        void reschedulePotReminders();
        onClose();
      } else {
        startFundPot(monthly, identityPubKey as string);
        onCreatePot();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[430] flex items-end" style={{ background: '#000a' }} onClick={onClose}>
      <div
        className="w-full rounded-t-2xl p-4 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        style={{ background: CARD, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">Back bWalletX</div>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          Support bWalletX development with a monthly amount in dollars. It pays from its own pot at the day&apos;s BSV
          rate when you open the wallet. Stop any time and the rest stays in your pot.
        </p>
        <div className="text-xs font-bold text-white">Each month</div>
        <div className="flex gap-2 flex-wrap">
          {FUND_AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => {
                setUsd(a);
                setCustom('');
              }}
              className="rounded-full px-4 py-2 text-sm font-bold border-0"
              style={chip(!custom.trim() && usd === a)}
            >
              ${a}
            </button>
          ))}
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Other $"
            inputMode="decimal"
            className="rounded-full px-4 py-2 text-sm text-white outline-none border w-24"
            style={{ background: '#010101', borderColor: custom.trim() ? GOLD : LINE }}
          />
        </div>
        <div className="text-xs font-bold text-white">Set aside</div>
        <div className="flex gap-2 flex-wrap">
          {FUND_MONTHS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMonths(m)}
              className="rounded-full px-4 py-2 text-sm font-bold border-0"
              style={chip(months === m)}
            >
              {m} months
            </button>
          ))}
        </div>
        <div className="rounded-xl p-3 text-sm" style={{ background: '#010101', border: `1px solid ${LINE}` }}>
          <div className="text-white font-bold">
            ${monthly > 0 ? monthly.toFixed(2) : '0.00'} a month · put ${plan.setAsideUsd.toFixed(2)} in the pot
          </div>
          {plan.setAsideSats !== null && (
            <div className="text-xs mt-1" style={{ color: MUTED }}>
              About {(plan.setAsideSats / 1e8).toFixed(4)} BSV at today&apos;s rate. Top up whenever you like.
            </div>
          )}
        </div>
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          This is support, not an investment: nothing is paid back. Supporters get a Supporter badge on bChatX, their
          name in the credits and early beta builds.
        </p>
        {error && (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs" style={{ color: '#FDA29B' }}>
              {error}
            </div>
            <ErrorActions message={error} />
          </div>
        )}
        <button
          type="button"
          onClick={go}
          className="rounded-xl py-3 font-bold border-0"
          style={{ background: GOLD, color: '#000', opacity: problem ? 0.5 : 1 }}
        >
          {pot ? `Start $${monthly > 0 ? monthly.toFixed(2) : '0'} a month` : 'Create the Back bWalletX pot'}
        </button>
      </div>
    </div>,
    document.body,
  );
};
