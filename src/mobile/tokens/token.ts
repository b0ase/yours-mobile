import { safety, type SafetyFilter } from '../market/safety';
import { validateSupply } from '../names/personalToken';
import { TICKET_BLOCKED, isTicker, ticketCost, type TicketCost } from '../tickets/tickets';

/**
 * Mint a token (Wallet → Mint → Mint a token): a plain BSV-21 token. A token is neutral: whether
 * it acts as a ticket is the ROOM's access rule (hold to enter / spend on entry), not the token's.
 * Every token still gets a holders' room (bChat lists a room for any BSV-21).
 *
 * Same deploy path as tickets (deployBsv21 in tickets/mintTicket.ts) and the same 1% mint fee,
 * but no `type=ticket` MAP tag. Pure helpers; nothing here signs or broadcasts.
 */

export const TOKEN_COPY = 'Create a BSV-21 token. Every token has a room for its holders.';
export const DEFAULT_TOKEN_SUPPLY = '1000000';
export const MAX_DECIMALS = 18;
/** BSV-21 amounts are u64. */
const MAX_RAW = 2n ** 64n - 1n;
/** Deploy inscription (~250 B with an outpoint icon), no MAP output. */
export const TOKEN_DEPLOY_BYTES = 350;

export interface TokenForm {
  name: string;
  ticker: string;
  /** Whole tokens. */
  supply: string;
  decimals: string;
  description: string;
}

export const emptyTokenForm = (): TokenForm => ({
  name: '',
  ticker: '',
  supply: DEFAULT_TOKEN_SUPPLY,
  decimals: '0',
  description: '',
});

const digits = (s: string) => (s || '').trim().replace(/[,_\s]/g, '');

export function validateToken(f: TokenForm, s: SafetyFilter = safety()): string | null {
  const name = f.name.trim();
  if (!name) return 'Name the token.';
  if (name.length > 64) return 'Keep the name under 64 characters.';
  const t = f.ticker.trim().replace(/^\$/, '');
  if (!t) return 'Add a ticker.';
  if (!isTicker(t)) return 'Ticker: capital letters, digits, - or _ only (max 32).';
  const bad = validateSupply(f.supply);
  if (bad) return bad;
  const d = f.decimals.trim();
  if (!/^\d{1,2}$/.test(d) || Number(d) > MAX_DECIMALS) return `Decimals is a whole number from 0 to ${MAX_DECIMALS}.`;
  if (BigInt(digits(f.supply)) * 10n ** BigInt(d) > MAX_RAW) return 'Supply is too large for these decimals.';
  if (f.description.length > 1000) return 'Keep the description under 1000 characters.';
  if (s.check({ ids: [], texts: [name, t, f.description] }).blocked) return TICKET_BLOCKED;
  return null;
}

/** Cleaned values; `amount` is raw units (supply × 10^decimals), `min` is 1 whole token raw. */
export const cleanToken = (f: TokenForm) => {
  const decimals = Number(f.decimals.trim() || '0');
  const scale = 10n ** BigInt(decimals);
  const supply = BigInt(digits(f.supply) || '0').toString();
  return {
    name: f.name.trim(),
    ticker: f.ticker.trim().replace(/^\$/, ''),
    supply,
    decimals,
    amount: (BigInt(supply) * scale).toString(),
    min: scale.toString(),
    description: f.description.trim(),
  };
};

export const tokenCost = (iconBytes: number, satsPerKb: number, usdPerBsv = 0, feeAddress?: string): TicketCost =>
  ticketCost(iconBytes, satsPerKb, usdPerBsv, feeAddress, TOKEN_DEPLOY_BYTES);

/** The room's first message. */
export const tokenFoundingMessage = (t: { name: string; ticker: string; description: string }) =>
  [`Welcome to ${t.name}, the room for $${t.ticker} holders.`, ...(t.description ? ['', t.description] : [])].join(
    '\n',
  );
