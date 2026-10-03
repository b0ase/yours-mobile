import { ArrowDownLeft, ArrowUpRight, MessageCircle, ShoppingCart, Tag } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom, requestMarketToken } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { tokenSales, type Sale } from '../market/indexer';
import { marketTradingEnabled, tokenRoomsEnabled } from '../storeBuild';

/** Tapping a wallet card opens this panel (bWalletX only; the store build keeps the plain tap). */
export const tokenPanelEnabled = () => marketTradingEnabled() || tokenRoomsEnabled();

const usd = (v: number) =>
  v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toPrecision(2)}`;

/** Last sales as a small line chart, in dollars per token. */
const PriceChart = ({ tokenId, usdPerBsv }: { tokenId: string; usdPerBsv: number }) => {
  const [sales, setSales] = useState<Sale[] | null>(null);
  useEffect(() => {
    let alive = true;
    tokenSales(tokenId)
      .then((s) => alive && setSales(s))
      .catch(() => alive && setSales([]));
    return () => {
      alive = false;
    };
  }, [tokenId]);

  if (sales === null) return <div className="h-16 text-xs flex items-center" style={{ color: '#98A2B3' }}>Loading price…</div>;
  if (sales.length < 2)
    return <div className="h-8 text-xs flex items-center" style={{ color: '#98A2B3' }}>No market sales yet.</div>;

  const toUsd = (s: number) => (s * usdPerBsv) / 1e8;
  const ys = sales.map((s) => s.satsPerToken);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const W = 300;
  const H = 80;
  const pts = ys
    .map((y, i) => `${((i / (ys.length - 1)) * W).toFixed(1)},${(H - 4 - ((y - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`)
    .join(' ');
  const last = ys[ys.length - 1];
  const change = ((last - ys[0]) / ys[0]) * 100;
  const up = change >= 0;

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span style={{ color: '#fff', fontWeight: 600 }}>
          {usdPerBsv ? usd(toUsd(last)) : `${last.toPrecision(3)} sats`}
          <span style={{ color: '#98A2B3', fontWeight: 400 }}> per token · last sale</span>
        </span>
        <span style={{ color: up ? '#2ecc71' : '#F04438', fontWeight: 600 }}>
          {up ? '+' : ''}
          {change.toFixed(1)}% · {sales.length} sales
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-20 block">
        <polyline points={pts} fill="none" stroke={up ? '#2ecc71' : '#F04438'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

/**
 * The open card in Wallet (owner, 4 Oct 2026): price chart for tokens, then Buy · Send · Receive · Sell · Chat (Phantom-style).
 * Buy opens the token in the Market, Sell opens the token/send page, Chat opens the token's room.
 */
export const TokenRowActions = ({
  tokenId,
  onSend,
  onSell,
  onReceive,
  onBuy,
  usdPerBsv = 0,
}: {
  /** BSV-21 id; omitted for BSV / MNEE (no chart; Buy and Chat open the Market and Chat tabs). */
  tokenId?: string;
  /** Send page (tokens: the token page, which also has the Sell sheet). */
  onSend: () => void;
  onSell?: () => void;
  onReceive?: () => void;
  onBuy?: () => void;
  usdPerBsv?: number;
}) => {
  const { handleSelect } = useBottomMenu();
  const trade = marketTradingEnabled();
  const rooms = tokenRoomsEnabled();

  const btn = (label: string, icon: ReactNode, onClick: () => void) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex flex-1 flex-col items-center gap-1 bg-transparent border-0 outline-none cursor-pointer p-0"
    >
      <span className="grid place-items-center w-9 h-9 rounded-full" style={{ background: '#22252B', color: '#FFD24D' }}>
        {icon}
      </span>
      <span className="text-[11px] font-semibold" style={{ color: '#D0D5DD' }}>
        {label}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2.5 pt-1" onClick={(e) => e.stopPropagation()}>
      {tokenId && trade && <PriceChart tokenId={tokenId} usdPerBsv={usdPerBsv} />}
      <div className="flex w-full gap-2">
        {trade &&
          btn('Buy', <ShoppingCart size={15} />, () => {
            if (onBuy) return onBuy();
            if (tokenId) requestMarketToken({ kind: 'bsv21', id: tokenId });
            handleSelect(asMenuItem('market'));
          })}
        {btn('Send', <ArrowUpRight size={16} />, onSend)}
        {onReceive && btn('Receive', <ArrowDownLeft size={16} />, onReceive)}
        {trade && btn('Sell', <Tag size={15} />, onSell ?? onSend)}
        {rooms &&
          btn('Chat', <MessageCircle size={15} />, () => {
            const key = tokenId && tokenKey('bsv21', tokenId);
            if (key) requestChatRoom(key);
            handleSelect(asMenuItem('chat'));
          })}
      </div>
    </div>
  );
};
