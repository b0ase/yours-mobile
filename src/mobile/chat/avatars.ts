import { useEffect, useState } from 'react';
import type { BchatClient } from './api';

/**
 * Chat bubble avatars (owner, 6 Oct 2026: "users need avatars in their chat bubbles. /b is no exception").
 *
 * One request per thread for the handles not yet known (bit-sign /api/bitsign/avatars), cached for the
 * app's lifetime; a handle with no picture is cached as '' so it isn't asked for again. `$b` is ours and
 * never asked for: it wears the bWalletX mark.
 */
export const B_HANDLE = 'b';
export const B_AVATAR = 'https://bwalletx.com/icon-512.png';

const known = new Map<string, string>([[B_HANDLE, B_AVATAR]]);
const norm = (h: string) => h.replace(/^\$/, '').toLowerCase();

// Found pictures also survive a restart (a day), so a thread opens with faces, not initials.
const STORE = 'bwallet.chatAvatars.v1';
const DAY = 86_400_000;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, { u: string; t: number }>;
  for (const [h, v] of Object.entries(saved)) if (v?.u && Date.now() - v.t < DAY && !known.has(h)) known.set(h, v.u);
} catch {
  /* no storage (tests, private mode) */
}
const persist = (found: Record<string, string>) => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, { u: string; t: number }>;
    for (const [h, u] of Object.entries(found)) if (u) saved[norm(h)] = { u, t: Date.now() };
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* storage full / unavailable */
  }
};

/** Seed a handle's picture we already know (e.g. my own social avatar). */
export const rememberAvatar = (handle: string, url: string) => {
  if (handle && url) known.set(norm(handle), url);
};

export const avatarFor = (handle: string | null | undefined): string | null =>
  handle ? known.get(norm(handle)) || null : null;

export const useAvatars = (client: BchatClient, handles: (string | null | undefined)[]): number => {
  const [tick, setTick] = useState(0);
  const missing = [...new Set(handles.filter(Boolean).map((h) => norm(h!)))].filter((h) => !known.has(h));
  const key = missing.sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const ask = key.split(',').slice(0, 50);
    client
      .avatars(ask)
      .then((found) => {
        for (const h of ask) known.set(h, found[h] ?? '');
        persist(found);
        if (live) setTick((n) => n + 1);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, key]);
  return tick;
};

/** `/b` questions still waiting for $b: asked in the last 90 s with no $b reply pointing at them. */
export const pendingBQuestions = (
  messages: {
    id: string;
    body: string | null;
    created_at: string;
    author_handle: string | null;
    event_payload?: Record<string, unknown> | null;
    pending?: boolean;
  }[],
  now = Date.now(),
): Set<string> => {
  const answered = new Set(
    messages
      .filter((m) => norm(m.author_handle ?? '') === B_HANDLE)
      .map((m) => (m.event_payload?.reply_to as { id?: string } | undefined)?.id)
      .filter(Boolean) as string[],
  );
  return new Set(
    messages
      .filter(
        (m) =>
          /^\/b(\s|$)/i.test((m.body ?? '').trim()) &&
          !answered.has(m.id) &&
          (m.pending || now - Date.parse(m.created_at) < 90_000),
      )
      .map((m) => m.id),
  );
};
