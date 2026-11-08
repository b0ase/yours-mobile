/**
 * One prompt for one payment (TokenBlaster #105, 26 Oct 2026): the game shows Retry after 20 s and sends the same
 * createAction again. While the first is still running (sheet open, or signing), an identical call from the same
 * site and the same tab joins it: one sheet, one transaction, and both callers get the same answer. It can never be
 * signed twice.
 *
 * Since BRC-219 (8 Nov 2026) a sheet that is up never expires, so this is what keeps a Retry from becoming a second
 * sheet or a second payment. Join, not reject: a site that gave up on its first promise and retried still receives the
 * real answer (the txid of what the person approved), instead of "already waiting" while the payment goes through on
 * a promise nobody reads.
 *
 * "Identical" = same originator, same caller scope (the browser tab; '' where there are no tabs) and the SAME
 * createAction arguments, every field (outputs with their baskets and tags, inputs, labels, options such as noSend,
 * lockTime, inputBEEF, ...). Anything else is a new call with its own sheet: two different requests are never merged,
 * and two tabs of one site never share an answer. Joining ends when the first call answers; a later repeat is judged
 * by the repeat guard as before.
 */
import { Hash, Utils } from '@bsv/sdk';

type Out = { lockingScript?: string; satoshis?: number };
type In = { outpoint?: string };
export type CreateActionLike = { description?: string; reference?: string; outputs?: Out[]; inputs?: In[] };

/** JSON with every object's keys sorted, so the same arguments always give the same text. */
const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x as Record<string, unknown>)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );

export function createActionKey(originator: string | undefined, a: CreateActionLike | object, scope = ''): string {
  // Hashed: inputBEEF can be large, and the key lives in a map while the call runs.
  return Utils.toHex(Hash.sha256(Utils.toArray(canonical([originator ?? '', scope, a]), 'utf8')));
}

export class CreateActionDedupe<R> {
  private inFlight = new Map<string, ((r: R) => void)[]>();

  /**
   * Returns the responder the call should answer with, or undefined when it joined a call already running (its
   * `reply` is called with that call's answer).
   */
  begin(key: string, reply: (r: R) => void): ((r: R) => void) | undefined {
    const waiters = this.inFlight.get(key);
    if (waiters) {
      waiters.push(reply);
      return undefined;
    }
    const list = [reply];
    this.inFlight.set(key, list);
    let done = false;
    return (r: R) => {
      if (done) return;
      done = true;
      if (this.inFlight.get(key) === list) this.inFlight.delete(key);
      for (const f of list) f(r);
    };
  }

  running(key: string): boolean {
    return this.inFlight.has(key);
  }
}
