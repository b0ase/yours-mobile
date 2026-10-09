# Wide web layout: feature parity

The wide layout (`?wide=1`, or a `VITE_WIDE_WEB=1` build, at 1100px or wider) runs the same app: same providers,
router, services and screens. Only the phone chrome changes: the TopNav bar, account strip, tab bar and phone dock are
off, and the sidebar + top bar replace them. TopNav stays mounted (hidden) so its drawer, sheets and background jobs
(pairing, space invite links, CLI wallet context) keep working; the shell opens them with `wwOpen()` (flag.ts).

Anything not listed as its own entry is inside a real screen that is listed (e.g. Buy BSV on the Wallet page).

| Mobile entry point                                     | Where in the wide layout                                                      | Status                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| ☰ drawer: current account, $name, recent accounts     | Sidebar account button → the real drawer                                      | Real                                                |
| ☰ All accounts / Add / Import account                 | Account button → drawer → All accounts                                        | Real                                                |
| ☰ Agents (agent accounts, b agent, agent tools)       | Account button → drawer → Agents                                              | Real                                                |
| ☰ Settings                                            | Sidebar › Settings (and drawer)                                               | Real                                                |
| ☰ Scan to connect a website / Connect the CLI         | Sidebar › Connect a site / CLI (agent tools sheet), top bar scan              | Real                                                |
| ☰ Sign out                                            | Account button → drawer → Sign out                                            | Real                                                |
| ☰ Lock wallet                                         | Sidebar › Lock wallet, top bar lock, ⌘L                                       | Real                                                |
| Top bar Calls (bPhone)                                 | Sidebar › Talk › Calls (`/m/calls`)                                           | Real                                                |
| Top bar Airdrops inbox                                 | bMail › Requests (airdrops list), Wallet page Airdrops row                    | Real                                                |
| Top bar Media (play)                                   | Sidebar › Discover › Media                                                    | Real                                                |
| Top bar Lock BSV (time-locks)                          | Sidebar › Money › Lock BSV                                                    | Real                                                |
| Top bar Settings                                       | Sidebar › Settings                                                            | Real                                                |
| Phone layout top bar mailbox / bMail                   | Sidebar › Talk › bMail (unread badge)                                         | Real, two-pane                                      |
| Tab: Wallet                                            | Sidebar › Money › Wallet (real page + holdings table + History pane)          | Real                                                |
| Tab: Exchange / Market                                 | Sidebar › Money › Exchange (Market in store builds)                           | Real                                                |
| Tab: Apps (bApps)                                      | Sidebar › Discover › bApps (`/browser`)                                       | Real                                                |
| Tab: Feed                                              | Sidebar › Discover › Feed                                                     | Real                                                |
| Tab: Chat (Rooms / DMs / Calls segments)               | Sidebar › Talk › Chat; open room beside the list                              | Real, two-pane                                      |
| Dock b / b agent (tap, hold to talk)                   | Sidebar › Discover › b agent, top bar search, ⌘K (voice is on the agent page) | Real (no hold gesture)                              |
| Phone layout HOME / People / Games screens             | Sidebar › Talk › People, Discover › Games                                     | Real                                                |
| Wallet Tokens / NFTs / Friends / Tickets / Credits     | Sidebar › Money (each sets the wallet view)                                   | Real                                                |
| Send / Receive / Mint / Buy BSV                        | Wallet page buttons                                                           | Real                                                |
| History (statement, CSV, connections, gains)           | Wallet view, right pane                                                       | Real                                                |
| $name (Get your $name, handle flow)                    | Wallet page card, drawer                                                      | Real                                                |
| Backup prompt / backup & security                      | Wallet page banner, Settings                                                  | Real                                                |
| Pots & subscriptions, agent accounts                   | Drawer → Agents; Settings                                                     | Real                                                |
| Spaces (bSpaces)                                       | Sidebar › Talk › Spaces (bWalletX builds only)                                | Real                                                |
| Notifications list                                     | Top bar bell                                                                  | Real                                                |
| Notification settings, permissions, connected apps     | Settings                                                                      | Real                                                |
| Display currency USD / GBP                             | Top bar toggle (same setting as Settings)                                     | Real                                                |
| Tools (locks, sweep / migration, decoder, sponsor)     | Sidebar › Tools                                                               | Real                                                |
| Scan sheet (pay codes, people, pairing)                | Top bar scan button                                                           | Real (camera may be absent on desktop; paste works) |
| Onboarding: create / restore / import / master restore | Centred column, no chrome                                                     | Real                                                |
| Lock / unlock, forgot password                         | Centred column                                                                | Real                                                |
| Incoming / active calls, mini player, push             | App-wide, unchanged                                                           | Real                                                |
| Chat room details pane (third column)                  | Room header info / settings sheets                                            | TODO: no dedicated third column                     |
| Wallet token prices / chart                            | Holdings table shows BSV and MNEE value; other tokens "—"                     | TODO: no per-token price feed                       |
| Bottom sheets                                          | Centred 640px column over the window                                          | Works; not a native desktop dialog yet              |

Next pass: sheets that should open as full pages (header + back) in the main area instead of floating cards: Agent tools / Connect the CLI or an AI assistant (MCP), Pair sheet, Scan sheet, Receive, Send / asset picker, Switch account and Agents sheets, Handle flow, Backup sheet, Settings sub-sheets, Chat room settings / invite / bans / bounties sheets, bMail compose on narrow panes.
