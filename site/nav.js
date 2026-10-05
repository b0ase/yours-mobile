/* Shared navbar for bwalletx.com (bWalletX) and bwallet.space (bWallet, the store edition).
   One config renders the main page links into <nav aria-label="Pages"> and, for the current section,
   a contextual sub-nav under the top bar. Pages keep plain fallback links inside the nav for no-JS
   and crawlers; this script replaces them.
   Usage: <script src="/nav.js"></script> right after </header>
          <script src="/nav.js" data-edition="store"></script> on bwallet.space (also auto on that host). */
(function () {
  var X = 'https://bwalletx.com';
  var NAV = {
    full: [
      { label: 'Features', href: '/features' },
      { label: 'Mint', href: '/mint' },
      { label: 'Buy', href: '/buy' },
      { label: 'Exchange', href: '/exchange', pages: ['/exchange', '/exchange/strategies', '/pnees', '/pnee'],
        sub: [
          { label: 'Exchange', href: '/exchange' },
          { label: 'Strategies', href: '/exchange/strategies' },
          { label: 'PNEEs', href: '/pnees', also: ['/pnee'] }
        ] },
      { label: 'Social', href: '/social', pages: ['/social', '/friends'] },
      { label: 'Agents', href: '/agent', pages: ['/agent', '/strategies', '/strategies/spec'],
        sub: [
          { label: 'Agents', href: '/agent' },
          { label: 'Strategies', href: '/strategies' },
          { label: 'Strategy spec', href: '/strategies/spec' },
          { label: 'CLI', href: '/cli' },
          { label: 'MCP', href: '/mcp' }
        ] },
      { label: 'Android', href: '/android' },
      { label: 'iPhone', href: '/iphone' },
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
      { label: 'Buy BSV', href: X + '/buy' },
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
  if (!store && cta && !cta.querySelector('.x-link')) {
    var x = document.createElement('a');
    x.className = 'x-link';
    x.href = 'https://x.com/bWalletX';
    x.target = '_blank';
    x.rel = 'noopener';
    x.setAttribute('aria-label', 'bWalletX on X');
    x.title = '@bWalletX on X';
    x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    cta.insertBefore(x, cta.firstChild);
  }

  var css = document.createElement('style');
  css.textContent =
    '.topbar .sub-nav a[aria-current="page"]{color:#000!important;background:#F5B800;border-color:#F5B800}' +
    '.sub-nav{padding-top:0}' +
    '.nav-cta .x-link{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:1px solid #ffffff33;color:#fff;margin-right:8px;vertical-align:middle}' +
    '.nav-cta .x-link:hover{border-color:#F5B800;color:#F5B800}' +
    'html.has-subnav main.ext{padding-top:190px!important}' +
    '@media (max-width:859px){html.has-subnav main.ext{padding-top:212px!important}}' +
    (store ? '.topbar .sub-nav a[aria-current="page"]{color:#F5B800!important;background:#010101!important;border-color:#010101!important}' : '');
  document.head.appendChild(css);
})();
