/**
 * Helpers for multi-step background handlers that must not stop halfway (review of fix/envelope-queue, 13 Nov 2026).
 *
 * - runEveryStep: Forget site / Revoke all revoke grants in several stores. One step that throws (an envelope close
 *   on a web wallet without Web Locks, a storage error) used to abort the rest, leaving grants in place. Every step
 *   now runs, in order, and the failures are reported at the end.
 * - rejectStillPending: a sheet's answer settles each waiting request once. If anything before that settling throws,
 *   the requests nobody settled are rejected (nothing is paid), never left waiting for ever.
 */

export type Step = readonly [label: string, run: () => unknown];

/** Run every step in order whatever the others do. Resolves to "label: message" for each step that failed. */
export async function runEveryStep(steps: readonly Step[], log: (msg: string) => void = console.error): Promise<string[]> {
  const failed: string[] = [];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (error) {
      const line = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      log(`[everyStep] ${line}`);
      failed.push(line);
    }
  }
  return failed;
}

type Waiting = { reject: (error: Error) => void };

/**
 * Reject (and forget) every request in `ids` still waiting in `pending`. Requests already taken out of the map were
 * settled by their own path and are left alone, so no request is answered twice. Returns how many were rejected.
 */
export function rejectStillPending(ids: readonly string[], pending: Map<string, Waiting>, error: Error): number {
  let n = 0;
  for (const id of ids) {
    const p = pending.get(id);
    if (!p) continue;
    pending.delete(id);
    p.reject(error);
    n++;
  }
  return n;
}
