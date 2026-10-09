import './install';
/**
 * PROTOTYPE (demo/desktop-shell): the wide web layout. On with ?wide=1, or in a VITE_WIDE_WEB=1 build unless
 * ?wide=0, in a top-level window at least 1100px wide. Decided once at load; everything else is unchanged when off.
 */
const decide = (): boolean => {
  try {
    const q = new URLSearchParams(location.search).get('wide');
    const on = q === '1' || (import.meta.env.VITE_WIDE_WEB === '1' && q !== '0');
    return on && window.innerWidth >= 1100 && window.top === window;
  } catch {
    return false;
  }
};

export const WIDE_ON = decide();
// ww-onb too, before first paint: the app opens on welcome / unlock, so the first frame is already the auth panel
// (WideAuth keeps it; WideShell drops it once the unlocked wallet shows). No layout switch after load.
if (WIDE_ON) document.documentElement.classList.add('ww-on', 'ww-onb');

/** Window events the wide shell sends to TopNav, which owns the account drawer and the scan / pairing sheets. */
export const WW_OPEN = 'ww:open';
export type WwOpen = 'drawer' | 'scan' | 'pair' | 'tools' | 'accounts' | 'agents';
export const wwOpen = (what: WwOpen) => window.dispatchEvent(new CustomEvent<WwOpen>(WW_OPEN, { detail: what }));
