import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { formatAmount, listPots, listSubs, nextDue, type Subscription } from './pots';

/**
 * Pot notifications (POTS-SUBSCRIPTIONS-PLAN.md §6): a local reminder 24h before each standing order is due,
 * re-scheduled on every change (fires with the app closed, no server), plus "pot running low" and "payment
 * failed" notices. Never prompts for permission here; only posts if it was already granted.
 */
const BASE = 43_000;
const SPAN = 5_000;
const REMIND_BEFORE = 24 * 3600_000;
const LOW_KEY = 'bwallet.potLowNotified';

/** A stable notification id for a subscription's reminder (BASE..BASE+SPAN). */
export const reminderId = (subId: string) => {
  let h = 0;
  for (const ch of subId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BASE + (h % SPAN);
};

/** The reminders to schedule at `now`: active orders whose reminder time is still ahead. */
export const plannedReminders = (subs: Subscription[], potName: (id: string) => string, now: number) =>
  subs
    .filter((s) => s.status === 'active' || s.status === 'lowFunds')
    .map((s) => ({ s, due: nextDue(s) }))
    .filter((x): x is { s: Subscription; due: number } => x.due !== null && x.due - REMIND_BEFORE > now)
    .map(({ s, due }) => ({
      id: reminderId(s.id),
      at: due - REMIND_BEFORE,
      title: `${s.payee.name}: ${formatAmount(s.amount)} tomorrow`,
      body: `Paid from your ${potName(s.potId)} pot when you open the app.`,
    }));

const granted = async () => {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await LocalNotifications.checkPermissions()).display === 'granted';
  } catch {
    return false;
  }
};

/** Replace every pot reminder with the current set. */
export const reschedulePotReminders = async (now = Date.now()) => {
  if (!(await granted())) return;
  try {
    const { notifications } = await LocalNotifications.getPending();
    const old = notifications.filter((n) => n.id >= BASE && n.id < BASE + SPAN).map((n) => ({ id: n.id }));
    if (old.length) await LocalNotifications.cancel({ notifications: old });
    const names = new Map(listPots().map((p) => [p.identityAddress, p.name]));
    const next = plannedReminders(listSubs(), (id) => names.get(id) ?? 'pot', now);
    if (next.length)
      await LocalNotifications.schedule({
        notifications: next.map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: { at: new Date(n.at) }, isExactNotification: false })),
      });
  } catch {
    /* notifications unavailable */
  }
};

/** Post a notice now (payment failed, pot low). */
export const notifyPot = async (title: string, body: string) => {
  if (!(await granted())) return;
  try {
    await LocalNotifications.schedule({
      notifications: [{ id: BASE + SPAN + Math.floor(Math.random() * 1000), title, body, isExactNotification: false }],
    });
  } catch {
    /* notifications unavailable */
  }
};

/** "Pot running low", at most once a day per pot. */
export const notifyLowFunds = (potId: string, potName: string, covers: number, now = Date.now()) => {
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(localStorage.getItem(LOW_KEY) || '{}') as Record<string, number>;
  } catch {
    /* fresh */
  }
  if (now - (seen[potId] ?? 0) < 24 * 3600_000) return;
  try {
    localStorage.setItem(LOW_KEY, JSON.stringify({ ...seen, [potId]: now }));
  } catch {
    /* storage unavailable */
  }
  void notifyPot(
    `${potName} pot is running low`,
    covers === 0
      ? 'It can’t cover the next payment. Top it up to keep it going.'
      : 'It covers only the next payment. Top it up.',
  );
};
