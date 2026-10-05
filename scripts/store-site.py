#!/usr/bin/env python3
"""
bwallet.space = the App Store / Google Play app, plain **bWallet** (owner, 4 Oct 2026). Its home page
is generated from bwalletx.com's (the master) so the two never drift, then cleaned for the store app:
  - branded bWallet, with the plain flag-top b logo (no X);
  - Market is view-only (App Review rejected trading under 3.1.5(iii); bWalletX's market is an
    exchange), token rooms, personal tokens, X/Google sign-in, Shares and exchange tiles removed;
  - clear links to bWalletX (bwalletx.com) for everything the store app leaves out.
Run by scripts/sync-site.sh. Every replacement must match, so a change on bwalletx.com that breaks
one fails loudly instead of shipping a half-cleaned page.
"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()

def sub(old, new, count=1):
    global s
    if old not in s:
        sys.exit(f'store-site: expected text not found: {old[:70]!r}')
    s = s.replace(old, new, count if count else -1)

def resub(pat, new, flags=re.S):
    global s
    s2, n = re.subn(pat, new, s, flags=flags)
    if not n:
        sys.exit(f'store-site: pattern not found: {pat[:70]!r}')
    s = s2

X_LINK = '<a href="https://bwalletx.com" class="gold">bWalletX</a>'

# bWalletX calls it the Exchange (it trades); the store app's tab is Market (browse only).
for a, b in [('an exchange for tokens and NFTs, the bApps store', 'a market to browse tokens and NFTs, the bApps store'),
             ('<a href="#market">Exchange</a>', '<a href="#market">Market</a>'),
             ('Wallet, Exchange, Apps, Feed and Chat', 'Wallet, Market, Apps, Feed and Chat'),
             ('<p class="eyebrow">Exchange</p>', '<p class="eyebrow">Market</p>')]:
    sub(a, b)

# The home phone is a real screenshot now (5 Oct 2026); the old mock tab bar only if it comes back.
s = s.replace('<span>Exchange</span><span>Apps</span>', '<span>Market</span><span>Apps</span>')

# Market: browse only.
sub('then buy or\n              list from your wallet.', 'and view\n              them in your wallet.')
sub('<h2>Tokens and NFTs, filtered for safety.</h2>', '<h2>Browse tokens and NFTs, filtered for safety.</h2>')
sub('Mint, trade and chat in one non-custodial app.', 'Hold, send and mint in one non-custodial app.')

# Chat: no token rooms in the store app. Replace the section's copy with a pointer to bWalletX.
resub(r'(<section class="feature" id="chat">.*?<p class="eyebrow">)Chat(</p>\s*<h2>).*?(</h2>\s*<p class="lede">).*?(</p>)',
      r'\1The full edition\2Want rooms, trading and your own token?\3'
      'Token chat rooms, buying and selling in the Market, a personal $HANDLE token and sign-in with X or Google '
      'are in ' + X_LINK.replace('\\', '\\\\') + ', the full edition for Chrome, Android and the web. '
      '<a href="https://bwalletx.com/friends">How it works &rarr;</a>\\4')

# Identity: no share offers.
resub(r'\s*<article[^>]*>\s*(?:<[^>]+>\s*)*<h3>Shares</h3>.*?</article>', '')

# Apps grid: no exchange / market tiles.
resub(r'<a class="tile" href="https://bitcoin-exchange-iota\.vercel\.app".*?</a\s*>', '')
s = re.sub(r'1Sat Market,\s*', '', s)
s = s.replace('<span class="mini">1Sat Market</span>', '')
s = s.replace('<a href="#chat">Chat</a>', '<a href="#chat">bWalletX</a>')
NOOP = ('<span class="mini">1Sat Market</span>', '')

# Downloads: the store app comes from the stores; direct downloads are bWalletX.
s = re.sub(r'href="/download/bwalletx-android-[^"]*"\s*download', 'href="https://bwalletx.com/android"', s)
s = s.replace('href="/extension"', 'href="https://bwalletx.com/extension"')
# The store app isn't on iPhone yet: keep its waitlist button (bwalletx.com points iPhone users at its web app).
s = re.sub(r'href="/iphone"(\s*)><span>iPhone · Web app</span><small>[^<]*</small>',
           r'href="#waitlist"\1><span>iPhone</span><small>Coming soon — join the waitlist</small>', s)
s = s.replace('<h2>bWalletX on Android, iPhone and Chrome.</h2>', '<h2>bWalletX is coming to iPhone and Android.</h2>')

# Direct downloads are bWalletX: say so (the store app itself comes from the stores).
s = re.sub(r'<span>Android · Download APK \(beta\)</span><small>[^<]*</small>',
           '<span>bWallet&#88; for Android</span><small>Full edition · APK download</small>', s)
s = re.sub(r'<span>Chrome · Download extension</span><small>[^<]*</small>',
           '<span>bWallet&#88; for Chrome</span><small>Full edition · extension</small>', s)

# Branding: bWalletX → bWallet (but keep links that name bWalletX on purpose).
s = s.replace('bWallet<span class="gold">X</span>', 'bWallet')
s = re.sub(r'bWalletX(?![^<]*</a>)', 'bWallet', s)

# Page links in the top bar: the shared /nav.js (copied from bwalletx.com) renders them from one config;
# data-edition="store" picks the bWallet set (Market, browse-only, plus links to bWalletX). The links
# inside the nav are only the no-JS / crawler fallback.
STORE_NAV = ('<nav aria-label="Pages"><a href="/market">Market</a><a href="https://bwalletx.com/features">bWalletX features</a>'
             '<a href="https://bwalletx.com/friends">Rooms &amp; tokens</a><a href="https://bwalletx.com">Get bWalletX &rarr;</a></nav>')
resub(r'<nav aria-label="Pages">.*?</nav>', STORE_NAV)
sub('<script src="/nav.js"></script>', '<script src="/nav.js" data-edition="store"></script>')
s = s.replace('href="https://web.bwalletx.com" target="_blank" rel="noopener">Web &rarr;</a>',
              'href="https://bwalletx.com">bWalletX &rarr;</a>')

# Share preview + canonical address: this site's own (plain b) image and URL.
s = s.replace('https://bwalletx.com/og-home.png', 'https://www.bwallet.space/og-home.png')
s = s.replace('<meta property="og:url" content="https://bwalletx.com/" />', '<meta property="og:url" content="https://www.bwallet.space/" />')
s = s.replace('a gold b with an X', 'a gold b')
s = s.replace('<link rel="canonical" href="https://bwalletx.com/" />', '<link rel="canonical" href="https://www.bwallet.space/" />')

# The store app's colours are flipped (owner, 4 Oct 2026): black on yellow navbar.
s = s.replace('</head>', '''    <style>
      .topbar { background: #F5B800 !important; backdrop-filter: none; }
      .topbar .brand span, .topbar nav a { color: #010101 !important; }
      .topbar nav a:hover, .topbar nav a[aria-current='page'] { color: #000 !important; text-decoration: underline; }
      .topbar .dl-btn { background: #010101 !important; color: #F5B800 !important; box-shadow: none !important; }
      .topbar .nav-cta .web-btn { color: #010101 !important; border-color: #010101 !important; }
      .section-nav { background: #F5B800; }
      .section-nav a { background: rgba(0,0,0,0.08) !important; color: #010101 !important; border-color: rgba(0,0,0,0.15) !important; }
    </style>
  </head>''', 1)

open(dst, 'w', encoding='utf-8').write(s)
print(f'store-site: wrote {dst}')
