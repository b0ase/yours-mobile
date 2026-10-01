import { deployBsv21Mint, inscribe, type OneSatContext } from '@1sat/actions';
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings } from '../chat/holdings';
import { MINT_APP, fileToBase64, withFeeOutput } from '../mint/mint';
import {
  TICKET_DECIMALS,
  TICKET_MIN,
  TICKET_PURPOSE,
  cleanTicket,
  foundingMessage,
  localTickets,
  parseTicketList,
  saveLocalTicket,
  ticketMapScript,
  ticketRegistration,
  type Ticket,
  type TicketForm,
} from './tickets';

/**
 * Ticket network steps, run only after the user confirms SendConfirmation:
 *   1. (optional) inscribe the icon image → its outpoint is the token's icon;
 *   2. deploy the BSV-21 ticket (fixed supply to self) with the MAP `type=ticket` marker and the
 *      1% bWallet mint fee output on the same tx;
 *   3. open the holders' room in bit-sign (signatures only), post the founding note, and register
 *      the ticket so the Market's Tickets filter lists it.
 * Steps 3 can fail while the new token is not yet indexed; the ticket is kept locally with
 * `roomTicker: null` and `finishTicketRooms` retries from the Market.
 */

/** A context whose wallet appends a 0-sat MAP output to the NEXT createAction (the deploy). */
function withTicketMap(ctx: OneSatContext, form: TicketForm): OneSatContext {
  let done = false;
  const wallet = new Proxy(ctx.wallet as WalletInterface, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outputs = [
            ...(args.outputs ?? []),
            { lockingScript: ticketMapScript(form).toHex(), satoshis: 0, outputDescription: 'bWallet ticket (MAP)' },
          ];
          return target.createAction({ ...args, outputs }, originator);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

export async function inscribeIcon(ctx: OneSatContext, file: File, ticker: string): Promise<string> {
  const res = await inscribe.execute(ctx, {
    base64Content: fileToBase64(await file.arrayBuffer()),
    contentType: file.type,
    map: { app: MINT_APP, type: 'ord', name: `$${ticker} ticket icon` },
  });
  if (!res.txid || res.error) throw new Error(res.error || 'Icon inscription failed');
  return `${res.txid}_0`;
}

export async function deployTicket(
  ctx: OneSatContext,
  form: TicketForm,
  opts: { icon: string | null; feeSats: number },
): Promise<Ticket> {
  const c = cleanTicket(form);
  const res = await deployBsv21Mint.execute(withTicketMap(withFeeOutput(ctx, opts.feeSats), form), {
    symbol: c.ticker,
    amount: c.supply,
    decimals: TICKET_DECIMALS,
    ...(opts.icon ? { icon: opts.icon } : {}),
  });
  if (res.error || !res.tokenId) throw new Error(res.error || 'Ticket mint failed');
  const ticket: Ticket = {
    tokenId: res.tokenId.replace('.', '_'),
    ticker: c.ticker,
    name: c.name,
    description: c.description || null,
    icon: opts.icon,
    eventDate: c.eventDate,
    priceSats: c.priceSats,
    supply: c.supply,
    roomTicker: null,
    createdAt: Date.now(),
  };
  saveLocalTicket(ticket);
  return ticket;
}

async function chatClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

/** Open the ticket's holders' room, post the founding note, register it. Returns the room ticker. */
export async function openTicketRoom(ctx: OneSatContext, ticket: Ticket, client?: BchatClient): Promise<string> {
  const c = client ?? (await chatClient(ctx));
  const key = `bsv21:${ticket.tokenId}`;
  await proveHoldings(ctx, c, key).catch(() => 0);
  const roomTicker = await c.startTokenRoom(key, { name: ticket.name, min: TICKET_MIN, purpose: TICKET_PURPOSE });
  const done = { ...ticket, roomTicker };
  saveLocalTicket(done);
  await c.send(roomTicker, foundingMessage(ticket)).catch(() => null);
  await registerTicket(done, c);
  return roomTicker;
}

/** Registry POST; a missing endpoint (not deployed yet) is not an error for the wallet. */
export async function registerTicket(ticket: Ticket, client: BchatClient): Promise<boolean> {
  return client
    .registerTicket(ticketRegistration(ticket))
    .then(() => true)
    .catch(() => false);
}

/** Market: retry rooms for this device's tickets whose room could not be opened at mint. */
export async function finishTicketRooms(ctx: OneSatContext): Promise<number> {
  const todo = localTickets().filter((t) => !t.roomTicker);
  if (!todo.length) return 0;
  const client = await chatClient(ctx).catch(() => null);
  if (!client) return 0;
  let n = 0;
  for (const t of todo) if (await openTicketRoom(ctx, t, client).catch(() => null)) n++;
  return n;
}

/** The public registry list (empty when the endpoint is not deployed or unreachable). */
export async function registryTickets(): Promise<Ticket[]> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  return client
    .tickets()
    .then(parseTicketList)
    .catch(() => []);
}
