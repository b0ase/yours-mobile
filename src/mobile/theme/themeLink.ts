import { packFromThemeParam } from './accent';
import { PAID_EDITIONS, type AccentId } from './accents';

/**
 * Install links for the phone apps (bwalletx.com/themes, owner 18 Oct 2026): bwalletx://theme/<pack> opens
 * Theme › App colours with that pack offered; it is applied only when the user taps Use it. Same names as the web
 * ?theme= links (accent.ts packFromThemeParam). Paid editions are bought in the Store, so a link never offers one.
 */
export function parseThemeLink(url: string | null | undefined): AccentId | null {
  const m = /^bwalletx:\/\/theme\/?([^/?#]*)\/?(?:\?([^#]*))?/i.exec(String(url ?? '').trim());
  if (!m) return null;
  const raw = m[1] || new URLSearchParams(m[2] ?? '').get('id') || '';
  let name = '';
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const id = packFromThemeParam(name);
  if (!id || PAID_EDITIONS.includes(id)) return null;
  return id;
}
