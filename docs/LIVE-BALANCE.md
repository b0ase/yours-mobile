# Live balance

Owner, 8 Oct 2026: "I want to see my balance ticking down as I pay for a service, or ticking up as I'm paid, in real
time, in the Chrome extension or in my wallet."

Code: `src/mobile/wallet/live/` (pure logic in `liveLogic.ts`, tested), wired into `WalletCard.tsx`.

## What the card does

- **Count up/down.** When the balance changes, dollars and sats count to the new value over 0.7 s with a short green
  (+) or red (−) flash. With `prefers-reduced-motion` the number changes at once with no flash.
- **Activity ticker.** Under the balance, the last three movements ("−27 sats · TokenBlaster", "+500 sats ·
  received"). Each one fades after 8 s. Tap one to open History.
- **Optimistic spends.** `background.ts` sends `bwxLiveSpend` to the wallet page as soon as `createAction` returns
  (dApps, internal sends, paid chat turns). The card takes the requested output sats off straight away, then
  fetches again 1.5 s later and settles on the real figure, fee included. A pending spend is dropped once a fresh
  balance includes it, or after 30 s at the latest.
- **Incoming.** There is no realtime payment feed today: push (bwalletx-push) only carries chat, and the 1Sat owner
  `/sync` SSE stream ends once it has caught up. So the card polls instead:
  - every **5 s** while visible, for 2 minutes after any activity, or while a session meter is live;
  - every **20 s** while visible otherwise (the same as before);
  - **never** while hidden.

  Each poll is the existing `refreshUtxos`: address sync, balance, MNEE, tokens. A poll is skipped while another is
  still running. Cost: about 24 extra indexer calls a minute, and only during the 2-minute fast window. When a balance
  rises without a known spend, the ticker shows "+N sats · received".

## Session meter: `bwallet:session-spend` v1

Some dApps take one payment and then spend it from their own key. TokenBlaster works this way: a gun pack is funded
by one wallet approval, and each shot is paid from the in-tab gun key. The wallet balance only drops once per pack.
The dApp can opt in and tell the wallet what it spends, so the wallet can show a live meter.

```js
window.postMessage(
  { type: 'bwallet:session-spend', v: 1, session: '<id ≤64 [A-Za-z0-9_.:-]>', sats: 27, left: 1240, label: 'gun' },
  window.location.origin, // extension: the content script hears same-window messages
);
// Framed inside the bWalletX app (bApp frame): also post to the parent.
if (window.parent !== window) window.parent.postMessage(msg, '*');
```

| Field     | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| `session` | The dApp's ID for the session, e.g. the gun address.                                    |
| `sats`    | Sats spent in this report, a whole number ≥ 0. Use 0 for a status-only report.          |
| `left`    | Sats left in the session after this spend. `0` ends the meter (e.g. after an unload).   |
| `label`   | Optional, ≤ 40 characters. Added after the app's own name ("TokenBlaster gun session"). |

Rules the wallet enforces (`applySessionSpend`, `parseSessionSpend`):

- **Origin-bound.** The origin always comes from the browser: the content script's sender, checked against the host
  it claims, or `MessageEvent.origin` on an allowlisted bApp frame. It is never read from the payload. Sessions are
  keyed by origin and session ID.
- **Only for sessions this wallet funded.** A report is ignored unless the wallet paid that origin within the last
  12 hours (from the Connections log). The meter can never show more than those payments.
- **Can only go down.** `left` can never rise above the previous value. A new wallet payment to the same origin
  (a top-up) raises the ceiling by exactly that payment.
- **Display only.** These messages never reach a wallet method. `background.ts` drops the action, and no funds can
  move.
- **Rate-limited** to 20 messages a second per origin, in the content script and again in the page. A meter with no
  report for 10 minutes disappears.

Not covered yet: sites opened in the mobile in-app dApp browser (native WebView). They would need the same hook in the
WebView bridge.

## TokenBlaster patch (suggested, not applied)

`src/lib/gun.ts`: report on every coin change. `save()` already runs after each shot, top-up and unload.

```ts
// near the top
const reportToWallet = (sats: number, left: number) => {
  if (typeof window === 'undefined') return;
  const msg = { type: 'bwallet:session-spend', v: 1, session: 'gun', sats, left, label: 'gun' };
  try {
    window.postMessage(msg, window.location.origin);
    if (window.parent !== window) window.parent.postMessage(msg, '*');
  } catch {
    /* the wallet just won't show a meter */
  }
};

// in class Gun
private lastReported: number | null = null;

private save() {
  write({ /* …unchanged… */ });
  const left = this.sats;
  const prev = this.lastReported;
  this.lastReported = left;
  if (prev !== null && left !== prev) reportToWallet(Math.max(0, prev - left), left);
}
```

On a top-up, `left` goes up after the wallet's funding payment. The wallet has already seen that payment, so the
ceiling rises with it. After `unload()`, `this.coin = null` → `left: 0` ends the meter, and the returned sats show up as
"+N sats · received" on the next poll.
