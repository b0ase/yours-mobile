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

# Direct downloads are bWalletX: say so (the store app itself comes from the stores).
s = re.sub(r'<span>Android · Download APK \(beta\)</span><small>[^<]*</small>',
           '<span>bWallet&#88; for Android</span><small>Full edition · APK download</small>', s)
s = re.sub(r'<span>Chrome · Download extension</span><small>[^<]*</small>',
           '<span>bWallet&#88; for Chrome</span><small>Full edition · extension</small>', s)

# Branding: bWalletX → bWallet (but keep links that name bWalletX on purpose).
s = s.replace('bWallet<span class="gold">X</span>', 'bWallet')
s = re.sub(r'bWalletX(?![^<]*</a>)', 'bWallet', s)

# Page links in the top bar point to bwalletx.com, plus a clear bWalletX button.
resub(r'<nav aria-label="Pages">.*?</nav>',
      '<nav aria-label="Pages"><a href="https://bwalletx.com/features">bWalletX features</a>'
      '<a href="https://bwalletx.com/friends">Rooms &amp; tokens</a><a href="https://bwalletx.com">Get bWalletX &rarr;</a></nav>')
s = s.replace('href="https://web.bwalletx.com" target="_blank" rel="noopener">Web &rarr;</a>',
              'href="https://bwalletx.com">bWalletX &rarr;</a>')

open(dst, 'w', encoding='utf-8').write(s)
print(f'store-site: wrote {dst}')
