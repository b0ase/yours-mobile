import { emptyLedger, type Ledger } from './ledger';

/** Pay ledger kept on this device, per identity key (statements are private: never sent to any server of ours). */
export type WagesState = { ledger: Ledger; scanned: string[] };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const key = (me: string) => `bw-wages:${me}`;
export const WAGES_EVENT = 'bw-wages-changed';

export const loadWages = (me: string, st: Store | null = ls()): WagesState => {
  try {
    const j = JSON.parse(st?.getItem(key(me)) ?? 'null') as Partial<WagesState> | null;
    const l = j?.ledger;
    return {
      ledger: {
        statements: Array.isArray(l?.statements) ? l.statements : [],
        payments: Array.isArray(l?.payments) ? l.payments : [],
        disputes: Array.isArray(l?.disputes) ? l.disputes : [],
      },
      scanned: Array.isArray(j?.scanned) ? j.scanned.slice(-5000) : [],
    };
  } catch {
    return { ledger: emptyLedger(), scanned: [] };
  }
};

export const saveWages = (me: string, s: WagesState, st: Store | null = ls()) => {
  try {
    st?.setItem(key(me), JSON.stringify(s));
    globalThis.dispatchEvent?.(new Event(WAGES_EVENT));
  } catch {
    /* storage full or unavailable */
  }
};
