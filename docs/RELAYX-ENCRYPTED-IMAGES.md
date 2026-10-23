# RelayX encrypted NFT images (NPG Series 1 + 2)

Question (17 Oct 2026): can a holder of an NPG RelayX Run jig decrypt the jig's image with their own key?

**Verdict: no, not with the holder's key alone.** The image is encrypted with a symmetric AES-128-GCM content key that is not on chain in any form (no wrapped key, no recipient, no ephemeral pubkey, no key id). The key must be held off-chain, almost certainly by RelayX, or derived from a key only the minter (NPG's RelayX account 1B6Pjhoi…) holds. Unverified which; see test plan.

## Evidence (on chain)

| | Series 1 | Series 2 |
|---|---|---|
| Class origin | `6a7a4b754e41c1e9bfed03f6b1a7edc5a1fe3342c93436ac66f91b8a449f5c4c_o2` (block 719,393) | `393b1c2a101213a3c8431ec4401ecb463b05b51e1bed389a8e5b35f00589be8e_o2` (block 733,985) |
| Class metadata | `isEncrypted: true`, `numbered: true` | same |
| Collection cover (class tx vout 0) | plain B-protocol PNG "NPG VS EROBOTS.png" (2.2 MB) | plain B PNG "…Series 2.png" |
| First mint tx | `cb1c9e8491080beab22760f413755dc1d03bede35a0bd67d3387cb1d64a7e8be` | `5023bb9ba51095ad92fd3d36bc0afa6f2407b2cf8f6156cfb67b65573c0dd6b4` |
| Mint call | `mint("", {description:"", image:"_o1", name:""})`, created by `1B6Pjhoi1uD8dqDjczSaGXs4hBSQGQjh2` | same |
| Item image (mint vout 0) | encrypted, `image/png`, 733,006 B | encrypted, `image/jpeg`, 470,567 B |

Mint vout 0 layout (OP_FALSE OP_RETURN):
1. `UNIV` (protocol prefix)
2. CBOR map `{ctype: "image/png"|"image/jpeg", proto: "relay.encrypted-nft"}`
3. ciphertext
4. `f6` (CBOR null)
5. CBOR array `[ {iv: <12 bytes>, alg: "A128GCM", tag: <16 bytes>}, null ]`. This is COSE_Encrypt-shaped: protected header with IV, alg and tag, **recipients = null**.
   - S1 iv `0092d27063f237b30c506f1e`, tag `88f738c1bd8cb786f6cfcaf2111ae163`
   - S2 iv `0defcb6a04e5cd3cd2fad1db`, tag `5bd4f9422a409942a6ab582b8360f693`

A COSE structure with null recipients means the content key is distributed out of band. Nothing on chain ties it to the owner's pubkey. The first S1 transfer (`13ca64a8…080e`) is a RelayX order-lock listing (`send` with `$arb` 1,000,000 sats) and carries no key material either.

Public sources: no documentation of `relay.encrypted-nft` found (searched RelayX, run-sdk, the web). RelayX's "encrypted NFT" reveal appears to be a RelayX-server feature (the key is shown to the logged-in owner).

## Consequences for the importer
- The wallet **can** find a user's S1/S2 jigs from their RelayX keys (address UTXOs → jig locations → class origin) and show them read-only. The class gives "S1" or "S2" but **not the card number**.
- Card number can't come from decrypting with the holder key. Remaining routes: mint order (tokenblaster map A: mint index from the class-jig chain, which is one mint per tx from 1B6Pjhoi…), or the RelayX API while it lives.

## Test plan (no key leaves the device)
1. **Holder-key test (expected to fail):** for one jig the user owns, derive candidate keys on-device (owner key at m/44'/236'/0'/…, purse key, ECDH(owner priv, minter pubkey), HKDF/SHA-256 of each with the jig origin), try AES-128-GCM with the on-chain IV and tag. The GCM tag check proves success or failure exactly; no false positives.
2. **Minter-key test (owner only, needs NPG's RelayX key for 1B6Pjhoi…):** same derivations from the minter key, plus `SHA256(minterPriv || origin)[0:16]`. If one passes, every image is decryptable by NPG, and tokenblaster can perceptual-hash all 3,138 against release9 once (server-side, owner-run), giving jig → NNNN without users doing anything.
3. **RelayX API:** check whether relayx.io still serves a "reveal" endpoint for an authenticated owner (owner's browser session only).
4. Otherwise: mint-order map.
