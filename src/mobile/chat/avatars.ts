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
  messages: { id: string; body: string | null; created_at: string; author_handle: string | null; event_payload?: Record<string, unknown> | null; pending?: boolean }[],
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
