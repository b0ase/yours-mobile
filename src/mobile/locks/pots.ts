/**
 * Pots & Locks (owner, 10 Oct 2026): the Lock screen groups locks into pots. A pot is a label on lock plans
 * (LockPlan.pot): 'pnee' for BSV locked to back PNEEs, a template id (Pension, Savings goal…) for locks started
 * from a template, and everything else under Other locks. Pure helpers; the coins never depend on the grouping.
 */
import { planStatus, type LockPlan } from './schedule';
import { TEMPLATES } from './templates';

export const PNEE_POT = 'pnee';
export const OTHER_POT = 'other';

export type Pot = {
  id: string;
  name: string;
  plans: LockPlan[];
  /** Sats still locked (unclaimed). */
  locked: number;
  /** Sats matured and ready to claim. */
  ready: number;
  /** Next unlock height, if any. */
  next?: number;
};

export const potName = (id: string) =>
  id === PNEE_POT
    ? 'PNEEs'
    : id === OTHER_POT
      ? 'Other locks'
      : (TEMPLATES.find((t) => t.id === id)?.name ?? 'Other locks');

const potOf = (p: LockPlan) =>
  p.pot === PNEE_POT || TEMPLATES.some((t) => t.id === p.pot) ? (p.pot as string) : OTHER_POT;

/** Plans grouped into pots: PNEEs first, Other locks last, the rest by most locked. */
export function groupPots(plans: LockPlan[], height: number): Pot[] {
  const by = new Map<string, Pot>();
  for (const p of plans) {
    const id = potOf(p);
    const pot = by.get(id) ?? { id, name: potName(id), plans: [], locked: 0, ready: 0 };
    const s = planStatus(p, height);
    pot.plans.push(p);
    pot.locked += s.locked;
    pot.ready += s.ready;
    if (s.next != null && (pot.next == null || s.next < pot.next)) pot.next = s.next;
    by.set(id, pot);
  }
  const rank = (x: Pot) => (x.id === PNEE_POT ? 0 : x.id === OTHER_POT ? 2 : 1);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.locked - a.locked);
}
