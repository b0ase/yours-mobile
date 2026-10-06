/* Shared navbar for bwalletx.com (bWalletX) and bwallet.space (bWallet, the store edition).
   One config renders the main page links into <nav aria-label="Pages"> and, for the current section,
   a contextual sub-nav under the top bar. Pages keep plain fallback links inside the nav for no-JS
   and crawlers; this script replaces them.
   Usage: <script src="/nav.js"></script> right after </header>
          <script src="/nav.js" data-edition="store"></script> on bwallet.space (also auto on that host). */
// Vercel Web Analytics (owner, 6 Oct 2026): cookieless page views, on every page that loads nav.js.
(function () {
  if (document.querySelector('script[src="/_vercel/insights/script.js"]')) return;
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  var s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
})();

(function () {
  var X = 'https://bwalletx.com';
  var NAV = {
    full: [
      { label: 'Features', href: '/features' },
      { label: 'Mint', href: '/mint' },
      { label: 'Exchange', href: '/exchange', pages: ['/exchange', '/exchange/strategies', '/pnees', '/pnee', '/buy'],
        sub: [
          { label: 'Exchange', href: '/exchange' },
          { label: 'Strategies', href: '/exchange/strategies' },
          { label: 'PNEEs', href: '/pnees', also: ['/pnee'] },
          { label: 'Buy BSV', href: '/buy' }
        ] },
      { label: 'Social', href: '/social', pages: ['/social', '/friends'] },
      { label: 'Agents', href: '/agents', pages: ['/agents', '/agent', '/strategies', '/strategies/spec', '/cli', '/mcp'],
        sub: [
          { label: 'Agent accounts', href: '/agents' },
          { label: 'b agent', href: '/agent' },
          { label: 'Strategies', href: '/strategies' },
          { label: 'Strategy spec', href: '/strategies/spec' },
          { label: 'CLI', href: '/cli' },
          { label: 'MCP', href: '/mcp' }
        ] },
      { label: 'Extension', href: '/extension' },
      { label: 'Developers', href: '/developers', pages: ['/developers', '/cli', '/mcp', '/apps/add', '/blog'],
        sub: [
          { label: 'Developers', href: '/developers' },
          { label: 'CLI', href: '/cli' },
          { label: 'MCP', href: '/mcp' },
          { label: 'Strategy spec', href: '/strategies/spec' },
          { label: 'Add your app', href: '/apps/add' },
          { label: 'Blog', href: '/blog' }
        ] }
    ],
    // Store edition (bWallet): browse-only Market, no trading, everything else lives on bWalletX.
    store: [
      { label: 'Market', href: '/market', pages: ['/market', '/market/strategies'],
        sub: [
          { label: 'Market', href: '/market' },
          { label: 'Strategies', href: '/market/strategies' }
        ] },
      { label: 'bWalletX features', href: X + '/features' },
      { label: 'Rooms &amp; tokens', href: X + '/friends' },
      { label: 'Get bWalletX &rarr;', href: X }
    ]
  };

  var me = document.currentScript;
  var store = (me && me.getAttribute('data-edition') === 'store') || /(^|\.)bwallet\.space$/.test(location.hostname);
  var items = NAV[store ? 'store' : 'full'];

  function norm(p) {
    p = p.replace(/\.html$/, '').replace(/\/index$/, '').replace(/\/+$/, '');
    return p || '/';
  }
  var path = norm(location.pathname);
  if (/^\/blog\//.test(path)) path = '/blog'; // every post sits under Developers › Blog
  function link(it, active) {
    return '<a href="' + it.href + '"' + (active ? ' aria-current="page"' : '') + '>' + it.label + '</a>';
  }

  var section = null;
  items.forEach(function (it) {
    if ((it.pages || [it.href]).indexOf(path) !== -1) section = it;
  });

  var main = document.querySelector('.topbar nav[aria-label="Pages"]');
  if (!main) return;
  main.innerHTML = items.map(function (it) { return link(it, it === section); }).join('');

  if (section && section.sub) {
    var sub = document.createElement('nav');
    sub.className = 'section-nav sub-nav';
    sub.setAttribute('aria-label', section.label.replace(/&[a-z]+;/g, '') + ' pages');
    sub.innerHTML = '<div class="wrap">' + section.sub.map(function (it) {
      return link(it, path === it.href || (it.also || []).indexOf(path) !== -1);
    }).join('') + '</div>';
    var bar = main.closest('.topbar');
    var on = bar.querySelector('.section-nav');
    if (on) bar.insertBefore(sub, on); else bar.appendChild(sub);
    document.documentElement.classList.add('has-subnav');
  }

  // Follow on X (bWalletX only): an icon before the Download / Web buttons, on every page.
  var cta = main.closest('.topbar') && main.closest('.topbar').querySelector('.nav-cta');
  // Both editions (owner, 6 Oct 2026: bwallet.space needs X and GitHub too).
  if (cta && !cta.querySelector('.x-link')) {
    var x = document.createElement('a');
    x.className = 'x-link';
    x.href = 'https://x.com/bWalletX';
    x.target = '_blank';
    x.rel = 'noopener';
    x.setAttribute('aria-label', 'bWalletX on X');
    x.title = '@bWalletX on X';
    x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    cta.insertBefore(x, cta.firstChild);
    // Source on GitHub (the wallet is open source), next to X (owner, 6 Oct 2026).
    var gh = document.createElement('a');
    gh.className = 'x-link';
    gh.href = 'https://github.com/bitcoin-corp/bwallet';
    gh.target = '_blank';
    gh.rel = 'noopener';
    gh.setAttribute('aria-label', 'bWalletX source code on GitHub');
    gh.title = 'Source code on GitHub';
    gh.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
    cta.insertBefore(gh, x.nextSibling);
    // bChat instead of Telegram/Discord (owner, 6 Oct 2026): a white b, next to X and GitHub.
    var bc = document.createElement('a');
    bc.className = 'x-link bchat-link';
    bc.href = 'https://www.bitcoinchat.online/room/LOUNGE';
    bc.target = '_blank';
    bc.rel = 'noopener';
    bc.setAttribute('aria-label', 'Join the bWallet Lounge on bChat');
    bc.title = 'Join the bWallet Lounge on bChat';
    // bChat's own b (bit-sign public/bchat-icon.svg: flag-top stem + bowl), in white.
    bc.innerHTML = '<svg viewBox="12 10 96 96" width="20" height="20" aria-hidden="true"><mask id="bc-hole"><rect x="0" y="0" width="120" height="120" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask><g fill="currentColor" mask="url(#bc-hole)"><polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="33"/></g></svg>';
    cta.insertBefore(bc, gh.nextSibling);
  }

  var css = document.createElement('style');
  css.textContent =
    '.topbar .sub-nav a[aria-current="page"]{color:#000!important;background:#F5B800;border-color:#F5B800}' +
    '.sub-nav{padding-top:0}' +
    '.nav-cta .x-link{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:1px solid #ffffff33;color:#fff;margin-right:8px;vertical-align:middle}' +
    '.nav-cta .x-link:hover{border-color:#F5B800;color:#F5B800}' +
    'html.has-subnav main.ext{padding-top:190px!important}' +
    '@media (max-width:859px){html.has-subnav main.ext{padding-top:212px!important}}' +
    (store ? '.topbar .sub-nav a[aria-current="page"]{color:#F5B800!important;background:#010101!important;border-color:#010101!important}' +
      '.nav-cta .x-link{color:#010101!important;border-color:rgba(0,0,0,.35)!important}.nav-cta .x-link:hover{background:#010101;color:#F5B800!important}' : '');
  document.head.appendChild(css);
})();
