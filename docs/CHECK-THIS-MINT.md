# Check this mint

A verifier for bMint mints that trusts no server. You give it a mint (and, if you like, the file). It gives back one verdict and the reason for it.

Code: `src/mobile/bmint/check/` (`verify.ts` decides, `sources.ts` fetches, `guard.ts` walks untrusted bytes before parsing). UI: `/m/bmint/check`, shareable as `/bmint/check?o=<outpoint>` or `/check?o=<outpoint>`. Shared links work signed out.

The output contract is modelled on Lightweb's [bfinger](https://github.com/lightwebinc/bfinger) (Apache-2.0): one clear verdict, a specific reason when it refuses, and a failure to fetch is never shown as a pass. The bounded parsing follows the idea of bcommon's `guard` package. We ported the ideas only, not the code.

## What a bMint mint is (as of Oct 2026)

`mint/mintMedia.ts` builds one transaction with:

- **Output 0**: the 1Sat inscription, `OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <file bytes> OP_ENDIF`, then a P2PKH lock, then `OP_RETURN MAP SET app bWallet type ord name <title> …`. Editions are copies at outputs 1…N-1.
- **An issuer statement** (`issuer/issuerSign.ts`), a 0-sat OP_RETURN in the same transaction: `MAP SET app bWallet type issue kind ordinal script_sha256 <sha256 of output 0's locking script> identity_key <33-byte key>`, then `| AIP BITCOIN_ECDSA <address> <signature>`. The AIP key is the identity key's BRC-42 child `[2,'bwallet issuer'] / '1' / anyone`, so anyone can derive its address from `identity_key`.
- A fee output and change.

The signature covers the hash of the whole inscription output (content, content type, MAP and lock), and it names the owner's identity key. The timestamp comes from the block that mines the transaction. Nothing in the transaction states a time.

## Inputs

- **A mint**: an outpoint `txid_vout` (or `txid.vout`, `txid:vout`), a bare txid (meaning output 0), or any link holding one (`?o=…`, an ORDFS `/content/<txid>_<n>` URL, a WhatsOnChain tx page).
- **Optionally, a file.** It is hashed with SHA-256 on the device (`crypto.subtle`) and never uploaded. Only the hash goes to the verifier.

## Checks, in order

1. **Bounded parse** (`guard.ts`). The BEEF, and each transaction and BUMP inside it, is walked before `@bsv/sdk` parses it. Every count and length must fit the bytes present and stay within limits. Trailing bytes, empty BEEFs and transactions with no inputs are refused. The SDK then parses with `Beef.fromBinaryStrict`.
2. **The transaction is the one named.** The BEEF must hold a transaction whose bytes hash to the txid.
3. **The output is an inscription** with a body.
4. **Signature.** An issuer statement whose `script_sha256` equals the hash of this output, whose AIP signature recovers to its stated address, and whose address is the one derived from `identity_key`. Signatures are checked before the block proof, in the same order bfinger uses: decide what was signed first, then where it sits.
5. **File** (if one was given). The SHA-256 of the inscribed body must equal the file's.
6. **Merkle proof.** The BUMP in the BEEF must compute a merkle root from this txid.
7. **Block header**, fetched by the BUMP's height from **two independent sources** (WhatsOnChain and Bitails). We rebuild or take the 80 bytes ourselves, and both sources must give the same bytes for that height. The header's double-SHA256 must be at or below the target in its `bits`, and that target must be no easier than `0x1900ffff` (difficulty ≈ 4.3 billion; recent BSV blocks run near 37 billion, so a cheap fake header fails). Its merkle root must equal the root from step 6.

## Verdicts

| Verdict            | Meaning                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **VERIFIED**       | Every check passed. Shows the height H, block time, signing key, content type, size and hash, whether your file matched, and which header sources agreed.                                  |
| **PENDING**        | Signature (and file, if given) check out, but there is no block proof yet. Shown in amber and never as verified.                                                                           |
| **REFUSED** + code | A check failed. Codes: `malformed`, `not-in-proof`, `no-output`, `not-a-mint`, `unsigned`, `bad-signature`, `content-mismatch`, `proof-mismatch`, `header-pow-invalid`, `header-mismatch`. |
| **UNREACHABLE**    | We could not fetch the transaction, or fewer than two header sources answered. This is not a pass, and the screen says so.                                                                 |

A source that is down gives UNREACHABLE. A source that lies gives REFUSED, because every answer is checked against its hash.

## What VERIFIED proves, and what it doesn't

**It proves** that these exact bytes were in Bitcoin block H, so they existed by that block's time, and that key K signed them. If you gave a file, it also proves that your file is byte-for-byte the minted one.

**It does not prove**:

- who holds K. K is a public key. A paymail or handle shown beside it is a label from a lookup, not a proof. Only a $401 identity attached to K (planned) would tie it to a person.
- authorship or copyright. K published the bytes. It may not have made them.
- that nobody minted the same bytes earlier. This check looks at one mint only.
- who owns the inscription now. A transfer after the mint does not change the verdict.
- the exact moment. A block's timestamp can be off by up to about two hours. "By block H" is the strong claim.

## Gaps (v1)

- **No full header chain.** We check each header's own work, apply a difficulty floor, and require two sources to agree. We do not walk the chain back to a checkpoint or compare chainwork. A future version can keep a small header store (or use a block-headers service) and check the header's ancestry and depth.
- **Mints only.** Notes, OpNS names and BSV-21 deploys use other formats, and the verifier refuses them as `not-a-mint` or `unsigned`. Old mints made before issuer signatures existed show as `unsigned`.
- **Streamed inscriptions** (multi-transaction OrdFS) are not supported. bMint does not make them today.
- **No $401 identity yet.** When it lands, a VERIFIED result can add "K belongs to <identity>" as a separate, separately checked line.
- **Header sources are fixed** (WhatsOnChain + Bitails). They should become settings, so a user can point at their own node.
