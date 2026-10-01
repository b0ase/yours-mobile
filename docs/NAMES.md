# Names in bWallet

## What ships (mobile layer, `src/mobile/names/`)

**Send to a name.** The BSV and BSV-21 Send screens use `NameInput` in place of
upstream's address box. It's a build-time swap in `vite.config.mobile.ts`. The box accepts:

| Input           | Resolution                                                                                                | BSV send                                                                 | Token send                           |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `1ABC…` address | as-is                                                                                                     | address                                                                  | address                              |
| `$handle`       | `handle@handcash.io` paymail                                                                              | P2P paymail                                                              | only if the paymail has `ordAddress` |
| `name@domain`   | bsvalias capability discovery (SRV via DoH, then `/.well-known/bsvalias`)                                 | P2P (`2a40af698840`) when present, else the `paymentDestination` address | only if the paymail has `ordAddress` |
| `name` (OpNS)   | GorillaPool `/api/opns/:name` owner, falling back to `api.1sat.app/1sat/opns/origin` + latest inscription | owner address                                                            | owner address                        |

Resolution fills in a card with the name, avatar (paymail public-profile `f12f968c92d6`) and destination
type. The send only receives the destination after the user taps **Send to this name**, and
upstream's normal SendConfirmation follows. P2P paymail sends go through upstream `sendBsv`
(`@1sat/actions`): it fetches a fresh P2P destination and delivers the BEEF. A token sent to a
paymail without an ordinal-receive capability is refused with "This name can't receive tokens".

**Get your name** (Settings → Identity). This runs a read-only OpNS availability search and lists the
OpNS names in the wallet's `opns` basket. **Use this name** runs `registerOpns`, a self-transfer that binds
the identity key, behind the standard SendConfirmation sheet. The chosen name appears in the top-left
account bar and on the Receive screen. It is stored per identity address in localStorage.

Not done yet: minting a brand-new OpNS name. A new name has to be mined on the OpNS tree with
proof-of-work (`/1sat/opns/mine/:name` returns the parent outpoint), and `@1sat/actions` doesn't
bundle a miner. Buying a listed name (`buyOpns`) is also left out for now.

## bWallet paymail (`name@<our domain>`): what hosting needs

Config constant: `BWALLET_PAYMAIL_DOMAIN` in `src/mobile/names/config.ts`. It is empty by default, and while it is empty the feature stays off.

1. **A domain we own** with HTTPS. Then add either
   - `https://<domain>/.well-known/bsvalias` served directly, or
   - DNS SRV `_bsvalias._tcp.<domain>` → `<host> 443`, with DNSSEC recommended (clients use DoH).
2. **The bsvalias capabilities document** must include:
   - `pki` — `/id/{alias}@{domain.tld}` → `{ handle, pubkey }` (the user's identity public key)
   - `f12f968c92d6` public profile → `{ name, avatar }`
   - `a9f510c16bde` verify pubkey
   - `2a40af698840` P2P payment destination: `POST { satoshis }` → `{ outputs:[{script,satoshis}], reference }`
   - `5c55a7fdb7bb` receive BEEF, and `5f1323cddf31` receive raw tx: the server checks the tx pays the
     reference's outputs, broadcasts it (or hands it to ARC), and queues it for the wallet
   - `ordAddress` (1Sat): `/ord/{alias}@{domain.tld}` → `{ address }`, a derived ordinal-receive
     address, so the name can receive BSV-21 tokens and ordinals
3. **Derivation with no private keys on the server.** Store only each user's identity public key. P2P
   outputs come from BRC-29 / BRC-42 derivation: the server picks a fresh `derivationPrefix`/`derivationSuffix`
   per payment and derives the child public key against a server keypair as counterparty (`protocolID [2,'3241645161d8']`).
   It returns P2PKH outputs and records `{prefix, suffix, senderIdentity}` against the `reference`. The wallet later
   internalizes the payment with `internalizeAction` (wallet payment remittance) because it can derive the
   matching private key. Never accept or store user private keys or seeds.
4. **Delivery to the wallet.** The phone isn't always online. The server keeps received BEEFs in an inbox
   (per identity key), and the wallet polls it after BRC-31 / BRC-103 authentication on open and calls
   `internalizeAction`. The overlay message box can serve as that inbox.
5. **Registration.** In-app, the user picks an alias and signs `{alias, identityKey, timestamp}` with the
   identity key. The server checks the signature, enforces uniqueness and rate limits, and maps the alias to the key.
   An optional OpNS name binding (`opns.idKey`) lets the alias match an on-chain name.
6. **Ops.** Rate-limit the P2P endpoint, log the references, keep server keys in the host's secret store
   (never in git), and monitor broadcast failures.

Once that's live, set `BWALLET_PAYMAIL_DOMAIN`. "Get your name" then shows `name@domain` as the user's paymail.
