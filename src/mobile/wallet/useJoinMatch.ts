import { useEffect, useMemo, useRef, useState } from 'react';
import type { Contact } from '../chat/contacts';
import { resolvePaymail } from '../names/names';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import {
  joinNotices,
  loadJoinState,
  markSeen,
  runJoinChecks,
  saveJoinState,
  withJoined,
  type JoinState,
  type LookupName,
} from './joinMatch';

/** How often a run happens while the address book is open (each run is rate-limited per contact). */
export const JOIN_TIMER_MS = 10 * 60 * 1000;

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** name → name@bwalletx.com through the existing paymail resolver; a match needs a real identity key. */
export const lookupBwalletx: LookupName = async (name) => {
  if (!BWALLET_PAYMAIL_DOMAIN) return null;
  const paymail = `${name}@${BWALLET_PAYMAIL_DOMAIN}`;
  try {
    const r = await resolvePaymail(f, paymail, name);
    return r.pubkey && /^0[23][0-9a-f]{64}$/i.test(r.pubkey) ? paymail : null;
  } catch (e) {
    // "can't receive payments" still means the user exists; "not found" or network → no match today.
    return e instanceof Error && /can't receive/.test(e.message) ? paymail : null;
  }
};

export const useJoinMatch = (contacts: Contact[]) => {
  const [state, setState] = useState<JoinState>(loadJoinState);
  const latest = useRef(contacts);
  latest.current = contacts;
  const running = useRef(false);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (running.current || !latest.current.length) return;
      running.current = true;
      try {
        const next = await runJoinChecks(latest.current, loadJoinState(), lookupBwalletx, Date.now());
        saveJoinState(next);
        if (alive) setState(next);
      } finally {
        running.current = false;
      }
    };
    void run();
    const t = setInterval(() => void run(), JOIN_TIMER_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [contacts.length]);
  const list = useMemo(() => withJoined(contacts, state), [contacts, state]);
  const notices = useMemo(() => joinNotices(contacts, state), [contacts, state]);
  const dismiss = (name: string) => {
    const next = markSeen(loadJoinState(), name);
    saveJoinState(next);
    setState(next);
  };
  return { contacts: list, notices, dismiss };
};
