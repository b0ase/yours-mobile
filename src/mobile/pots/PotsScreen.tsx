import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronRight, Copy, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useBackClose } from '../backStack';
import { routeFor } from '../tabs/tabs';
import { requestPayAfterSwitch } from '../wallet/payNav';
import { useBsvUsd } from '../money/money';
import { PixelGhost } from '../agents/PixelGhost';
import { getAgentAccount, getAgentLog, ghostColorOf, onAgentsChange, setAgentStopped } from '../agents/agentAccounts';
import { startPotCreate } from '../agents/agentCreate';
import {
  getPot,
  isLowFunds,
  listPots,
  listSubs,
  monthlyUsd,
  onPotsChange,
  pauseAllSubs,
  potCovers,
  resumeAllSubs,
} from './pots';
import { potBalanceSats } from './potSend';
import { SubscriptionCard } from './SubscriptionCard';
import { POTS_INTRO } from '../storeBuild';
import { AddOrderSheet, CreatePotSheet } from './CreatePotSheet';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import {
  clearSubscribeRequest,
  onSubscribeRequest,
  peekSubscribeRequest,
  requestLabel,
  type SubscribeRequest,
} from './subscribeLink';

/** The held subscribe request, if any (always null in a store build). */
const useSubscribeRequest = (): SubscribeRequest | null => {
  const [r, setR] = useState<SubscribeRequest | null>(() => peekSubscribeRequest());
  useEffect(() => (SUBSCRIPTIONS_ENABLED ? onSubscribeRequest(() => setR(peekSubscribeRequest())) : undefined), []);
  return r;
};

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const LINE = '#2b2f36';
const CARD = '#17191E';
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const useTick = () => {
  const [, set] = useState(0);
  useEffect(() => {
    const a = onPotsChange(() => set((n) => n + 1));
    const b = onAgentsChange(() => set((n) => n + 1));
    return () => (a(), b());
  }, []);
};

/** A pot's BSV balance in sats (null while loading / unknown). */
const usePotBalance = (id: string) => {
  const { chromeStorageService } = useServiceContext();
  const [sats, setSats] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    potBalanceSats(chromeStorageService, id)
      .then((s) => live && setSats(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [chromeStorageService, id]);
  return sats;
};

const Header = ({ title, onBack }: { title: string; onBack: () => void }) => (
  <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
    <button type="button" onClick={onBack} aria-label="Back" className="p-2 bg-transparent border-0">
      <ArrowLeft size={20} color="white" />
    </button>
    <span className="text-[16px] font-bold text-white">{title}</span>
  </div>
);

const LowBadge = () => (
  <span className="text-[9px] font-bold rounded px-1.5 py-0.5" style={{ background: '#FDB02222', color: '#FDB022' }}>
    LOW FUNDS
  </span>
);

const PotRow = ({ id, onOpen, rate }: { id: string; onOpen: () => void; rate: number }) => {
  const pot = getPot(id);
  const sats = usePotBalance(id);
  const subs = listSubs(id);
  const live = subs.filter((s) => s.status === 'active' || s.status === 'lowFunds');
  const covers = sats !== null && rate > 0 ? potCovers(subs, sats, rate) : null;
  if (!pot) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-2xl p-3 border-0 text-left cursor-pointer"
      style={{ background: CARD }}
    >
      <PixelGhost color={ghostColorOf(id) ?? GOLD} size={24} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white truncate">{pot.name}</span>
          {live.length > 0 && covers !== null && isLowFunds(covers) && <LowBadge />}
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          {sats === null ? '…' : rate > 0 ? `$${((sats / 1e8) * rate).toFixed(2)}` : `${sats.toLocaleString()} sats`}
          {live.length ? ` · ${live.length} subscription${live.length === 1 ? '' : 's'}` : ''}
          {live.length && covers !== null ? ` · covers ${covers >= 99 ? '99+' : covers} payments` : ''}
        </div>
      </div>
      <ChevronRight size={16} color={MUTED} />
    </button>
  );
};

