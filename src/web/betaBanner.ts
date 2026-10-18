// The web build's beta notice (vite.config.web.ts injects it into <body>): yellow-and-black hazard tape with two
// actions, Swap into BSV and Buy BSV, dismissible for the session. It takes its own height in the layout
// (--web-banner-height, web.css), so it never covers the tool bar.
//
// Optional video: drop a looping clip at public/media/beta-hazard.mp4 and the next web build copies it to
// /media/beta-hazard.mp4 and plays it muted behind the text. Without the file, the CSS tape shows.

export const BANNER_TEXT = 'Beta: use small amounts';
export const BANNER_VIDEO = 'media/beta-hazard.mp4';
export const BANNER_EVENT = 'bw-web-banner';
export const DISMISS_KEY = 'bw.webBanner.dismissed';

export type BannerAction = 'swap' | 'buy';

export function bannerHtml(hasVideo: boolean): string {
  const video = hasVideo
    ? `<video class="bwallet-web-banner__video" src="/${BANNER_VIDEO}" autoplay loop muted playsinline aria-hidden="true" onerror="this.remove()"></video>`
    : '';
  return [
    `<div class="bwallet-web-banner" role="status">`,
    video,
    `<span class="bwallet-web-banner__text">${BANNER_TEXT}</span>`,
    `<button type="button" class="bwallet-web-banner__link" data-bw-banner="swap">Swap into BSV</button>`,
    `<button type="button" class="bwallet-web-banner__link" data-bw-banner="buy">Buy BSV</button>`,
    `<button type="button" class="bwallet-web-banner__close" data-bw-banner="close" aria-label="Hide for now">×</button>`,
    `</div>`,
  ].join('');
}

/** Inlined into the page (self-contained): session dismissal, and the two actions as a window event for the app. */
export function installWebBanner(): void {
  const KEY = 'bw.webBanner.dismissed';
  const root = document.documentElement;
  const el = document.querySelector('.bwallet-web-banner');
  if (!el) return;
  const hide = () => {
    el.remove();
    root.style.setProperty('--web-banner-height', '0px');
  };
  try {
    if (sessionStorage.getItem(KEY) === '1') return hide();
  } catch {
    /* storage blocked: show it */
  }
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-bw-banner]');
    const action = b?.getAttribute('data-bw-banner');
    if (!action) return;
    if (action === 'close') {
      try {
        sessionStorage.setItem(KEY, '1');
      } catch {
        /* hide for this page only */
      }
      return hide();
    }
    window.dispatchEvent(new CustomEvent('bw-web-banner', { detail: action }));
  });
}
