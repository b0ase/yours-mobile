# BRC-XXXX: Owner-signed name bindings and a public change log for paymail (bsvalias)

- Richard Boase (The Bitcoin Corporation Ltd, bWalletX)

**Status: draft, 17 Oct 2026. Not submitted.** No number chosen (see [Process](#process)).

## Abstract

A paymail handle (`alias@domain`) resolves to a public key chosen by whoever runs the paymail service. That service
can repoint a handle to a different key at any time, and senders cannot tell. This document hardens legacy paymail
(bsvalias) with two additions that make that power visible without changing how paymail resolves:

1. An **owner-signed name binding**: a statement signed by the key a handle points to, "this alias points to me,
   version N", served inside the existing bsvalias `pki` response, and checked by sending wallets before they pay.
2. A **public change log**: an append-only, hash-chained record of every change to which key a handle points to,
   readable by anyone, including changes made directly to the database by the service operator.

Neither removes trust in the paymail service. Both make its misuse detectable.

Signed handle bindings, revocation and key-change detection are not new. [BRC-169](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0169.md)
already defines a handle-to-identity-key binding as a [BRC-52](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0052.md) certificate, and
[BRC-174](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0174.md) defines on-chain names bound to identity keys. Those are the successors to this
document. The difference here is narrow: **BRC-169/BRC-52 bindings are attested by the host; this binding is
attested by the owner**, and it is delivered as a drop-in field on the plain bsvalias `pki` response that existing
paymail services already serve.

## Motivation

Paymail services are usually non-custodial for funds: payments go from the sender's wallet to an output the
recipient's wallet controls. The name directory is the exception. If the operator (or an attacker with database
access) changes the key behind `alice@example.com`, every later payment to that handle goes to the new key. Past
payments are unaffected; future ones are lost. Nothing in the bsvalias `pki` capability (BRFC `0c4339ef99c2`) lets a sender notice.
The TSC paymail standard describes this attack itself, as "Alias Reassignment (server & database access)", and
lists planned extensions (Paymail Alias Index, Mutual Party Authentication) for which no BRFC has been published.

This was made concrete for the author's own service on 17 Oct 2026, when two handles were moved between the
owner's own two wallets, at his request, by a direct database edit. No funds were at risk, but the edit was
invisible to everyone else. This document is the generic form of the fix deployed afterwards.

Goals:

- A sender's wallet can tell whether the key it is about to pay was put on that handle by the key's holder.
- Any change of key, by anyone, leaves a public, tamper-evident record.
- No change to existing paymail resolution; services and wallets that ignore these fields keep working.

Non-goals: removing the operator from the trust path entirely. That needs an on-chain name system such as BRC-174
(see [Relation to on-chain names](#relation-to-on-chain-names)).

## Specification

The key words MUST, SHOULD and MAY are used as in RFC 2119.

### Binding message

A binding is a signature over this UTF-8 string:

```
<scheme>|v1|bind|alias=<alias>|identityKey=<key>|seq=<n>|timestamp=<ms>
```

- `<scheme>` is a service-chosen ASCII label with no `|` (the reference implementation uses `bwallet-paymail`).
  It MUST be stable for the service and is published in the binding's `scheme` field.
- Fields appear in this order (lexicographic by field name): `alias`, `identityKey`, `seq`, `timestamp`.
- `alias`: the local part of the handle, lower-cased.
- `identityKey`: the compressed secp256k1 public key the handle points to, 66 lower-case hex characters.
- `seq`: a positive integer, in decimal with no leading zeros. It MUST be greater than the `seq` of any earlier
  binding the same key made for the same alias.
- `timestamp`: milliseconds since the Unix epoch, in decimal, when the binding was signed.

Example:

```
bwallet-paymail|v1|bind|alias=npg|identityKey=026607f69e27c84eb19bfbc430575c46abec2a587712eac91b3b3f58e7f262b59b|seq=1|timestamp=1792214400000
```

This section documents version 1 exactly as deployed. A possible version 2 is described separately under
[Future direction (v2)](#future-direction-v2); it does not change v1.

### Signing

The holder of `identityKey` signs the message with a BRC-3 / BRC-100 `createSignature` call using BRC-42 / BRC-43
key derivation:

- `protocolID`: `[2, "<protocol name>"]`, a service-chosen BRC-43 protocol name published in `scheme` (reference: `[2, "bwallet paymail"]`)
- `keyID`: `"1"`
- `counterparty`: `"anyone"`

The signature is DER, hex-encoded. Because the counterparty is `anyone`, any party can verify it knowing only
`identityKey`.

### Publishing the binding

The service submits the signed binding (for example via an authenticated endpoint). The service MUST reject a
binding unless:

1. the signature verifies (see below);
2. the handle currently points to `identityKey`;
3. `seq` is greater than the `seq` of the binding it currently holds for that alias and key.

The service SHOULD also reject a `timestamp` far from its own clock (the reference allows a few minutes).

### PKI extension field

The bsvalias `pki` response (BRFC `0c4339ef99c2`) gains an optional `binding` object:

```json
{
  "bsvalias": "1.0",
  "handle": "alice@example.com",
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

A service MUST only include `binding` when its `identityKey` equals the `pubkey` being served. A service MUST NOT
serve a binding made by a previous key.

### Verification

Before paying a handle, a wallet that supports this specification:

1. Fetches the PKI response.
2. If there is no `binding`: status **unsigned**. The wallet SHOULD tell the user ("not signed by its owner yet")
   and MAY still pay.
3. Otherwise, status **bad** if any of these hold:
   - `binding.alias` (lower-cased) differs from the handle's alias;
   - `binding.identityKey` is present and differs from `pubkey`;
   - `seq` is not a positive integer, or `signature` or `timestamp` is missing;
   - the signature does not verify for the message rebuilt from the handle's alias, the served `pubkey`, `seq`
     and `timestamp`, using `protocolID`, `keyID` and `counterparty = pubkey` as above.
4. Otherwise status **signed**.

A wallet MUST NOT pay a handle whose status is **bad**. A wallet SHOULD rebuild the message from the served
`pubkey` rather than trusting `binding.identityKey`.

Reference verification with `@bsv/sdk`:

```ts
const msg = `bwallet-paymail|v1|bind|alias=${alias}|identityKey=${pubkey}|seq=${b.seq}|timestamp=${b.timestamp}`;
const { valid } = await new ProtoWallet('anyone').verifySignature({
  data: Utils.toArray(msg, 'utf8'),
  signature: Utils.toArray(b.signature, 'hex'),
  protocolID: [2, 'bwallet paymail'],
  keyID: '1',
  counterparty: pubkey,
});
```

### Sequence and rollback

- `seq` is per (alias, key). Each new binding by the same key for the same alias MUST raise it.
- A verifier that has seen a binding for (alias, key) with sequence `s` SHOULD treat a later-served binding for the
  same pair with a lower `seq` as a rollback and warn.
- The public log (below) records every accepted binding with its `seq`, so a served binding can be checked against
  the newest logged one.

### Wallet behaviour

A wallet SHOULD, when it syncs, sign a binding for each handle that points to its key and is not yet bound by it.
This is safe to do without user interaction because it can only ever assert "my handle → my key".

(Not yet in the reference implementation.) A wallet SHOULD also apply the key-change rule of BRC-169 §4.4 to paymail handles: on each fresh resolution, compare
the served `pubkey` with the one stored for that handle; if they differ, do not silently update the stored entry,
mark the contact as changed, and warn the user before any value-moving action, distinguishing a key change on an
existing contact from a first-time resolution. A binding does not replace this check. A new key can carry a valid
binding of its own if the handle really moved, so the binding says _who_ bound the key, and the key-change rule says
_that it changed_.

## Public name log

### Entries

The service keeps an append-only log. Each entry has:

| field               | meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `id`                | increasing integer                                         |
| `alias`             | the handle's alias                                         |
| `identity_key`      | the key the handle now points to (empty on release)        |
| `prev_identity_key` | the key it pointed to before (empty on claim)              |
| `action`            | `claim`, `move`, `bind` or `release`                       |
| `actor`             | `owner`, `server` or `admin`                               |
| `seq`               | the binding's `seq` (for `bind`)                           |
| `signature`         | the binding's signature (for `bind`)                       |
| `note`              | free text (for `admin` entries, why)                       |
| `prev_hash`         | `entry_hash` of the previous entry; 64 zeros for the first |
| `entry_hash`        | see below                                                  |
| `created_at`        | UTC time                                                   |

`actor` meanings: `owner` = a binding the handle's key signed; `server` = a change the service made in response to
a request signed by the affected key; `admin` = anything else, including direct database edits by the operator.

### Hash chain

```
entry_hash = hex(sha256(utf8(join('|',
  prev_hash, alias, identity_key, prev_identity_key, action, actor, seq, signature, note, created_at))))
```

Missing values are empty strings. `created_at` is formatted `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microseconds).

### Requirements

- Entries MUST NOT be updated or deleted.
- Every change to which key a handle points to MUST produce an entry, **however the change is made**. The
  reference implementation uses a database trigger on the directory table, so a hand-edited row is logged as
  `admin` like any other change.
- The log MUST be readable without authentication, whole and filtered by alias, newest first. Reference:
  `GET /api/paymail/name-log[?alias=<alias>][&limit=<n>]` returning `{ "log": [entry, …] }`.

### What the hash chain does and does not prove

A linear hash chain is tamper-evident only to someone who kept an earlier copy, or an earlier head hash. A service
that rewrites the whole chain from some point onward produces a new, internally consistent chain. Until the head is
anchored somewhere the service cannot rewrite, a reader with no earlier copy cannot tell.

### Anchoring (recommended, not yet deployed)

The service SHOULD periodically (for example daily) publish the latest `entry_hash` in a Bitcoin transaction and
list the anchor transactions. Once anchored, rewriting any entry before the anchor is detectable by anyone, not
only by someone who kept a copy. A [BRC-48](https://github.com/bsv-blockchain/BRCs/blob/master/scripts/0048.md) PushDrop output is one suitable carrier. The key
that signs anchors SHOULD be published in advance, for example in a [BRC-68](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0068.md) trust
anchor document at the service's domain.

A linear chain makes a reader fetch the whole log to check one entry. Signed tree heads as used in Certificate
Transparency, or CONIKS-style per-user proofs, would allow proofs of inclusion and of consistency between two
heads. They are a possible future; this version does not specify them.

## Security considerations

- **Withholding.** The service can stop serving a binding. The handle then shows unsigned. This is visible but
  not prevented. Wallets that previously saw the handle as signed SHOULD warn if it becomes unsigned while the key
  is unchanged.
- **Rollback.** The service can serve an older genuine binding. Its `seq` will be lower than the newest one in the
  log, and lower than any a wallet has cached.
- **Repointing.** The service cannot produce a valid binding for a key it does not hold. A repointed handle shows
  unsigned (no binding for the new key) or bad (a mismatched one), and the change appears in the log.
- **Server compromise.** An attacker with database access has the operator's powers and no more: they can repoint
  and withhold, but the trigger logs the change, and they cannot forge bindings. An attacker who can also disable
  the trigger and rewrite the log is caught only by anchoring or by someone holding an earlier copy of the log.
- **Operator holding the key.** If the service also generates or holds users' keys, bindings prove nothing. This
  scheme is meaningful only for services where keys are made and held by the user's wallet.
- **Moving a handle / key rotation.** The current key's holder releases the handle (logged as `release`); the
  service assigns it to the new key (logged as `claim` or `move`); the new key signs a fresh binding (logged as
  `bind`). `seq` is per (alias, key), so the new key starts at 1; verifiers MUST NOT compare `seq` across keys.
  A move without a signed release is still possible for the operator, but it appears in the log as `admin`.
- **Clock.** `timestamp` is informational and for freshness at submission; it is not a validity period.
- **Privacy.** The log publishes which keys each handle has pointed to over time. Services should say so.

## Relation to on-chain names and BRC-169

Bindings and the log limit an operator; they do not remove one. Names recorded on chain and held by the user do not depend on any operator.
[BRC-174](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0174.md) (Consensus-Unique Name Tokens) is the formal specification for such names, with an
identity binding by derivation through PushDrop. BRC-174 notes that the deployed OpNS `opns.idKey` field binds "by
declaration" only; its derived binding closes that gap. BRC-174 is the stated end state for bWalletX names.
This specification is for the many paymail handles in use today, so that they can be checked while on-chain
names spread. A service MAY serve both, and a wallet MAY show an on-chain name in preference to a paymail.

[BRC-169](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0169.md) gives domain-hosted handles a host-issued BRC-52 certificate with a revocation
outpoint, owner-signed forwarding records (§4.3) and key-change detection (§4.4). It states plainly that nothing
in it prevents a malicious or compromised host from impersonating its own users. This document does not remove
that either; it adds an owner signature and a log of operator edits, for services that still speak only bsvalias.
A service that adopts BRC-169 MAY keep serving bindings and the log alongside its certificates.

## Future direction (v2)

**Not implemented. Proposed for discussion only.** Version 1 above is what is deployed and is unchanged.

A v2 could align with BRC-169's signing conventions so that one verifier serves both:

- Sign the SHA-256 of an RFC 8785 (JSON Canonicalization Scheme) encoding of the binding object, as BRC-169 §7.2
  does for envelopes, instead of a `|`-joined string.
- Use a neutral BRC-43 protocol ID shared by all services (in the style of BRC-169's
  `[2, "metanet handles envelope"]`), rather than a service-specific one such as `[2, "bwallet paymail"]`.
- Offer an optional **self-certified** BRC-52 form, in which certifier and subject are the same identity key, with
  fields `handle` and `domain`. It could be published and found through the [BRC-189](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0189.md) identity
  overlay (`discoverByIdentityKey`), so a binding can be found from the key as well as from the handle.
- Keep `seq` with a client-side rollback floor as in [BRC-211](https://github.com/bsv-blockchain/BRCs/blob/master/overlays/0211.md), which orders signed manifests
  by an issuer-assigned sequence number and refuses any below the highest one a client has accepted.

Whether v2 should be a separate document or an amendment to BRC-169 is the question raised under
[Process](#process).

## Backwards compatibility

The `binding` field is optional and additive. Wallets that ignore it behave as before. Services that do not serve
it make every handle show "unsigned" in wallets that support this specification.

## Related work

Within BSV:

- [BRC-169](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0169.md): universal handles; host-issued BRC-52 handle certificate with
  `revocationOutpoint`; subject-signed forwarding records (§4.3); key-change detection (§4.4).
- [BRC-174](https://github.com/bsv-blockchain/BRCs/blob/master/tokens/0174.md): consensus-unique name tokens with identity binding by derivation. The target for
  names that must not depend on an operator.
- [BRC-52](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0052.md): identity certificates.
- [BRC-189](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0189.md): identity, certificates and discovery, including `discoverByIdentityKey`.
- [BRC-211](https://github.com/bsv-blockchain/BRCs/blob/master/overlays/0211.md): signed reachability manifest with `seq` and a rollback floor. The closest
  precedent for the `seq` rule here.
- [BRC-85](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0085.md): Proven Identity Key Exchange (PIKE), BRFC `8c4ed5ef8ace`.
- [BRC-28](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0028.md) and [BRC-70](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0070.md): paymail payment destinations and BEEF receive.
  The binding is checked before these are used.
- [BRC-182](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0182.md): pairwise authentication.
- [BRC-68](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0068.md): trust anchor details at a domain; a place to publish a log or anchoring key.
- [BRC-48](https://github.com/bsv-blockchain/BRCs/blob/master/scripts/0048.md): PushDrop; a carrier for anchors.
- TSC paymail standard, <https://tsc.bsvblockchain.org/standards/paymail/>: the bsvalias `pki` capability
  (BRFC `0c4339ef99c2`) and the "Attack: Alias Reassignment (server & database access)" section.

Outside BSV:

- Certificate Transparency, [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962) and
  [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162): public append-only logs with signed tree heads.
- [CONIKS](https://eprint.iacr.org/2014/1004): key transparency for end users, with per-user proofs.
- [IETF KEYTRANS](https://datatracker.ietf.org/wg/keytrans/about/): the working group standardising key transparency.
- [WhatsApp key transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/): a deployed
  public directory of user keys.
- [Keybase sigchains](https://book.keybase.io/docs/teams/sigchain): per-user signed, hash-linked statement chains.
- [Nostr NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md): a DNS-hosted name pointing at a key.
- [ENSIP-19](https://docs.ens.domains/ensip/19): ENS reverse resolution, where the key's owner sets the reverse record.

What this document adds, as far as the author knows: an owner-signed binding carried inside the plain bsvalias
`pki` response; a public change log that records operator database edits through a trigger, as actor `admin`; and
planned periodic on-chain anchoring of the log head. Corrections are welcome.

## Process

This draft follows the BRCs repository's contribution rules (AGENTS.md). It will first be raised as an issue
addressed to the authors of BRC-169 and BRC-174, asking whether it belongs as an amendment to one of them or as a
standalone document. No BRC number has been chosen or claimed.

## Reference implementation

bWalletX (open source, Open BSV License), repository `github.com/b0ase/yours-mobile`:

- Verification: `src/mobile/names/binding.ts` (`checkBinding`)
- Message format and signing: `src/mobile/names/paymail.ts` (`signedMessage`, `signRequest`)
- Server: `site/lib/paymail.js` (`pki` binding field, `bind`, `name-log`)
- Database: `migrations/20261017_name_bindings.sql` (tables, hash-chain trigger, append-only trigger, directory
  change trigger)
- Design notes: `docs/NAME-BINDINGS.md`

Live service: `https://pay.bwallet.space/api/paymail/id/<alias>@bwalletx.com` and
`https://pay.bwallet.space/api/paymail/name-log`.

## Addendum (17 Oct 2026): two-party handover, no operator recovery

Implemented in the reference implementation:

- A name moves only with a **release** signed by the current owner (`release` message: alias, identityKey = from,
  seq, timestamp, to) and an **accept** signed by the new owner (a `bind` for the same seq). The host stores and
  serves both; the binding carries `handover: { from, releaseSignature, releaseTimestamp }`.
- Once a key has signed a name, the host refuses a plain bind by any other key.
- **No operator or time-delayed recovery, by design.** A lost key keeps its name. Recovery belongs to the user, set
  up in advance, so it recovers the key rather than reassigning the name.
- Wallets apply BRC-169 §4.4: a key change without a valid handover from the previously seen key stops payment, with
  a deliberate user override after out-of-band checking.

(Earlier text in this draft that describes the key-change rule as "not yet in the reference implementation" is
superseded by this addendum.)
