/**
 * One prompt for one payment (TokenBlaster #105, 26 Oct 2026): the game shows Retry after 20 s and sends the same
 * createAction again. While the first is still running (sheet open, or signing), an identical call from the same
 * site joins it: one sheet, one transaction, and both callers get the same answer. It can never be signed twice.
 *
 * "Identical" = same originator, description, reference, outputs (script + amount) and inputs. Anything else is a
 * new call. Joining ends when the first call answers; a later repeat is judged by the repeat guard as before.
 */

type Out = { lockingScript?: string; satoshis?: number };
type In = { outpoint?: string };
export type CreateActionLike = { description?: string; reference?: string; outputs?: Out[]; inputs?: In[] };

export function createActionKey(originator: string | undefined, a: CreateActionLike): string {
  return JSON.stringify([
    originator ?? '',
    a.description ?? '',
    a.reference ?? '',
    (a.outputs ?? []).map((o) => [o.lockingScript ?? '', o.satoshis ?? 0]),
    (a.inputs ?? []).map((i) => i.outpoint ?? ''),
  ]);
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
