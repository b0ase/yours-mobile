import { DEFAULT_ACCENT, RETIRED_PACKS, THEMES } from './accents';

/**
 * The in-app splash (owner, 15 Oct 2026: "splash screens should follow the theme"): an inline script injected
 * into the shell's <head> at build time (vite.config.mobile.ts). Before any module loads it reads the saved pack
 * (the same boot key as accent.ts) and paints the page and an outline b in that pack's colours, then removes
 * itself once React has drawn into #root. Gold paints nothing, so the default stays exactly as before (the black
 * page that follows the native launch screen). Native launch screens are static images and stay as they are.
 */
export const SPLASH_BOOT_KEY = 'bwx.accent.boot';

/** Pack id → [page, ink] for every pack but Gold; retired ids map to their replacement's colours. */
export function splashPalette(): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const a of THEMES) {
    if (a.id === DEFAULT_ACCENT) continue;
    out[a.id] = [a.bg, a.group === 'mono' ? a.text : a.accent];
  }
  for (const [old, now] of Object.entries(RETIRED_PACKS)) if (out[now]) out[old] = out[now];
  return out;
}

const B_SVG =
  '<svg width="72" height="97" viewBox="20 6 80 104" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" aria-hidden="true"><polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="31"/><circle cx="60" cy="72" r="15"/></svg>';

/** The inline <script> for the shell's <head>. Every storage access is guarded; failure leaves Gold's page. */
export function splashScript(): string {
  const js = `(function(){try{var P=${JSON.stringify(splashPalette())};var id=localStorage.getItem(${JSON.stringify(
    SPLASH_BOOT_KEY,
  )});var c=id&&P[id];if(!c)return;var d=document,r=d.documentElement;r.style.background=c[0];var m=d.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c[0]);var s=d.createElement('div');s.id='bw-splash';s.setAttribute('aria-hidden','true');s.style.cssText='position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:opacity .25s ease;background:'+c[0]+';color:'+c[1];s.innerHTML=${JSON.stringify(
    B_SVG,
  )};var go=function(){var root=d.getElementById('root');if(!root)return;var done=function(){s.style.opacity='0';setTimeout(function(){s.remove()},300)};if(root.childElementCount){done();return}new MutationObserver(function(_,o){if(root.childElementCount){o.disconnect();done()}}).observe(root,{childList:true})};d.addEventListener('DOMContentLoaded',function(){d.body.appendChild(s);go()})}catch(e){}})();`;
  return `<script>${js}</script>`;
}
