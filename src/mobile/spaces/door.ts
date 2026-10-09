/**
 * Pay at the door (docs/BSPACES-PLAN.md Phase 3, the no-server version, 9 Oct 2026).
 *
 * A ticketed Space admits holders of its BSV-21 ticket. Listeners can't buy one in the Market (OrdLock listing is
 * off upstream), so they pay the door price straight to the host and the HOST'S OWN WALLET sends them a ticket:
 *
 *   listener: BRC-29 payment to the host's identity key (a fresh key only the host can derive, so never a
 *             platform address) + a `spacedoor` message to the host's message box carrying the payment's BEEF.
 *   host:     while hosting, reads `spacedoor`, checks the payment (txid, amount, paid to me, fresh, not seen),
 *             accepts it, sends `amount` ticket tokens to the listener's ordinals address, replies on
 *             `spacedoor_reply`. bit-sign then lets the listener in because they hold the ticket.
 *
 * No server custody and no new server secrets: the relay is the bMail message box. One admission per payment
 * txid (`DoorLedger`). A payment the host was half-way through sending a ticket for when the app stopped is never
 * re-sent automatically: it shows as "check by hand".
 *
 * Tickets are access passes (docs/TICKETS.md): the copy says "ticket" and "entry", never investment words.
 */
import type { WalletInterface } from '@bsv/sdk';
import { MessageBoxClient } from '@bsv/message-box-client';
import { bmailHost, payPostage, verifyPostage } from '../bmail/client';
import { newMessageId, parsePostage, type Envelope, type Postage } from '../bmail/envelope';

export const DOOR_BOX = 'spacedoor';
export const DOOR_REPLY_BOX = 'spacedoor_reply';
/** Default door price when the room sets none: one US cent. */
export const DOOR_DEFAULT_USD = 0.01;
/** Accept a payment down to this share of the price at the host's rate (the two phones' BSV rates differ a little). */
export const DOOR_RATE_SLACK = 0.8;
/** A door request older than this is refused (the listener asks again). */
export const DOOR_MAX_AGE_MS = 6 * 60 * 60_000;
const FUTURE_SKEW_MS = 10 * 60_000;

const KEY_RE = /^0[23][0-9a-f]{64}$/;
const ADDR_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,40}$/;
const TICKER_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type DoorRequest = {
  t: 'spacedoor';
  v: 1;
  id: string;
  /** Payer identity key (must equal the relay-authenticated sender). */
  from: string;
  /** Host identity key. */
  to: string;
  ticker: string;
  /** Where the ticket goes: the payer's ordinals address. */
  ordAddress: string;
  /** Price the payer was shown, in USD (informational; the host checks against its own price). */
  usd: number;
  at: number;
  payment: Postage;
};

