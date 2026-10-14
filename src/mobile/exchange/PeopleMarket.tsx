import { useMemo, useState } from 'react';
import { buyBsv21 } from '@1sat/actions';
import { MessageCircle } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { clearMarketCache, roomMarket, type Listing } from '../market/indexer';
import { marketFeeOptions, marketFeeSats } from '../market/fee';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { showOnWallet } from '../tokens/indexFund';
import { marketTradingEnabled, tokenRoomsEnabled } from '../storeBuild';
import { useBackClose } from '../backStack';
import { requestChatRoom } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { useContacts } from '../chat/useContacts';
import { loadSession } from '../chat/api';
import { bavatarSvg } from '../bavatar/bavatar';
import { purchaseError } from './purchase';
import { addHistory, bsvLabel, fiatLabel, unitPriceLabel } from './exchangeData';
import { usePeopleTokens } from './usePeopleTokens';
import { joinLabel, peopleSections, tokenFor, type PersonToken } from './people';
import {
  fetchQuote,
  joinSheetTitle,
  pickCurveListing,
  quoteAction,
  recordPurchase,
  supporterBadge,
} from './curveSales';
import { SellMyToken } from './SellMyToken';
import { SELL_ENABLED } from '../sell/sell';

const GOLD = 'var(--bw-accent)';
const GREEN = '#A1FF8B';
const MUTED = '#98A2B3';
const TRADING = marketTradingEnabled();

const avatarSrc = (t: PersonToken) =>
  t.avatar ?? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(t.handle || 'b', { size: 64 }));

const perToken = (l: Listing) => l.priceSats / (Number(l.amount ?? 0) || 1);

/** Open this person's token room in Chat. */
const useOpenRoom = () => {
  const { handleSelect } = useBottomMenu();
  return (t: PersonToken) => {
    const key = tokenKey('bsv21', t.tokenId);
    if (!key) return;
    requestChatRoom(key);
    handleSelect(asMenuItem('chat'));
  };
};

/**
 * "Buy & chat". When the person has opened sales, ask bit-sign for a quote first (refuses your own token;
 * "already joined" just opens the room), buy one of THEIR curve listings (from their own supply) in one
 * sheet — "Join $kim's room — 1¢ (Supporter #3)" — report the txid so bit-sign records the Supporter
 * number, then open the room. Otherwise: the cheapest resale listing (OrdLock v2 only). No listings →
 * "No one is selling yet" (+ "Open their room" when it is open to anyone).
 */
