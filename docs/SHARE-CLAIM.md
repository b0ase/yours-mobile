# Register-of-members claims ($NPG first)

Owner, 18 Oct 2026: **$NPG BSV-21 tokens are the share record of Ninja Punk Girls Ltd (No. 13706347), one token = one
share, one token per allotment tranche.** Code: `src/mobile/shareClaim/`. NPG side: ninja-punk-girls-com PR #30.

## Pinned registry (`companies.ts`)

Per company: host, **identity key** (verifies invite and holding signatures), **lock key** (the company half of
every 2-of-2; distinct from the identity key), and the allowed token ids → tranche. Both keys are empty today, so
every claim is refused with "Company key not configured". Keys inside a payload are never trusted: the payload's
`lock.companyPubKey` must equal the pinned lock key.

| Tranche | Token id                         | Shares                                |
| ------- | -------------------------------- | ------------------------------------- |
| 2022A   | `b8747a4b…dcba67d31_1`           | 2,045,457 (allotments up to Apr 2022) |
| 2022B   | not deployed (add once deployed) | 70,458                                |

Total 2,115,915. Supply comes from here, never from the GorillaPool index (it reports null).

## Links

`bwalletx://claim/<inviteId>?c=npg` and `https://web.bwalletx.com/m/claim/<inviteId>?c=npg`. `inviteId` is 43-char
base64url (256-bit), single use, 30-day expiry.

## Signing (matches the NPG side byte for byte; shared vector in `shareClaim/__fixtures__/`)

Canonical JSON: keys sorted, no whitespace, `undefined` dropped, arrays in order, UTF-8 bytes.

1. **Invite** `GET <host>/api/shareholders/invite/<inviteId>` → `{v, company, tokens[], holder{registerEntry, shares,
nameOnRegister}, lock{type:'2of2', companyPubKey, releaseAfterBlock:null}, claimUrl, expiresAt, sig}`. `sig` =
   `ProtoWallet(companyKey).createSignature(canonicalJson(payload − sig), [1,'npg share invite'], keyID '1',
'anyone')`, DER hex; the wallet verifies with `ProtoWallet('anyone')`, counterparty = pinned identity key.
   Checks: signature, expiry, every token id pinned, decimals 0, tranche names, `holder.shares` = Σ amounts, claimUrl
   on the pinned host, lock key = pinned lock key, `releaseAfterBlock` null. 503 = company not set up, 409 = a tranche
   not deployed.
2. **Claim** `POST claimUrl {inviteId, identityKey, lockPubKey, signature}`; signed bytes
   `canonicalJson({inviteId, identityKey(lowercase), lockPubKey(lowercase)})`, `[1,'npg share claim']`, keyID =
   inviteId, `'anyone'`. lockPubKey ≠ identityKey. Optional response: `txid` (lock tx), `claims[]` (for recovery).
3. **Holding** (PROPOSED, not yet on the NPG side) `GET <host>/api/shareholders/holding/<identityKey>` with
   `x-bwx-timestamp` / `x-bwx-signature` (`canonicalJson({identityKey, timestamp})`, `[1,'npg share holding']`,
   keyID = timestamp). Response signed like the invite under `[1,'npg share holding']`, keyID '1'.

## Lock

Lock key: BRC-42 from the seed, `[1,'npg share']`, keyID = inviteId, counterparty self. **One lock key per invite,
shared by every tranche of that invite**; each tranche is its own output.

Script per tranche: BSV-21 transfer inscription (`{"p":"bsv-20","op":"transfer","id":…,"amt":"N"}`,
`application/bsv-20`) followed by the 1Sat **Cosign** script
`OP_DUP OP_HASH160 <hash160(lockPubKey)> OP_EQUALVERIFY OP_CHECKSIGVERIFY <companyLockKey> OP_CHECKSIG`.
Spend = `<companySig> <holderSig> <lockPubKey>`: both signatures needed. Cosign (as MNEE uses) rather than bare
`OP_CHECKMULTISIG` so 1Sat indexers credit the balance to the holder's lock address. The wallet shows "done" only
after fetching the lock tx and finding, per tranche, an output byte-equal to the expected script.

## Recovery

Lock keys are rebuilt from the seed for every inviteId found in (a) this device's claim records
(`bwallet.shareClaims.v1`) and (b) the company's `claims` list. Limits: an inviteId cannot be derived or guessed, so
if both are lost the holder asks the company to resend it; until then the tokens cannot move (they need both keys
anyway). The company also needs its own lock key; losing it freezes every lock until a court/registry process.

## Open (owner decisions)

- Who moves the tokens into the locks (`ClaimResult.txid` is only read, never produced here).
- Payout addressing.
- Register import tooling.
- Timed release (`releaseAfterBlock` must be null today).
- The company identity key and lock key (empty placeholders).
