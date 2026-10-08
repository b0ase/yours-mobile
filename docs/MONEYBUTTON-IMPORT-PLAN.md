# Money Button import plan

Owner, 7 Oct 2026: "can we add import moneybutton wallet into our restore wallet feature or 'sweep keys' feature? They have a different, now defunct, token standard."

"Money Button" here means the original moneybutton.com wallet (Yours Inc, 2018 to 2022). Our own MoneyButton project (`moneybutton2`, $MONEYBUTTON) has no user wallets to import: it signs in with HandCash, pays out from a server key, and its token is BSV-21, which the sweep already handles. The "defunct token standard" is Money Button's SFP.

## What a Money Button wallet is

|                   | Value                                                                                   | Source                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Phrase            | BIP39, 12 words by default, optional passphrase ("added as though it were a 13th word") | Money Button docs, _Mnemonics (BIP39)_: github.com/moneybutton/docs `docs/bsv-mnemonic.md` |
| Account path      | `m/44'/0'/0'`                                                                           | same doc: "Money Button uses the wallet path m/44'/0'/0'"                                  |
| Chains            | Receive only, `m/44'/0'/0'/0/i`. "Money Button does not use internal addresses."        | same doc                                                                                   |
| ElectrumSV import | BIP39 seed words, derivation `m/44'/0'/0'`                                              | ElectrumSV import guide (Roger Taylor)                                                     |

Restore from the phrase: walk `m/44'/0'/0'/0/i` until 20 unused addresses in a row (BIP44 gap limit). Money Button handed out a fresh address per payment, so the walk can be long; the scan keeps going while it finds history (cap 2000 per chain). We also walk `/1/i`, which costs 20 lookups and catches funds that another wallet restored from the same phrase may have put there.

## Tokens: SFP (Simple Fabriik Protocol for Tokens)

Money Button "assets" (2020 to 2022, built with Fabriik) used SFP. From the archived docs (docs.moneybutton.com/docs/sfp/protocol-overview, wallets-integration-guide, paymail-09-sfp-build, June 2021):

- Each token UTXO is an output of about 546 sats with the script
  `OP_NOP <"sfp@0.x"> <asset paymail> <authoriser / owner / issuer hash160s> <linked outpoint + signature> <locking code> OP_RETURN <8-byte LE amount + notes>`.
- The locking code needs the owner's signature **and** the authoriser's signatures. The authoriser was Money Button/Fabriik's server (paymail extensions for build/authorise). It is gone.
- Asset details (name, supply, authoriser pubkey) came from a paymail lookup on moneybutton.com, also gone.

What that means:

1. **They can be found on chain.** The script names the owner's hash160 and the asset paymail and amount are in plain data, so we can parse them.
2. **They can't be moved.** Without the authoriser's signature no transaction spends them, to the user's ord address or anywhere. "Move them intact" is not possible.
3. **They can't be burned by us either,** for the same reason. The real risk is a wallet treating the 546-sat output as plain BSV: the sweep would build a transaction that fails, and the BSV sweep for that address fails with it.
4. Indexers list UTXOs by P2PKH script hash. SFP outputs are not P2PKH, so 1sat and WhatsOnChain don't show them under the owner's address. We find them by reading the address's own history and parsing every output.

**Recommendation: leave them and list them.** Show asset, amount and outpoint, say plainly that they can only move with Money Button's token server and that we leave them untouched. Keep the outpoints so the user (or a future issuer who re-launches an asset) can prove what they held.

## Phase 1 (built, branch `feat/moneybutton-import`)

Settings › Sweep from another wallet (`src/mobile/sweep/HdSweepScreen.tsx`):

- The `m/44'/0'/0'` walk is now labelled "Money Button / BIP44 (Bitcoin legacy)", and Money Button is named on the screen. A Money Button phrase, with its passphrase under Advanced if it had one, finds the funds with no picking.
- BSV on the found addresses is swept to this account as before.
- For addresses on the Money Button path (and a pasted WIF or xprv), the scan reads up to 200 history transactions per address from WhatsOnChain, finds SFP outputs naming one of those addresses, and drops the ones the 1sat spend index marks as spent. They appear on the review screen as "Money Button tokens (kept, not swept)" with the explanation.
- **Guard for every sweep:** after `prepareSweepInputs`, only plain P2PKH inputs go to `sweepBsv`. Anything else, plus any known SFP outpoint, is kept back and reported as "Left untouched".
- `src/mobile/sweep/moneybutton.ts` (pure): path constant, SFP script parser, raw-tx output reader, `splitSpendable`. Tests in `moneybutton.test.ts` use the public BIP39 "abandon … about" phrase (BIP44 vectors for `m/44'/0'/0'/0/0..2`) and the example transaction from Money Button's own SFP docs. No real keys.

Not in phase 1:

- **Restore as an account** (Add account › Restore). bWalletX accounts use the Yours key layout (`m/44'/236'/…`); a Money Button phrase restored there finds nothing. The supported route is sweep into an existing account. If we want restore, it means a "foreign HD account" type, which is a bigger change. Recommend: don't, sweep is enough.
- Tokens received with no P2PKH activity on the owner address won't appear in that address's history. Fixing that needs a pushdata search (JungleBus or our own indexer on the `sfp@` prefix).
- Asset names: the paymail lookup is dead, so we show the asset paymail as its name.
- bit-sign backup files (`bit-sign-wallet-*.json`): those hold one WIF, plaintext or PBKDF2/AES-GCM encrypted. A pasted WIF already works. Reading the file directly could be a small phase 2.

## Phase 2 options

1. Upload a bit-sign backup file into the sweep (decrypt on device).
2. `sfp@` prefix search via JungleBus so tokens are found even when the owner address has no history.
3. Export of held SFP outpoints (CSV/JSON) as a record of ownership.

## Tested against a real wallet (7 Oct 2026, read-only, public data only)

The owner's Money Button wallet (m/44'/0'/0'/0, Aug 2020 to Feb 2021, 31 txs, change chain unused) has 15 `sfp@0.1` outputs across 7 assets (`<12 hex>.asset@moneybutton.com`). Every one pushes two hash160s: the Money Button authoriser (`036d4804…`, 1K7waK…, the same on all of them) and the owner.

**Owners are receive addresses in the gaps, confirmed against the phrase.** Used addresses only paid the fees. The owners sit at unused indices on the same chain:

- 30 → a3042ad4:0, 32 → c98b0100:0, 34 → e3cbe5a8:0, 36 → fa7dcb96:0, 38 → e7a45eda:0
- 41 → 980cca4d:1, 43 → d40480c9:0, 45 → bf8161f2:0
- 52, 53 → e124454e:0/1; 56, 55 → 28ffc739:0/1; 60 → 7ff5bdad:1

980cca4d:0 (10,000) and 7ff5bdad:0 (10,000,000) were sent to other people. No hits on m/44'/0'/0'/1, m/44'/0'/1'/0, m/44'/236', m/44'/145', m/0, m/0' or m/0'/1.

Still held by this wallet: six single mints (a3042ad4, c98b0100, e3cbe5a8, fa7dcb96, d40480c9, bf8161f2) plus 89,990,000 of c6c0c9f0324e at 7ff5bdad:1. Decimals are unknown because the asset paymail lookup is gone, so amounts are shown raw.

**Owner-matching rule** (`findOwnedSfp`):

- Match owners against every address from index 0 to the last used index plus 20, on both chains.
- Then keep extending the range to 20 past the highest matched owner, and repeat until it stops growing.

In this wallet the highest owner index is 60 and the last fee address is 59, so the first range already covers it. The extension handles owners that sit past the last fee address.
