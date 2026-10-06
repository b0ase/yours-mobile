# bAgents — plan

Status: **plan, 6 Oct 2026** (owner: "bAgents at agents.bwalletx.com"). A bApp: the home for a person's AI agents,
opened inside bWalletX (iPhone, Android, web) and usable at its own address in any browser.

## Why a bApp, not a new app

- One build for every platform; ships daily without store review.
- The wallet keeps every key. bAgents asks; the wallet checks (budget, daily cap, Stop, 30 spends/hour) and signs.
- Agent trading stays out of the store edition (bWallet), which only lists bApps it is allowed to.
- Its own design space, instead of more screens under Settings › Agents.

## How it talks to the wallet

bApps already run in a cross-origin iframe and reach the wallet over BRC-100 XDM
(`src/mobile/bappFrame/frameBridge.ts`: `{ type: 'CWI', call, args }`, origins from the bApps list only).

Agent data is not BRC-100: flags, ghost colours, labels, caps, logs and Stop live in the wallet
(`src/mobile/agents/agentAccounts.ts`, per device). So add one namespace beside CWI:

```
page → wallet: { type: 'BWX', isInvocation: true, id, call: 'agents.list', args }
wallet → page: { type: 'BWX', isInvocation: false, id, status: 'success' | 'error', result | description }
```

- **First-party only.** BWX calls are answered for `https://agents.bwalletx.com` (and its preview host) and refused
  for every other origin, even ones on the bApps list. Same frame-identity check as CWI.
- **Reads** need no prompt. **Changes** follow the app's rules: Stop / Stop all / Resume are one tap (stopping is
  always safe); raising a cap, Fund and Sweep show the wallet's own confirmation sheet, never a bApp-drawn one.
- **Outside the wallet** (agents.bwalletx.com in a plain browser) BWX isn't there: bAgents shows a read-only demo
  with sample ghosts and "Open in bWalletX" / "Get bWalletX", the way /agents does today.

### BWX calls (v1)

| Call | Returns / does | Prompt |
| --- | --- | --- |
| `agents.list` | `[{ id, name, handle, ghostColor, labels, stopped, dailyCapUsd, balanceUsd, spentTodayUsd, isCurrent }]` + `allStopped` | none |
| `agents.log` `{ id, limit }` | activity entries (action, detail, usd, txid, rule, at) | none |
| `agents.stop` `{ id }` / `agents.resume` `{ id }` | sets Stop; logs it | none for stop, confirm for resume |
| `agents.stopAll` / `agents.resumeAll` | global kill switch | none / confirm |
| `agents.setCap` `{ id, usd }` | daily cap | confirm when raising or removing |
| `agents.setLabels` `{ id, labels }` | labels | none |
| `agents.open` `{ id, screen? }` | switches the wallet to that account (Fund / Sweep / Receive) | wallet's own UI |
| `agents.create` | opens the wallet's Add agent account flow | wallet's own UI |
| `events` (push) | `{ type: 'BWX', event: 'agents.changed' }` when anything changes (`onAgentsChange`) | — |

Balance per agent: the wallet reads it the way the account switcher does (its cached balance per account), in dollars.

## Screens (v1)

1. **Ghost house (home)**
   - Every agent as its ghost in its own colour, a name and labels.
   - Status pill (running / paused / stopped), balance and "today: $x of $cap".
   - The ghost bobs while running, and turns scared-blue when stopped (arcade nod).
   - Big **Stop all** at the top, red; it becomes **Resume all** when stopped.
   - "+ New agent" → the wallet's own Add agent account flow.
   - Empty state: one ghost, "Your first agent", a short explanation and the button.
2. **Agent**
   - Large ghost, name and labels (editable), and the address (copy).
   - Budget block: balance, spent today, daily cap (edit), Fund / Sweep back (hand off to the wallet).
   - Activity log: newest first, dollars first, links to WhatsOnChain; filter by action.
   - Stop / Resume.
   - "Make this my main view": switches the wallet to this account.
3. **Connect** (read-only in v1)
   - How to pair the CLI (`npx bwalletx login --account phone`).
   - The Claude / MCP snippet with a copy button.
   - Links to web.bwalletx.com/agents.

v2:
- **Strategies:** browse and buy from the Exchange, design one with the b agent or $b, and load it on paper → live (live always confirmed in the wallet).
- **Paired computers / AIs:** list and revoke.
- **P&L:** per agent, over time.
- **Ghost chat:** each agent's own room.

## Build

- **Repo:** `bitcoin-corp/bagents` (private), Vite + React + TypeScript + Tailwind.
  - The ghost comes from the same 14×14 bitmap as `src/mobile/agents/PixelGhost.tsx`, kept in step by a test.
- **Host:** Vercel project `bagents`, domain `agents.bwalletx.com`.
  - DNS: a CNAME `agents` → `cname.vercel-dns.com` at Fasthosts (owner, unless Fasthosts API access is set up).
  - Headers: framable only by the wallet origins (`frame-ancestors` capacitor://localhost, https://localhost, https://web.bwalletx.com and the extension), not by the world.
- **Wallet side** (bwalletX), all small:
  1. Add bAgents to `src/mobile/bapps.ts`, private channels only: not in `storeBuild` editions. Icon: the four ghosts.
  2. A BWX handler beside CWI in `BappFrameHost.tsx`: the origin check above plus the calls, implemented over `agentAccounts.ts`. Unit tests for the origin check and each call's validation.
  3. Settings › Agents gets an "Open bAgents" row. Settings › Agents stays as the fallback.
- **Tests:**
  - wallet: BWX origin refusal, cap validation, Stop always allowed, push events
  - bAgents: renders from a fake bridge, demo mode without one

## Order of work

1. Wallet: the BWX bridge + tests (no visible change yet).
2. bAgents v1: Ghost house + Agent + Connect against a fake bridge; deploy to `bagents.vercel.app`.
3. DNS `agents.bwalletx.com`; add the bApp tile (private channels); test in the web wallet, Android and iPhone.
4. Ship in the next wallet release; announce on X with the /agents share image.

Estimate: steps 1–3 about two days of work.

## Open questions

- Should bAgents be listed in the store edition at all (read-only, no trading)? Suggest no for v1.
- Per-device data: agent flags and logs live on each device today, so a phone and the web wallet can disagree.
  Syncing them (e.g. through the bwalletx server, encrypted to the wallet's key) is a later step; v1 shows
  what this device knows and says so.
