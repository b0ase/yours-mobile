import { createRoot } from 'react-dom/client';
import { WideShell } from './WideShell';

/** PROTOTYPE: is the wide web layout requested here? (?wide=1 or a VITE_WIDE_WEB=1 build, and a wide window.) */
export const wantsWideLayout = () => {
  const q = new URLSearchParams(location.search).get("wide");
  const on = q === '1' || (import.meta.env.VITE_WIDE_WEB === '1' && q !== '0');
  return on && window.innerWidth >= 1100 && window.top === window;
};

export const mountWideLayout = () => {
  document.querySelector('.bwallet-web-banner')?.remove();
  const live = new URL(location.href);
  live.search = '?wide=0';
  live.hash = '';
  document.getElementById('root')?.remove();
  document.documentElement.classList.add('ww-on');
  const host = document.createElement('div');
  host.id = 'ww-root';
  document.body.appendChild(host);
  createRoot(host).render(<WideShell liveUrl={live.href} />);
};