/** Settings › Pots: Monzo-style pots with standing orders (docs/POTS-SUBSCRIPTIONS-PLAN.md). */
export const PotsScreen = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  useTick();
  const { handleSelect } = useBottomMenu();
  const navigate = useNavigate();
  const rate = useBsvUsd();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pots = listPots();
  const request = useSubscribeRequest();
  const allSubs = listSubs()
    .filter((x) => x.status !== 'cancelled' && x.status !== 'ended')
    .sort((a, b) => a.nextDue - b.nextDue);
  const anyLive = allSubs.some((x) => x.status === 'active' || x.status === 'lowFunds');

  const create = (name: string) => {
    startPotCreate(name);
    setCreating(false);
    onClose();
    handleSelect('settings', 'create-account');
    const route = routeFor('settings');
    if (route) navigate(route);
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <Header title="Subscriptions" onBack={onClose} />
      <div className="flex flex-col gap-3 px-4 pb-10 overflow-y-auto">
        <p className="text-sm m-0" style={{ color: MUTED }}>
          {POTS_INTRO}
        </p>
        {SUBSCRIPTIONS_ENABLED && request && (
          <div
            className="rounded-2xl p-3 flex flex-col gap-1"
            style={{ background: '#F5B80018', border: `1px solid ${GOLD}55` }}
          >
            <div className="text-sm font-bold text-white">{requestLabel(request)}</div>
            <div className="text-xs" style={{ color: MUTED }}>
              {pots.length
                ? 'Pick the pot to pay it from, or make a new one. You check the amount before anything is set up.'
                : 'Make a pot to pay it from, put a little in it, then come back here.'}
            </div>
            <button
              type="button"
              onClick={clearSubscribeRequest}
              className="self-start text-xs bg-transparent border-0 p-0"
              style={{ color: MUTED }}
            >
              Not now
            </button>
          </div>
        )}
        {SUBSCRIPTIONS_ENABLED && allSubs.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">
                All subscriptions{rate > 0 ? ` · about $${monthlyUsd(allSubs, rate).toFixed(2)} a month` : ''}
              </span>
              <button
                type="button"
                onClick={() => (anyLive ? pauseAllSubs() : resumeAllSubs())}
                className="text-xs font-bold bg-transparent border-0 p-0"
                style={{ color: GOLD }}
              >
                {anyLive ? 'Pause all' : 'Resume all'}
              </button>
            </div>
            <p className="text-xs m-0" style={{ color: MUTED }}>
              Priced in dollars. Each time one is due, your wallet pays that amount in BSV at the day&apos;s rate when
              you open it. Nothing is paid up front. Cancel any time.
            </p>
            {allSubs.map((sub) => (
              <SubscriptionCard key={sub.id} sub={sub} rate={rate} pots={pots} />
            ))}
            <div className="rounded-xl p-2.5 text-xs" style={{ border: `1px dashed ${GOLD}55`, color: MUTED }}>
              Coming later: pay in PNEEs, so $1 is always exactly $1 with no price swings.
            </div>
            <p className="text-[11px] m-0 text-center" style={{ color: MUTED }}>
              You approve each subscription once. The service can only take the agreed dollar amount, once per period.
              Pausing a pot pauses everything that pays from it.
            </p>
          </div>
        )}
        {pots.length === 0 && (
          <p className="text-sm text-center py-6 m-0" style={{ color: MUTED }}>
            No pots yet.
          </p>
        )}
        {pots.map((p) => (
          <PotRow
            key={p.identityAddress}
            id={p.identityAddress}
            rate={rate}
            onOpen={() => setOpen(p.identityAddress)}
          />
        ))}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center justify-center gap-2 rounded-2xl py-3 font-bold border-0"
          style={{ background: GOLD, color: '#000' }}
        >
          <Plus size={16} /> New pot
        </button>
      </div>
      {creating && <CreatePotSheet onClose={() => setCreating(false)} onCreate={create} />}
      {open && <PotScreen id={open} rate={rate} request={request} onClose={() => setOpen(null)} />}
    </div>,
    document.body,
  );
};

