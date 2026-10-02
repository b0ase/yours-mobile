import { useCallback, useEffect, useState } from 'react';
import { ONESAT_MAINNET_CONTENT_URL } from '@1sat/actions';
import { MessageCircle, RefreshCw, Tag, Ticket as TicketIcon } from 'lucide-react';
import { SellSheet, type SellTarget } from '../sell/SellSheet';
import { MyTokenListings } from '../sell/MyTokenListings';
import { SELL_ENABLED, onListingsChanged } from '../sell/sell';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { isUri } from '../../utils/uri';
import { isNative } from '../native';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { walletHoldings } from '../chat/holdings';
import { parseLookup, type TokenRoomLookup } from '../chat/tokenRooms';
import { getPersonalLink, knownPersonal, onPersonalChange } from '../names/personalToken';
import { registryTickets } from '../tickets/mintTicket';
import { localTickets, mergeTickets, onTicketsChanged } from '../tickets/tickets';
import { IssuerBadge } from '../issuer/IssuerBadge';
import {
  SOURCE_LABEL,
  buildWalletTickets,
  entryLine,
  heldLine,
  rememberTicketIds,
  tokensToLookUp,
  type WalletTicket,
} from './walletTickets';

const GOLD = '#FFD24D';
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const iconUrl = (icon: string | null) => (!icon ? null : isUri(icon) ? icon : `${ONESAT_MAINNET_CONTENT_URL}/${icon}`);

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: WalletTicket[] };

/** Wallet → Tickets: tokens this wallet holds that get it into a room, with "Open room". */
export const TicketsSection = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const [selling, setSelling] = useState<SellTarget | null>(null);

  const load = useCallback(async () => {
    const holdings = await walletHoldings(apiContext);
    const tickets = mergeTickets(await registryTickets(), localTickets());
    const base = {
      holdings,
      tickets,
      personal: getPersonalLink(identityAddress),
      known: knownPersonal(),
    };
    const first = buildWalletTickets(base);
    // Ask bit-sign about the rest (signed-in only; a failed lookup just leaves that token out).
    const session = loadSession(identityAddress);
    const lookups: Record<string, TokenRoomLookup | undefined> = {};
    if (session) {
      const client = new BchatClient(defaultHttp(isNative), session);
      const keys = [...first.map((t) => t.key), ...tokensToLookUp(holdings, first)];
      await Promise.all(
        keys.map(async (k) => {
          lookups[k] = parseLookup(await client.tokenRoom(k).catch(() => null)) ?? undefined;
        }),
      );
    }
    return buildWalletTickets({ ...base, lookups });
  }, [apiContext, identityAddress]);

  useEffect(() => {
    let live = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    load()
      .then((rows) => {
        if (!live) return;
        rememberTicketIds(rows.map((r) => r.tokenId));
        setState({ status: 'ready', rows });
      })
      .catch((e: unknown) => {
        if (live) setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not load tickets' });
      });
    return () => {
      live = false;
    };
  }, [load, tick]);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const a = onTicketsChanged(again);
    const b = onPersonalChange(again);
    const c = onListingsChanged(again);
    return () => {
      a();
      b();
      c();
    };
  }, []);

  const open = (t: WalletTicket) => {
    requestChatRoom(t.key);
    handleSelect(asMenuItem('chat'));
  };

  if (state.status === 'loading') {
    return (
      <div className="w-[92%] mx-auto flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[68px] rounded-xl border border-[#2b2f36] bg-[#17191E] animate-pulse" />
        ))}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="w-[92%] mx-auto rounded-xl border border-[#2b2f36] bg-[#17191E] p-4 text-center">
        <p className="text-sm text-[#98A2B3] m-0 mb-3">Couldn't load your tickets. {state.message}</p>
        <button
          type="button"
          onClick={() => setTick((n) => n + 1)}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg text-sm font-bold border cursor-pointer outline-none"
          style={{ background: '#17191E', borderColor: '#3a2f0c', color: GOLD }}
        >
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }

  if (!state.rows.length) {
    return (
      <div className="w-[92%] mx-auto rounded-xl border border-[#2b2f36] bg-[#17191E] p-6 text-center">
        <TicketIcon size={28} color={GOLD} className="mx-auto mb-2" />
        <p className="text-sm text-[#98A2B3] m-0">No tickets yet — mint a chatroom or get invited.</p>
      </div>
    );
  }

  return (
    <div className="w-[92%] mx-auto flex flex-col gap-2">
      {state.rows.map((t) => {
        const src = iconUrl(t.icon);
        return (
          <div
            key={t.key}
            className="flex items-center gap-3 rounded-xl border border-[#2b2f36] bg-[#17191E] px-3 py-3"
          >
            {src ? (
              <img src={src} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-[#2b2f36]">
                <TicketIcon size={18} color={GOLD} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`text-sm font-bold text-white ${ELLIPSIS}`}>{t.name}</span>
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{ color: GOLD, border: '1px solid #3a2f0c' }}
                >
                  {SOURCE_LABEL[t.source]}
                </span>
              </div>
              <div className={`text-xs text-[#98A2B3] ${ELLIPSIS}`}>
                ${t.symbol} · {heldLine(t)}
                {t.members != null ? ` · ${t.members} in room` : ''}
              </div>
              <div className={`text-[11px] ${ELLIPSIS}`} style={{ color: t.canEnter ? '#667085' : '#F97066' }}>
                {entryLine(t)}
              </div>
              <IssuerBadge tokenId={t.tokenId} compact />
            </div>
            {SELL_ENABLED && BigInt(t.heldRaw || '0') > 0n && (
              <button
                type="button"
                aria-label={`Sell ${t.symbol}`}
                onClick={() =>
                  setSelling({
                    tokenId: t.tokenId,
                    symbol: t.symbol,
                    dec: t.dec,
                    heldRaw: BigInt(t.heldRaw),
                    isTicket: t.source !== 'personal',
                  })
                }
                className="flex items-center gap-1 h-9 px-2.5 rounded-lg text-xs font-bold border outline-none cursor-pointer flex-shrink-0"
                style={{ background: '#17191E', borderColor: '#3a2f0c', color: GOLD }}
              >
                <Tag size={13} />
                Sell
              </button>
            )}
            <button
              type="button"
              onClick={() => open(t)}
              disabled={!t.canEnter}
              className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-bold border outline-none cursor-pointer flex-shrink-0 disabled:opacity-40 disabled:cursor-default"
              style={{ background: '#17191E', borderColor: '#3a2f0c', color: GOLD }}
            >
              <MessageCircle size={13} />
              Open room
            </button>
          </div>
        );
      })}
      {SELL_ENABLED && (
        <>
          <div className="text-xs font-bold text-[#98A2B3] mt-2 px-1">My listings</div>
          <MyTokenListings emptyText="Nothing listed. Tap Sell on a ticket to list it." />
        </>
      )}
      {selling && <SellSheet target={selling} onClose={() => setSelling(null)} />}
    </div>
  );
};
