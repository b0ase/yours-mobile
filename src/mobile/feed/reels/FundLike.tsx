/**
 * The Like on a token card (Feed › bExchange): 1¢ to fund the item and join its room. Rules in likeToFund.ts.
 * One tap: within the wallet's one-click limit (settings/oneClick.ts, the same guard as tips and locks) it
 * buys straight away; otherwise one approval sheet. After success: "You're in" with a link to the room.
 * bWalletX only: it lives in BexReel, which is absent from a store build (BEX_REEL_ENABLED), and it also
 * checks marketTradingEnabled / tokenRoomsEnabled.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { buyBsv21 } from '@1sat/actions';
import { Heart } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useSnackbar } from '../../../hooks/useSnackbar';
import { useBottomMenu } from '../../../hooks/useBottomMenu';
import { ApprovalCard, Chip } from '../../../components/approval/ApprovalCard';
import { CARD } from '../../../components/approval/cardTheme';
import { PayHero } from '../../../components/approval/ApprovalHeroes';
import { asMenuItem } from '../../tabs/tabs';
import { assertOrdLockV2 } from '../../market/ordlockVersion';
import { clearMarketCache, roomMarket } from '../../market/indexer';
import { marketFeeOptions, marketFeeSats } from '../../market/fee';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../../market/walletOutpoint';
import { showOnWallet } from '../../tokens/indexFund';
import { marketTradingEnabled, tokenRoomsEnabled } from '../../storeBuild';
import { useBackClose } from '../../backStack';
import { requestChatRoom } from '../../chat/nav';
import { tokenKey } from '../../chat/tokenRooms';
import { purchaseError } from '../../exchange/purchase';
import { addHistory } from '../../exchange/exchangeData';
import { fmtSats } from '../../money/money';
import { usdOrSats } from '../../names/opnsSell';
import { oneClick } from '../../settings/oneClick';
import {
  addFundLike,
  LIKE_COPY,
  LIKE_DONE,
  LIKE_LABEL,
  LIKE_NO_LISTING,
  loadFundLikes,
  planLike,
  type LikePlan,
} from './likeToFund';

const GOLD = 'var(--bw-accent)';

const Sheet = (p: { children: ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {p.children}
    </div>,
    document.body,
  );

type Buy = Extract<LikePlan, { kind: 'buy' }>;

export const FundLike = ({ tokenId, ticker, rate }: { tokenId: string; ticker: string; rate: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const { handleSelect } = useBottomMenu();
  const [liked, setLiked] = useState(() => loadFundLikes().has(tokenId.toLowerCase()));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Buy | null>(null);
  const [joined, setJoined] = useState(false);
  useBackClose(!!pending && !busy, () => setPending(null));
  useBackClose(joined, () => setJoined(false));

  if (!marketTradingEnabled()) return null;

  const openRoom = () => {
    const key = tokenKey('bsv21', tokenId);
    setJoined(false);
    if (!key || !tokenRoomsEnabled()) return;
    requestChatRoom(key);
    handleSelect(asMenuItem('chat'));
  };

  const buy = async (p: Buy) => {
    setBusy(true);
    try {
      const outpoint = walletOutpoint(p.listing.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyBsv21.execute(purchaseContext(apiContext, outpoint), {
        tokenId,
        outpoint,
        amount: p.listing.amount ?? '0',
        ...marketFeeOptions(),
        ...MODULE_FINISHES,
      });
      if (!res.txid || res.error) return addSnackbar(purchaseError(res.error), 'error');
      void showOnWallet(chromeStorageService, tokenId);
      addHistory({
        txid: res.txid,
        tokenId,
        symbol: ticker,
        amountLabel: p.listing.label,
        totalSats: p.totalSats,
        at: Date.now(),
      });
      clearMarketCache();
      addFundLike(tokenId);
      setLiked(true);
      setPending(null);
      setJoined(true);
    } catch (e) {
      addSnackbar(purchaseError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const tap = async () => {
    if (busy) return;
    if (liked) return setJoined(true);
    setBusy(true);
    let plan: LikePlan;
    try {
      const m = await roomMarket({ kind: 'bsv21', id: tokenId, key: `bsv21:${tokenId}` }, 40);
      plan = planLike(tokenId, m.listings, rate, (s) => marketFeeSats(s));
    } catch {
      setBusy(false);
      return addSnackbar('Could not reach the market. Try again.', 'error');
    }
    setBusy(false);
    if (plan.kind === 'no-rate') return addSnackbar('No BSV price right now; try again shortly.', 'info');
    if (plan.kind !== 'buy') return addSnackbar(LIKE_NO_LISTING, 'info');
    // The wallet's own limits: one-click (per-action limit + per-minute guard) or the approval sheet.
    if (oneClick.take(plan.totalSats).ok) return void buy(plan);
    setPending(plan);
  };

  return (
    <>
      <button
        onClick={() => void tap()}
        disabled={busy}
        aria-label={`${LIKE_LABEL} $${ticker}`}
        title={LIKE_COPY}
        className="min-w-0 flex-1 basis-0 select-none rounded-md px-3 py-2.5 text-center text-[16px] font-extrabold tracking-[0.04em] active:opacity-70"
        style={{ background: '#0c0c0c', border: '1px solid rgba(255,210,77,0.45)', color: GOLD }}
      >
        <Heart size={16} fill={liked ? 'currentColor' : 'none'} className="mr-1 inline align-[-2px]" />
        {busy ? '…' : liked ? 'In' : LIKE_LABEL}
      </button>
      {pending && (
        <Sheet>
          <ApprovalCard
            ours
            site="bWalletX"
            siteSub={`$${ticker}`}
            onClose={() => !busy && setPending(null)}
            hero={<PayHero amount={usdOrSats(pending.totalSats, rate)} sub={fmtSats(pending.totalSats)} />}
            title={
              <>
                Like <span style={{ color: CARD.gold }}>${ticker}</span>
              </>
            }
            primary={{ label: busy ? 'Sending…' : 'Allow', onClick: () => !busy && void buy(pending) }}
            secondary={{ label: 'Not now', onClick: () => !busy && setPending(null) }}
          >
            <p className="mt-0 mb-3 text-sm opacity-90">{LIKE_COPY}</p>
            <div className="flex flex-wrap gap-2">
              <Chip>{pending.listing.label}</Chip>
              <Chip>Plus a small network fee</Chip>
            </div>
          </ApprovalCard>
        </Sheet>
      )}
      {joined && (
        <Sheet>
          <ApprovalCard
            ours
            site="bWalletX"
            siteSub={`$${ticker}`}
            onClose={() => setJoined(false)}
            hero={<PayHero amount={LIKE_DONE} sub={`$${ticker}`} />}
            title={<>{LIKE_DONE}</>}
            primary={{ label: 'Open the room', onClick: openRoom }}
            secondary={{ label: 'Done', onClick: () => setJoined(false) }}
          >
            <p className="m-0 text-sm opacity-90">Thanks for supporting ${ticker}. Its room is open to you.</p>
          </ApprovalCard>
        </Sheet>
      )}
    </>
  );
};
