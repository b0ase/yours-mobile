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

  var css = document.createElement('style');
  css.textContent =
    '.topbar .sub-nav a[aria-current="page"]{color:#000!important;background:#F5B800;border-color:#F5B800}' +
    '.sub-nav{padding-top:0}' +
    'html.has-subnav main.ext{padding-top:190px!important}' +
    '@media (max-width:859px){html.has-subnav main.ext{padding-top:212px!important}}' +
    (store ? '.topbar .sub-nav a[aria-current="page"]{color:#F5B800!important;background:#010101!important;border-color:#010101!important}' : '');
  document.head.appendChild(css);
})();