const PotScreen = ({
  id,
  rate,
  onClose,
  request = null,
}: {
  id: string;
  rate: number;
  onClose: () => void;
  request?: SubscribeRequest | null;
}) => {
  useBackClose(true, onClose);
  useTick();
  const { chromeStorageService } = useServiceContext();
  const pot = getPot(id);
  const agent = getAgentAccount(id);
  const sats = usePotBalance(id);
  const accounts = chromeStorageService.getAllAccounts?.() ?? [];
  const acct = accounts.find((x) => x.addresses.identityAddress === id);
  const others = accounts.filter((x) => x.addresses.identityAddress !== id);
  // A held subscribe request opens the add sheet prefilled as soon as a pot is picked.
  const [adding, setAdding] = useState(!!request);
  const [copied, setCopied] = useState(false);
  const subs = listSubs(id).sort((a, b) => a.nextDue - b.nextDue);
  const history = getAgentLog(id).filter((e) => e.action.startsWith('sub-') || e.action === 'topup');
  const covers = sats !== null && rate > 0 ? potCovers(subs, sats, rate) : null;
  const balanceUsd = sats !== null && rate > 0 ? (sats / 1e8) * rate : null;

  if (!pot || !agent || !acct)
    return createPortal(
      <div className="fixed inset-0 z-[410] flex flex-col" style={{ background: '#010101' }}>
        <Header title="Pot" onBack={onClose} />
        <p className="text-sm text-center px-4 pt-10 m-0" style={{ color: MUTED }}>
          This pot isn’t loaded on this device.
        </p>
      </div>,
      document.body,
    );
  const address = acct.addresses.bsvAddress;
  const section = 'rounded-2xl p-3 flex flex-col gap-2';

  return createPortal(
    <div className="fixed inset-0 z-[410] flex flex-col" style={{ background: '#010101' }}>
      <Header title={pot.name} onBack={onClose} />
      <div className="flex flex-col gap-3 px-4 pb-10 overflow-y-auto">
        <div className={section} style={{ background: CARD }}>
          <div className="flex items-center gap-2">
            <PixelGhost color={ghostColorOf(id) ?? GOLD} size={28} />
            <div className="flex-1">
              <div className="text-xl font-bold text-white">
                {balanceUsd !== null
                  ? `$${balanceUsd.toFixed(2)}`
                  : sats !== null
                    ? `${sats.toLocaleString()} sats`
                    : '…'}
              </div>
              {covers !== null && subs.some((s) => s.status === 'active' || s.status === 'lowFunds') && (
                <div className="text-xs" style={{ color: isLowFunds(covers) ? '#FDB022' : MUTED }}>
                  Covers {covers >= 99 ? '99+' : covers} upcoming payment{covers === 1 ? '' : 's'}
                </div>
              )}
            </div>
            {covers !== null &&
              isLowFunds(covers) &&
              subs.some((s) => s.status === 'active' || s.status === 'lowFunds') && <LowBadge />}
          </div>
        </div>

        <div className={section} style={{ background: CARD }}>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-sm font-bold text-white">Stop this pot</div>
              <div className="text-xs" style={{ color: MUTED }}>
                Nothing is paid from it while it’s stopped.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={agent.stopped}
              aria-label="Stop this pot"
              onClick={() => setAgentStopped(id, !agent.stopped)}
              className="relative h-6 w-11 rounded-full shrink-0 border-0"
              style={{ background: agent.stopped ? '#F04438' : LINE }}
            >
              <span
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                style={{ left: agent.stopped ? 22 : 2 }}
              />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-sm font-bold text-white">Subscriptions</span>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs font-bold bg-transparent border-0"
            style={{ color: GOLD }}
          >
            <Plus size={14} /> Add
          </button>
        </div>
        {subs.length === 0 && (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            None yet.
          </p>
        )}
        {subs.map((s) => (
          <SubscriptionCard key={s.id} sub={s} rate={rate} />
        ))}

        <div className={section} style={{ background: CARD }}>
          <div className="text-sm font-bold text-white">Top up</div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-mono border-0 text-left"
            style={{ background: '#010101', color: '#D0D5DD' }}
          >
            {copied ? <Check size={13} color="#2ecc71" /> : <Copy size={13} color={MUTED} />} {address}
          </button>
          {others.map((o) => (
            <button
              key={o.addresses.identityAddress}
              type="button"
              onClick={async () => {
                requestPayAfterSwitch(address);
                await chromeStorageService.switchAccount(o.addresses.identityAddress);
                window.location.reload();
              }}
              className="rounded-lg px-3 py-2 text-xs font-bold border-0 text-left"
              style={{ background: '#F5B80022', color: GOLD }}
            >
              Pay from {o.name || short(o.addresses.bsvAddress)} →
            </button>
          ))}
        </div>

        {history.length > 0 && (
          <div className={section} style={{ background: CARD }}>
            <div className="text-sm font-bold text-white">History</div>
            {history.slice(0, 50).map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex flex-col">
                <span className="text-xs text-white">{e.detail}</span>
                <span className="text-[10px]" style={{ color: MUTED }}>
                  {new Date(e.at).toLocaleString()}
                  {e.txid && (
                    <>
                      {' · '}
                      <a
                        href={`https://whatsonchain.com/tx/${e.txid}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: GOLD }}
                      >
                        {e.txid.slice(0, 8)}…
                      </a>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {adding && (
        <AddOrderSheet
          potId={id}
          potName={pot.name}
          balanceUsd={balanceUsd}
          bsvUsd={rate}
          request={request}
          onClose={() => setAdding(false)}
        />
      )}
    </div>,
    document.body,
  );
};

export default PotsScreen;