export const BuyAndChat = ({ token, rate }: { token: PersonToken; rate: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const openRoom = useOpenRoom();
  const [state, setState] = useState<'idle' | 'loading' | 'none' | 'sheet' | 'buying'>('idle');
  const [best, setBest] = useState<Listing | null>(null);
  const [curve, setCurve] = useState<{ cents: number; supporter: number | null } | null>(null);
  useBackClose(state === 'sheet', () => setState('idle'));
  if (!TRADING || !tokenRoomsEnabled()) return null;

  const start = async () => {
    setState('loading');
    const ref = { kind: 'bsv21' as const, id: token.tokenId, key: `bsv21:${token.tokenId}` };
    setCurve(null);
    if (token.salesOpen && token.pricing.mode !== 'off') {
      const q = await fetchQuote(token.tokenId).catch(() => null);
      const act = q ? quoteAction(q) : 'resale';
      if (act === 'hide') {
        addSnackbar('This is your own token', 'info');
        setState('idle');
        return;
      }
      if (act === 'open-room') {
        setState('idle');
        openRoom(token);
        return;
      }
      if (q?.ok) {
        const m = await roomMarket(ref, 50).catch(() => null);
        const l = pickCurveListing(q.listings, m?.listings ?? []);
        if (l) {
          setCurve({ cents: q.price_usd_cents * q.pack, supporter: q.supporter });
          setBest(l);
          setState('sheet');
          return;
        }
      }
    }
    const m = await roomMarket(ref, 20).catch(() => null);
    const l = [...(m?.listings ?? [])].filter((x) => x.buyable).sort((a, b) => perToken(a) - perToken(b))[0];
    setBest(l ?? null);
    setState(l ? 'sheet' : 'none');
  };

  const buy = async (l: Listing) => {
    setState('buying');
    try {
      const outpoint = walletOutpoint(l.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyBsv21.execute(purchaseContext(apiContext, outpoint), {
        tokenId: token.tokenId,
        outpoint,
        amount: l.amount ?? '0',
        ...marketFeeOptions(),
        ...MODULE_FINISHES,
      });
      if (!res.txid || res.error) {
        addSnackbar(purchaseError(res.error), 'error');
        setState('sheet');
        return;
      }
      void showOnWallet(chromeStorageService, token.tokenId);
      addHistory({
        txid: res.txid,
        tokenId: token.tokenId,
        symbol: `$${token.ticker}`,
        amountLabel: l.label,
        totalSats: l.priceSats + marketFeeSats(l.priceSats),
        at: Date.now(),
      });
      clearMarketCache();
      const rec = curve ? await recordPurchase(token.tokenId, res.txid) : null;
      const badge = supporterBadge(rec?.supporter);
      addSnackbar(`You're in $${token.handle}'s room${badge ? ` · ${badge}` : ''}`, 'success');
      setState('idle');
      openRoom(token);
    } catch (e) {
      addSnackbar(purchaseError(e), 'error');
      setState('sheet');
    }
  };

  const fee = best ? marketFeeSats(best.priceSats) : 0;
  return (
    <>
      {state === 'none' ? (
        <span className="flex items-center gap-2 text-[11px]" style={{ color: MUTED }}>
          No one is selling yet
          {token.roomOpen && (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), openRoom(token))}
              className="rounded-lg px-2 py-1 text-[11px] font-bold border cursor-pointer bg-transparent"
              style={{ borderColor: '#3a2f0c', color: GOLD }}
            >
              Open their room
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          disabled={state === 'loading'}
          onClick={(e) => (e.stopPropagation(), void start())}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-extrabold border-0 cursor-pointer disabled:opacity-50"
          style={{ background: GOLD, color: '#010101' }}
        >
          <MessageCircle size={13} /> {state === 'loading' ? '…' : 'Buy & chat'}
        </button>
      )}
      {best && (state === 'sheet' || state === 'buying') && (
        <div
          className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/60"
          onClick={() => state !== 'buying' && setState('idle')}
        >
          <div
            className="w-full md:max-w-[420px] rounded-t-2xl md:rounded-2xl bg-[#17191E] px-5 pt-5 flex flex-col gap-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <img src={avatarSrc(token)} alt="" className="w-12 h-12 rounded-full object-cover" />
              <div>
                <div className="text-base font-bold text-white">
                  {curve ? joinSheetTitle(token.handle, curve.cents, curve.supporter) : `Join $${token.handle}'s room`}
                </div>
                <div className="text-xs" style={{ color: MUTED }}>
                  {curve ? `${best.label} from $${token.handle}. ` : `Buy ${best.label}. `}Holding their token opens
                  their room.
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between" style={{ color: MUTED }}>
                <span>Price per token</span>
                <span className="text-white">{unitPriceLabel(perToken(best))}</span>
              </div>
              <div className="flex justify-between border-t border-[#2b2f36] pt-1.5 font-semibold">
                <span className="text-white">Total</span>
                <span style={{ color: GREEN }}>
                  {bsvLabel(best.priceSats + fee)}
                  {fiatLabel(best.priceSats + fee, rate) && ` · ${fiatLabel(best.priceSats + fee, rate)}`} + network fee
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={state === 'buying'}
              onClick={() => void buy(best)}
              className="rounded-xl py-3 text-sm font-extrabold border-0 cursor-pointer disabled:opacity-50"
              style={{ background: GREEN, color: '#010101' }}
            >
              {state === 'buying' ? 'Joining…' : `Buy & chat · ${bsvLabel(best.priceSats + fee)}`}
            </button>
            <button
              type="button"
              disabled={state === 'buying'}
              onClick={() => setState('idle')}
              className="py-2 text-xs border-0 bg-transparent cursor-pointer"
              style={{ color: MUTED }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
};

const PersonRow = ({ t, rate }: { t: PersonToken; rate: number }) => (
  <div className="flex items-center gap-3 border-t border-[#2b2f36] px-3 py-2.5">
    <img src={avatarSrc(t)} alt="" className="w-9 h-9 rounded-full object-cover" />
    <div className="flex-1 min-w-0">
      <div className="font-bold text-white truncate">${t.handle}</div>
      <div className="text-[11px] truncate" style={{ color: MUTED }}>
        {joinLabel(t)}
        {t.members > 0 && ` · ${t.members} in the room`}
      </div>
    </div>
    <BuyAndChat token={t} rate={rate} />
  </div>
);

const Section = ({ title, list, rate }: { title: string; list: PersonToken[]; rate: number }) =>
  list.length ? (
    <section className="rounded-2xl bg-[#17191E] border border-[#2b2f36] overflow-hidden">
      <h2 className="text-xs font-bold m-0 px-3 py-2" style={{ color: MUTED }}>
        {title}
      </h2>
      {list.map((t) => (
        <PersonRow key={t.tokenId} t={t} rate={rate} />
      ))}
    </section>
  ) : null;

/** Markets → Friends: your friends' tokens first, then everyone else's ("People"). */
export const PeopleMarket = ({ rate, q }: { rate: number; q: string }) => {
  const tokens = usePeopleTokens();
  const contacts = useContacts();
  const me = loadSession()?.handle ?? null;
  const needle = q.trim().replace(/^\$/, '').toLowerCase();
  const sections = useMemo(
    () =>
      peopleSections(
        (tokens ?? []).filter((t) => !needle || t.handle.includes(needle)),
        contacts.map((c) => c.handle ?? '').filter(Boolean),
        me,
      ),
    [tokens, contacts, me, needle],
  );
  if (tokens === null)
    return (
      <p className="text-sm text-center py-8" style={{ color: MUTED }}>
        Loading people…
      </p>
    );
  const mine = tokenFor(tokens, me);
  if (!mine && !sections.friends.length && !sections.people.length)
    return (
      <p className="text-sm text-center py-8" style={{ color: MUTED }}>
        No personal tokens yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {mine && SELL_ENABLED && <SellMyToken token={mine} rate={rate} />}
      <Section title="Friends" list={sections.friends} rate={rate} />
      <Section title="People" list={sections.people} rate={rate} />
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        Hold 1 of someone's token to join their room.
      </p>
    </div>
  );
};
