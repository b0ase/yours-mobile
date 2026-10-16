# Subscribe with bWalletX (API for apps)

An app opened inside bWalletX can ask the user for a monthly subscription. The user sees **one** approval sheet, picks
the pot that pays, and taps Subscribe. After that the wallet charges once a month by itself. The app never gets a key,
a balance or a pot.

- **Priced in dollars.** Each month the wallet pays `usdPerMonth` in BSV at that day's rate (the wallet's price feed).
- **Nothing locked or paid ahead.** The first month is paid right after approval. Later months are paid when they fall
  due, while the wallet is open.
- **Missed months never stack.** If the wallet wasn't opened on the due date, it pays **one** month the next time it
  opens and skips the older ones. It never charges two or more months at once.
- **Limits apply.** Payments come only from the chosen pot, through its Stop switch, the global Stop all and its daily
  cap. If the pot is empty or the cap is hit, the charge fails and the status shows `lastError`.
- **The user is in charge.** Every subscription is listed in Pots & Locks › Subscriptions with Pause and Cancel.

Available in bWalletX (web, extension, direct APK). The App Store / Play edition (bWallet) doesn't answer these calls.

## Where it works

Apps on the bApps list that bWalletX opens in its app frame. The page talks to the wallet with `postMessage` to its
parent window, next to the BRC-100 `CWI` messages it already uses.

## Messages

Request (page → wallet):

```json
{ "type": "BWX_SUBSCRIBE", "isInvocation": true, "id": "req-1", "call": "subscribe", "args": { ... } }
```

Reply (wallet → page):

```json
{ "type": "BWX_SUBSCRIBE", "isInvocation": false, "id": "req-1", "status": "success", "result": { ... } }
{ "type": "BWX_SUBSCRIBE", "isInvocation": false, "id": "req-1", "status": "error", "description": "Declined" }
```

`id` is any string (up to 128 chars) or number; the reply carries the same one.

### `subscribe`

| arg            | type   | rule                                                               |
| -------------- | ------ | ------------------------------------------------------------------ |
| `merchantName` | string | shown on the sheet, up to 40 chars                                 |
| `payTo`        | string | a paymail (`pay@example.com`) or a BSV address                     |
| `usdPerMonth`  | number | dollars a month, $0.01 to $100, rounded to cents                   |
| `description`  | string | optional, up to 140 chars, shown under Details                     |
| `appOrigin`    | string | must equal the origin of the page sending the message, or it fails |

The paymail must resolve to an address (P2P-only paymails are not supported yet). The result is a **status**
(below). Errors: `Declined` (the user said Not now), or a message naming the bad argument.

### `status` · `cancel`

`args: { "id": "<subscription id>" }`. An app can only see or cancel subscriptions it created. Any other id answers
`Unknown subscription`. `cancel` returns the status afterwards (`cancelled`).

### `list`

`args: {}`. Every subscription this origin created, as statuses.

### Status

```json
{
  "id": "3f0c…",
  "status": "active",
  "merchantName": "Example Pro",
  "usdPerMonth": 5,
  "nextCharge": "2026-11-16T12:00:00.000Z",
  "lastPayment": { "at": "2026-10-16T12:00:04.000Z", "txid": "ab12…", "usd": 5, "sats": 10000000 },
  "lastError": null
}
```

`status` is one of `active`, `lowFunds`, `paused`, `cancelled`, `ended`. `nextCharge` is `null` once it can't charge
again. Check a payment yourself from `lastPayment.txid` and your `payTo` address.

## Example

```js
const ask = (call, args) =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const on = (e) => {
      const d = e.data;
      if (e.source !== window.parent || d?.type !== 'BWX_SUBSCRIBE' || d.isInvocation || d.id !== id) return;
      window.removeEventListener('message', on);
      d.status === 'success' ? resolve(d.result) : reject(new Error(d.description));
    };
    window.addEventListener('message', on);
    window.parent.postMessage({ type: 'BWX_SUBSCRIBE', isInvocation: true, id, call, args }, '*');
  });

const sub = await ask('subscribe', {
  merchantName: 'Example Pro',
  payTo: 'pay@example.com',
  usdPerMonth: 5,
  description: 'Pro plan: no ads, HD',
  appOrigin: location.origin,
});
localStorage.setItem('bwxSub', sub.id);

// Later
const s = await ask('status', { id: localStorage.getItem('bwxSub') });
if (s.status !== 'active') showUpgrade();

// Let the user stop it from your app too
await ask('cancel', { id: s.id });
```

## Not covered yet

- Pages in the in-app browser (outside the frame) and other wallets. Only framed bApps can call this today.
- Signed merchant requests and presigned payments (`docs/POTS-SUBSCRIPTIONS-PLAN.md` §4). This API pays on open only.
