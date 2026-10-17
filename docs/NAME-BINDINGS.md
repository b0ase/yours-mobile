# Signed name bindings and the public name log

Owner, 17 Oct 2026: "be as public as possible about this". A bWalletX name (`alice@bwalletx.com`, `$alice`) is a
row in our database. Whoever controls that database can point the name at another key and catch that name's
_future_ incoming payments. We never hold keys or coins, and payments go wallet to wallet, but the name directory
is a power we hold. This document is how we limit it and make every use of it visible.

## The three layers

1. **Signed bindings (shipped).** The wallet that owns a name signs "this name → my identity key, version N". The
   paymail server serves that signature with the name's key. Every bWalletX wallet checks it before paying. We
   cannot make a valid binding for a key we don't hold, so a name quietly repointed in our database shows as
   _not signed_ (and a binding that doesn't match shows as _bad_ and blocks the payment).
2. **Public, append-only name log (shipped).** Every change of who a name points to is a log entry, hash-chained
   to the one before. A database trigger writes the entry, so even a direct database edit by us is logged, as
   actor `admin`. Entries cannot be edited or deleted. Anyone can read it: `GET /api/paymail/name-log[?alias=]`.
3. **On chain (next).** A daily anchor of the log's latest hash in a BSV transaction, so the log can't be
   rewritten after the fact; and OpNS names (on-chain, held by the user) for names that must never depend on us.

Limits we state plainly: layers 1 and 2 still rely on us to _serve_ the binding and the log. We could withhold a
binding (the name then shows "not signed") or serve an older genuine one (the version number and the log make
that visible). Only layer 3 removes us from the picture.

## Binding format

The owner's wallet signs with its identity key using BRC-43 protocol `[2, "bwallet paymail"]`, key ID `"1"`,
counterparty `anyone` (the same scheme as every signed bWalletX paymail write). The message is:

```
bwallet-paymail|v1|bind|alias=<alias>|identityKey=<key>|seq=<n>|timestamp=<ms>
```

(fields in sorted order). `seq` must go up with each new binding for a name.

The pki answer (`GET /api/paymail/id/<alias>@<domain>`) adds:

```json
{
  "bsvalias": "1.0",
  "handle": "alice@bwalletx.com",
  "pubkey": "02…",
  "binding": {
    "alias": "alice",
    "identityKey": "02…",
    "seq": 1,
    "timestamp": "1792200000000",
    "signature": "3044…",
    "scheme": "bwallet-paymail/v1 bind; BRC-43 protocol [2,\"bwallet paymail\"] keyID \"1\", counterparty anyone"
  }
}
```

A binding is only served if it was signed by the key now served. To verify: rebuild the message with the served
`pubkey`, then verify the signature with `ProtoWallet('anyone').verifySignature({ protocolID, keyID,
counterparty: pubkey })` (`src/mobile/names/binding.ts`).

## Wallet behaviour

- On sync, the wallet signs a binding for each of its names that isn't signed by it yet (`bindMyNames`, silent:
  it only ever signs "my name → my key").
- Paying a bWalletX name: **signed** shows "Signed by its owner"; **not signed yet** shows a grey note and still
  pays (names are being signed as wallets open); **bad** blocks the payment.

## Log

Table `bwallet_name_log` (`migrations/20261017_name_bindings.sql`): `alias, identity_key, prev_identity_key,
action (bind | claim | move | release), actor (owner | server | admin), seq, signature, note, prev_hash,
entry_hash, created_at`. `entry_hash = sha256(prev_hash | alias | identity_key | prev_identity_key | action |
actor | seq | signature | note | created_at)`. `actor`: `owner` = a binding the owner signed; `server` = a change
the paymail server made for an owner-signed request; `admin` = anything else, i.e. a direct database edit by us.

The first entries are three admin changes made on 17 Oct 2026 at the owner's request (two names moved between
the owner's own wallets, one name assigned).

## Handovers, and no operator recovery (owner decision, 17 Oct 2026)

A name moves to another key only with two signatures:

1. **Release**, signed by the current owner: `bwallet-paymail|v1|release|alias=…|identityKey=<from>|seq=<n>|timestamp=…|to=<to key>`
   (`POST /api/paymail/handover-release`). Nothing moves yet; the owner can cancel (`handover-cancel`).
2. **Accept**, signed by the new owner: an ordinary `bind` for the same `seq` (`POST /api/paymail/handover-accept`).
   Only then does the name move. The binding is served with the release (`binding.handover = { from, releaseSignature,
releaseTimestamp }`), so any wallet checks both signatures.

Once a key has signed a name, the server refuses a plain `bind` by any other key: a name moved any other way stays
unsigned for its new key.

**No operator recovery.** If an owner loses their key, the name stays bound to it. There is no host-side or
time-delayed recovery path: any such path is a back door that makes every binding negotiable. Recovery is the user's,
set up in advance (bTrust recovery slices), so it recovers the key and the name with it. Payments to a lost-key name
go to a key nobody can spend, like a lost address.

**Key-change warning (BRC-169 §4.4).** The wallet remembers each name's key. If it changes without a valid handover
from the key it knew, Send stops ("This name now points to a different wallet than before…"); the payer can override
only after checking with the person ("I've checked with them: trust the new wallet").

Limit stated plainly: a dishonest host can still ignore its own rules. The public log and the payers' remembered keys
make that visible; on-chain anchoring and OpNS remove it.
