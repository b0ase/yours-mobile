/**
 * The Tokens list's "· Ticket" mark (patched into Bsv21TokensList by vite.config.mobile.ts).
 * Known tickets: the held ones the Tickets view last found, this device's minted tickets and
 * learned personal tokens (incl. this account's own). All local; no network on the Tokens list.
 */
import { knownPersonal } from '../names/personalToken';
import { localTickets } from '../tickets/tickets';
import { rememberedTicketIds, ticketMark } from './walletTickets';

export const tokenListLabel = (label: string, id: string | undefined): string =>
  ticketMark(label, id, [
    ...rememberedTicketIds(),
    ...localTickets().map((t) => t.tokenId),
    ...knownPersonal().map((p) => p.tokenId),
  ]);
