# Phone pairing: proving a site's origin

Security audit 19 Oct 2026, finding H1 (and C2/M4 on the seedless branches).

## The problem

A paired site talks to the phone through relay.bwallet.space. The relay tells the phone which origin opened the
channel, but it reads that from the WebSocket `Origin` header. Browsers set that header honestly; any other client
(Node, curl, a script) can set it to anything. The 4-digit code doesn't help: it comes from the attacker's own key,
so the attacker's screen shows the same code.

## What ships now

1. **Pinned relay.** Pairing links must name `relay.bwallet.space` (loopback only in dev builds). Links naming any
   other relay are refused, and stored pairings that point elsewhere are dropped on load and never reconnected.
2. **No inherited trust.** A paired session runs under its own permission key, `<host>.paired.invalid`
   (`.invalid` never resolves, so no real site can hold it). It does not get the site's saved grants, its monthly
   allowance or its "Don't ask again". Everything the paired page asks for gets a fresh approval sheet, and anything
   the user grants there belongs to the paired key only.
3. The relay's origin is still checked against the QR, but only to catch honest mistakes. It is a hint, not proof.

Side effect: level-2 keys (protocol keys bound to the originator) differ between the in-app browser and a paired
session for the same site. That is deliberate.

## The proper fix (not built yet)

Let a site prove it controls its origin before a paired session can share that origin's grants:

- **Well-known key.** The site publishes a pairing public key at `https://<origin>/.well-known/bwallet-pair.json`
  (fetched by the phone over TLS, so only the real origin can publish it). The site signs
  `bwallet-pair-v1|<channel>|<site ephemeral key k>|<expiry>` with that key and sends the signature in its first
  sealed frame. The phone fetches the key itself, verifies the signature, and only then maps the session to the
  real originator. A forger can't sign without the origin's key.
- **Or a server attestation.** bwalletx.com (or the relay operator) issues a short-lived signed statement binding
  `k` to an origin, issued only after an https callback to that origin; the phone checks the signature against a
  key pinned in the app.

Either way the binding covers the channel and the ephemeral key, so a proof can't be replayed onto another channel.
Until then, paired sessions stay on their own key.

## CLI pairing

`https://cli.bwalletx.com` has no web origin to prove. A CLI session is bound to an agent account with scopes the
user picks on the phone, and the pinned relay closes the attacker-relay case. Spoofing the CLI origin on the real
relay is still possible, so the CLI confirm screen must keep treating the request as untrusted (user picks scopes,
caps and expiry).
