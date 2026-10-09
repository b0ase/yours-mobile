/**
 * Reply bookkeeping for a paired session (per channel), kept in memory only.
 *
 * - Answered: the last replies by request id (bounded: REPLY_MAX per channel, REPLY_TTL_MS). When a
 *   site re-sends a request it already got an answer for (its socket was away when the answer came),
 *   the stored reply is sent again instead of running the call twice. This matters most for
 *   createAction / signAction, which must never run twice.
 * - In flight: a repeat of a request still being handled is ignored; the first run replies.
 * - Outbox: replies that were ready while our socket was closed, sent on reconnect.
 *
 * Replies are stored as plaintext messages and sealed at send time, so every (re)send carries a fresh
 * Sealer counter and the site's replay protection still holds.
 */
import type { PairMessage } from '../../pair/protocol';

export const REPLY_MAX = 50;
export const REPLY_TTL_MS = 10 * 60_000;
const OUTBOX_MAX = 50;

type Book = {
  answered: Map<string, { msg: PairMessage; at: number }>;
  inFlight: Set<string>;
  outbox: PairMessage[];
};

export class ReplyBook {
  private books = new Map<string, Book>();
  constructor(private now: () => number = Date.now) {}

  private book(c: string): Book {
    let b = this.books.get(c);
    if (!b) this.books.set(c, (b = { answered: new Map(), inFlight: new Set(), outbox: [] }));
    return b;
  }

  private prune(b: Book) {
    const t = this.now();
    for (const [id, r] of b.answered) if (t - r.at > REPLY_TTL_MS) b.answered.delete(id);
    while (b.answered.size > REPLY_MAX) b.answered.delete(b.answered.keys().next().value!);
  }

  /**
   * Called when a request arrives. 'run' = handle it (and it is now in flight); 'busy' = the same id is
   * still being handled, drop this copy; otherwise the stored reply to re-send.
   */
  begin(c: string, id: string): 'run' | 'busy' | { replay: PairMessage } {
    const b = this.book(c);
    this.prune(b);
    const done = b.answered.get(id);
    if (done) return { replay: done.msg };
    if (b.inFlight.has(id)) return 'busy';
    b.inFlight.add(id);
    return 'run';
  }

  /** Remember the reply to a request (before it is sent, so a repeat never re-runs the call). */
  finish(c: string, id: string, msg: PairMessage) {
    const b = this.book(c);
    b.inFlight.delete(id);
    b.answered.delete(id);
    b.answered.set(id, { msg, at: this.now() });
    this.prune(b);
  }

  /** Hold a reply that could not be sent (socket closed). */
  hold(c: string, msg: PairMessage) {
    const b = this.book(c);
    b.outbox.push(msg);
    if (b.outbox.length > OUTBOX_MAX) b.outbox.shift();
  }

  /** Take everything held for a channel, oldest first. */
  drain(c: string): PairMessage[] {
    const b = this.books.get(c);
    return b ? b.outbox.splice(0) : [];
  }

  forget(c: string) {
    this.books.delete(c);
  }
}