export type DoorReply = {
  t: 'spacedoor_reply';
  v: 1;
  id: string;
  txid: string;
  ok: boolean;
  ticketTxid?: string;
  note?: string;
};

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const fromJson = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw === 'string') {
    try {
      return obj(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return obj(raw);
};

export const parseDoorRequest = (raw: unknown): DoorRequest | null => {
  const r = fromJson(raw);
  if (!r || r.t !== 'spacedoor' || r.v !== 1) return null;
  const payment = parsePostage(r.payment);
  const from = typeof r.from === 'string' ? r.from.toLowerCase() : '';
  const to = typeof r.to === 'string' ? r.to.toLowerCase() : '';
  if (
    !payment ||
    typeof r.id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(r.id) ||
    !KEY_RE.test(from) ||
    !KEY_RE.test(to) ||
    from === to ||
    typeof r.ticker !== 'string' ||
    !TICKER_RE.test(r.ticker) ||
    typeof r.ordAddress !== 'string' ||
    !ADDR_RE.test(r.ordAddress) ||
    typeof r.usd !== 'number' ||
    !Number.isFinite(r.usd) ||
    r.usd < 0 ||
    typeof r.at !== 'number' ||
    !Number.isFinite(r.at)
  )
    return null;
  return {
    t: 'spacedoor',
    v: 1,
    id: r.id,
    from,
    to,
    ticker: r.ticker.toUpperCase(),
    ordAddress: r.ordAddress,
    usd: r.usd,
    at: r.at,
    payment,
  };
};

export const parseDoorReply = (raw: unknown): DoorReply | null => {
  const r = fromJson(raw);
  if (!r || r.t !== 'spacedoor_reply' || typeof r.id !== 'string' || typeof r.txid !== 'string') return null;
  return {
    t: 'spacedoor_reply',
    v: 1,
    id: r.id,
    txid: r.txid,
    ok: r.ok === true,
    ticketTxid: typeof r.ticketTxid === 'string' && /^[0-9a-f]{64}$/i.test(r.ticketTxid) ? r.ticketTxid : undefined,
    note: typeof r.note === 'string' ? r.note.slice(0, 200) : undefined,
  };
};

/** The door price in USD: the room's ticket price when bit-sign gives one, else 1¢. */
export const doorPriceUsd = (entryUsd: number | null | undefined): number =>
  typeof entryUsd === 'number' && Number.isFinite(entryUsd) && entryUsd > 0 ? entryUsd : DOOR_DEFAULT_USD;

/** Fewest sats the host accepts for `priceSats` (price at the host's rate, less the rate slack). */
export const minAcceptSats = (priceSats: number) => Math.max(1, Math.floor(priceSats * DOOR_RATE_SLACK));

// ── the host's ledger: one admission per payment txid ──

export type LedgerEntry = {
  /** 'sending' is written BEFORE the ticket transfer, so a crash mid-send is never retried blindly. */
  status: 'sending' | 'sent' | 'refused';
  ticker: string;
  payer: string;
  at: number;
  ticketTxid?: string;
  note?: string;
};
export type DoorLedger = Record<string, LedgerEntry>;

const ledgerKey = (hostKey: string) => `bwx.spacedoor.${hostKey}`;
export const loadLedger = (hostKey: string): DoorLedger => {
  try {
    const j = JSON.parse(localStorage.getItem(ledgerKey(hostKey)) ?? 'null') as DoorLedger | null;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
};
export const saveLedger = (hostKey: string, l: DoorLedger) => {
  try {
    localStorage.setItem(ledgerKey(hostKey), JSON.stringify(l));
  } catch {
    /* storage unavailable: the in-memory ledger still guards this session */
  }
};

export type DoorCheck =
  | { ok: true }
  | { ok: false; reason: string; /** keep the message to retry later (e.g. no rate yet) */ retry?: boolean };

/**
 * The pure checks before any money is touched: who sent it, which room, how fresh, seen before, and the
 * claimed amount against the price. (The payment itself is then verified against the BEEF by the wallet.)
 */
export const checkDoorRequest = (
  req: DoorRequest,
  ctx: {
    sender: string;
    hostKey: string;
    ticker: string;
    priceSats: number | null;
    ledger: DoorLedger;
    now: number;
  },
): DoorCheck => {
  if (req.from !== ctx.sender.toLowerCase()) return { ok: false, reason: 'Sender does not match the request' };
  if (req.to !== ctx.hostKey) return { ok: false, reason: 'Not addressed to this host' };
  if (req.ticker !== ctx.ticker.toUpperCase()) return { ok: false, reason: 'For another room', retry: true };
  if (ctx.ledger[req.payment.txid]) return { ok: false, reason: 'Payment already used' };
  if (req.at > ctx.now + FUTURE_SKEW_MS || ctx.now - req.at > DOOR_MAX_AGE_MS)
    return { ok: false, reason: 'Request expired. Ask again.' };
  if (!ctx.priceSats) return { ok: false, reason: 'No BSV price yet', retry: true };
  if (req.payment.sats < minAcceptSats(ctx.priceSats)) return { ok: false, reason: 'Paid less than the door price' };
  return { ok: true };
};

// ── wallet + message box ──

const mbox = (wallet: WalletInterface) => new MessageBoxClient({ walletClient: wallet, host: bmailHost() });

export type DoorPay = { id: string; txid: string; sats: number };

/** Listener: pay `sats` to the host's identity key and ask for a ticket. */
export const payAtDoor = async (
  wallet: WalletInterface,
  a: { me: string; hostKey: string; ticker: string; ordAddress: string; usd: number; sats: number },
): Promise<DoorPay> => {
  const me = a.me.toLowerCase();
  const hostKey = a.hostKey.toLowerCase();
  if (!KEY_RE.test(hostKey) || hostKey === me) throw new Error('This Space has no host to pay');
  if (!ADDR_RE.test(a.ordAddress)) throw new Error('Your wallet has no address for the ticket');
  if (!Number.isSafeInteger(a.sats) || a.sats <= 0) throw new Error('No door price');
  const id = newMessageId();
  const payment = await payPostage(wallet, hostKey, a.sats, id);
  const req: DoorRequest = {
    t: 'spacedoor',
    v: 1,
    id,
    from: me,
    to: hostKey,
    ticker: a.ticker.replace(/^\$/, '').toUpperCase(),
    ordAddress: a.ordAddress,
    usd: a.usd,
    at: Date.now(),
    payment,
  };
  // Keep the request locally first: if delivery fails, "Send again" reuses this payment instead of paying twice.
  savePending(me, req);
  await deliver(wallet, req);
  return { id, txid: payment.txid, sats: payment.sats };
};

const deliver = (wallet: WalletInterface, req: DoorRequest) =>
  mbox(wallet).sendMessage(
    { recipient: req.to, messageBox: DOOR_BOX, body: JSON.stringify(req), skipEncryption: true },
    bmailHost(),
  );

const pendingKey = (me: string) => `bwx.spacedoor.pending.${me}`;
const savePending = (me: string, req: DoorRequest) => {
  try {
    localStorage.setItem(pendingKey(me), JSON.stringify(req));
  } catch {
    /* ignore */
  }
};
/** The listener's last paid door request (to re-send, never re-pay). */
export const loadPending = (me: string, ticker: string): DoorRequest | null => {
  try {
    const r = parseDoorRequest(localStorage.getItem(pendingKey(me.toLowerCase())));
    return r && r.ticker === ticker.replace(/^\$/, '').toUpperCase() ? r : null;
  } catch {
    return null;
  }
};
export const clearPending = (me: string) => {
  try {
    localStorage.removeItem(pendingKey(me.toLowerCase()));
  } catch {
    /* ignore */
  }
};
/** Re-send an already-paid request (delivery failed, or the host was offline and it expired from view). */
export const resendDoorRequest = (wallet: WalletInterface, req: DoorRequest) => deliver(wallet, req);

/** Listener: the host's answer to request `id`, if it has come (acknowledges what it reads). */
export const readDoorReply = async (wallet: WalletInterface, id: string): Promise<DoorReply | null> => {
  const client = mbox(wallet);
  const msgs = await client.listMessages({ messageBox: DOOR_REPLY_BOX, host: bmailHost() });
  let found: DoorReply | null = null;
  const ack: string[] = [];
  for (const m of msgs) {
    const r = parseDoorReply(m.body);
    if (r && r.id === id) {
      found = r;
      ack.push(m.messageId);
    }
  }
  if (ack.length) await client.acknowledgeMessage({ messageIds: ack, host: bmailHost() }).catch(() => undefined);
  return found;
};

export type SendTicket = (a: { ordAddress: string; payer: string }) => Promise<string>;

export type DoorRound = { admitted: number; refused: number; check: number; lastNote?: string };

/**
 * Host: one pass over the door box for `ticker`. Verifies, records, sends tickets, replies, acknowledges.
 * Requests for other rooms are left in the box for that room's door.
 */
export const runDoor = async (
  wallet: WalletInterface,
  a: {
    hostKey: string;
    ticker: string;
    priceSats: number | null;
    sendTicket: SendTicket;
    now?: () => number;
  },
): Promise<DoorRound> => {
  const hostKey = a.hostKey.toLowerCase();
  const client = mbox(wallet);
  const msgs = await client.listMessages({ messageBox: DOOR_BOX, host: bmailHost() });
  const ledger = loadLedger(hostKey);
  const round: DoorRound = { admitted: 0, refused: 0, check: 0 };
  const now = a.now ?? Date.now;
  for (const m of msgs) {
    const req = parseDoorRequest(m.body);
    const done = () =>
      client.acknowledgeMessage({ messageIds: [m.messageId], host: bmailHost() }).catch(() => undefined);
    if (!req) {
      await done();
      continue;
    }
    const c = checkDoorRequest(req, {
      sender: String(m.sender),
      hostKey,
      ticker: a.ticker,
      priceSats: a.priceSats,
      ledger,
      now: now(),
    });
    if (!c.ok) {
      if (c.retry) continue;
      const seen = ledger[req.payment.txid];
      // A repeat of a payment already admitted: tell the payer again (their first reply may have been missed).
      await reply(
        client,
        req,
        seen?.status === 'sent' ? { ok: true, ticketTxid: seen.ticketTxid } : { ok: false, note: c.reason },
      );
      if (!seen) round.refused++;
      round.lastNote = c.reason;
      await done();
      continue;
    }
    // The wallet checks the BEEF: txid, output amount, and that it pays a key only I can derive. Read-only first.
    const env = { from: req.from, postage: req.payment } as Envelope;
    const look = await verifyPostage(wallet, env, false);
    if (look.sats < minAcceptSats(a.priceSats ?? 0)) {
      await reply(client, req, { ok: false, note: look.note ?? 'Payment not valid' });
      ledger[req.payment.txid] = { status: 'refused', ticker: req.ticker, payer: req.from, at: now(), note: look.note };
      saveLedger(hostKey, ledger);
      round.refused++;
      round.lastNote = look.note;
      await done();
      continue;
    }
    const took = await verifyPostage(wallet, env, true);
    if (took.sats <= 0) {
      round.lastNote = took.note ?? 'Payment not accepted';
      continue; // e.g. wallet busy: try again next pass; nothing recorded, nothing sent
    }
    ledger[req.payment.txid] = { status: 'sending', ticker: req.ticker, payer: req.from, at: now() };
    saveLedger(hostKey, ledger);
    try {
      const ticketTxid = await a.sendTicket({ ordAddress: req.ordAddress, payer: req.from });
      ledger[req.payment.txid] = { ...ledger[req.payment.txid], status: 'sent', ticketTxid };
      saveLedger(hostKey, ledger);
      await reply(client, req, { ok: true, ticketTxid });
      round.admitted++;
    } catch (e) {
      // Not knowing whether it went out, never send again on our own: the host checks by hand.
      const note = e instanceof Error ? e.message.slice(0, 160) : 'Ticket send failed';
      ledger[req.payment.txid] = { ...ledger[req.payment.txid], note };
      saveLedger(hostKey, ledger);
      await reply(client, req, { ok: false, note: 'Paid. The host will send your ticket by hand.' });
      round.check++;
      round.lastNote = note;
    }
    await done();
  }
  return round;
};

const reply = (client: MessageBoxClient, req: DoorRequest, r: { ok: boolean; ticketTxid?: string; note?: string }) => {
  const body: DoorReply = { t: 'spacedoor_reply', v: 1, id: req.id, txid: req.payment.txid, ...r };
  return client
    .sendMessage(
      { recipient: req.from, messageBox: DOOR_REPLY_BOX, body: JSON.stringify(body), skipEncryption: true },
      bmailHost(),
    )
    .catch(() => undefined);
};

/** Payments the host took but could not confirm a ticket for (status still 'sending'). */
export const needsHandCheck = (l: DoorLedger, ticker: string) =>
  Object.entries(l)
    .filter(([, e]) => e.status === 'sending' && e.ticker === ticker.toUpperCase())
    .map(([txid, e]) => ({ txid, ...e }));
