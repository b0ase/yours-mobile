import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getBsv21Balances } from '@1sat/actions';
import { MessageCircle, Ticket as TicketIcon } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { isNative } from '../native';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { parseLookup } from '../chat/tokenRooms';
import { formatSats, parseRoom, roomMarket } from '../market/indexer';
import { onSafetyChange } from '../market/safety';
import { finishTicketRooms, registryTickets } from './mintTicket';
import { TICKET_COPY, eventLabel, localTickets, mergeTickets, onTicketsChanged, type Ticket } from './tickets';

/**
 * Market → Tokens → Tickets: rooms you can buy into. Each row is a ticket (BSV-21) with its
 * room name, icon, members (when bit-sign says), event date and price (the cheapest live listing,
 * else the creator's asking price). Holders get "Open room" straight into Chat; everyone else
 * gets "Buy ticket", which opens the ticket's market page (the existing token buy flow).
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
type Stats = { floor: string | null; buyable: number; members: number | null };

export const openTicketRoomInChat = (tokenId: string, select: (item: ReturnType<typeof asMenuItem>) => void) => {
  requestChatRoom(`bsv21:${tokenId}`);
  select(asMenuItem('chat'));
};

export const TicketsPanel = ({
  art,
  onBuy,
}: {
  art: (icon: string | null, tokenId: string) => ReactNode;
  onBuy: (ticket: Ticket, holder: boolean) => void;
}) => {
  const { apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Record<string, Stats>>({});

  const load = useCallback(async () => {
    const registry = await registryTickets();
    setTickets(mergeTickets(registry, localTickets()));
  }, []);

  useEffect(() => {
    setTickets(mergeTickets([], localTickets()));
    void load();
    // Rooms that could not open at mint (token not indexed yet): retry quietly.
    void finishTicketRooms(apiContext)
      .then((n) => {
        if (n) void load();
      })
      .catch(() => 0);
    const offA = onTicketsChanged(() => void load());
    const offB = onSafetyChange(() => void load());
    return () => {
      offA();
      offB();
    };
  }, [apiContext, load]);

  useEffect(() => {
    getBsv21Balances
      .execute(apiContext, {})
      .then((bs) => setHeld(new Set(bs.filter((b) => BigInt(b.amt || '0') > 0n).map((b) => b.id.replace('.', '_')))))
      .catch(() => setHeld(new Set()));
  }, [apiContext, tickets?.length]);

  useEffect(() => {
    if (!tickets?.length) return;
    let live = true;
    const session = loadSession();
    const client = session ? new BchatClient(defaultHttp(isNative), session) : null;
    void Promise.all(
      tickets.slice(0, 60).map(async (t) => {
        const ref = parseRoom('bsv21', t.tokenId);
        if (!ref) return;
        const [m, look] = await Promise.all([
          roomMarket(ref).catch(() => null),
          client
            ? client
                .tokenRoom(ref.key)
                .then(parseLookup)
                .catch(() => null)
            : null,
        ]);
        if (!live) return;
        setStats((s) => ({
          ...s,
          [t.tokenId]: {
            floor: m?.floorLabel ?? null,
            buyable: m?.buyableCount ?? 0,
            members: look?.room?.members ?? null,
          },
        }));
      }),
    );
    return () => {
      live = false;
    };
  }, [tickets]);

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-[#98A2B3] rounded-xl bg-[#17191E] px-3 py-2.5">
        <TicketIcon size={11} className="inline mr-1" />
        {TICKET_COPY} Start your own from Wallet → Mint → Mint a chatroom.
      </p>
      {tickets === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading tickets…</p>}
      {tickets?.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-8">No tickets yet.</p>}
      {tickets?.map((t) => {
        const s = stats[t.tokenId];
        const holder = held.has(t.tokenId);
        const ev = eventLabel(t.eventDate);
        const price = s?.floor ?? (t.priceSats ? formatSats(t.priceSats) : null);
        const sub = [
          `$${t.ticker}`,
          ev,
          s?.members != null ? `${s.members} ${s.members === 1 ? 'member' : 'members'}` : null,
        ].filter(Boolean);
        return (
          <div key={t.tokenId} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3">
            <button onClick={() => onBuy(t, holder)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              {art(t.icon, t.tokenId)}
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{t.name}</div>
                <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{sub.join(' · ')}</div>
                {price && (
                  <div className="text-[11px] font-semibold" style={{ color: '#A1FF8B' }}>
                    {price}
                    {!s?.floor && <span className="font-normal text-[#667085]"> asking · none listed yet</span>}
                  </div>
                )}
              </div>
            </button>
            {holder ? (
              <button
                onClick={() => openTicketRoomInChat(t.tokenId, handleSelect)}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold shrink-0"
                style={{ background: '#2a2208', color: '#FFD24D', border: '1px solid #3a2f0c' }}
              >
                <MessageCircle size={12} /> Open room
              </button>
            ) : (
              <button
                onClick={() => onBuy(t, holder)}
                className="rounded-lg px-3 py-1.5 text-xs font-bold shrink-0"
                style={{ background: '#A1FF8B', color: '#010101' }}
              >
                Buy ticket
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
};
