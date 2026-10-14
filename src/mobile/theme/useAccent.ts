import { useEffect, useState } from 'react';
import { ACCENT_EVENT, currentAccentId } from './accent';
import type { AccentId } from './accents';

/** The current app accent; re-renders when Theme → App colours or an account switch changes it. */
export function useAccentId(): AccentId {
  const [id, setId] = useState(currentAccentId);
  useEffect(() => {
    const on = () => setId(currentAccentId());
    on();
    window.addEventListener(ACCENT_EVENT, on);
    return () => window.removeEventListener(ACCENT_EVENT, on);
  }, []);
  return id;
}
