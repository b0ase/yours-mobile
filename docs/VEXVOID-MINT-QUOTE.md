# VexVoid discography: on-chain mint quote

Quote only. Nothing has been minted and no transactions have been made. Prepared 5 Oct 2026.

## Source

`/Volumes/2026/Downloads/VexVoid-Discography`: 70 MP3 files, 308,117,232 bytes (293.8 MiB) in total.
Sampled bitrate is about 192-197 kbps (ffprobe on 2 files).

- Largest file: `Shadows in the Smoke (1).mp3` at 6.75 MB. **No file is over the wallet's 10 MB per-mint limit** (`MAX_MINT_BYTES`).
- **35 unique titles.** 22 titles have alternate takes named `(1)`…`(5)`, for example Echoes in the Dust ×6, Shadow Steps ×6, Four Ton Shadow ×5 and Shadows of the Mind ×4.
- Probable near-duplicates that are not caught by the `(n)` suffix: Four Ton Shadow / Four Ton Shadows, Shadows of the Street / Shadows of the Streets, and Shadows of the Past / Shadows of the Past (Remix) (the remix is counted as a separate title).
- Picking the largest take of each title gives 168,216,264 bytes (160.4 MiB).

## How the wallet prices a mint (`src/mobile/mint/mint.ts`)

- Network fee per mint = `ceil((bytes + 900) × satsPerKb / 1000) + 1`.
- The default fee rate is `FEE_PER_KB = 100` sat/kB (`src/utils/constants.ts`), unless the user sets a custom rate.
- The bWalletX mint fee is 1% of the network fee (minimum 1 sat), paid by `withFeeOutput`. The store build (bWallet) charges no fee.
- A mint that also creates a new collection is estimated at 2 transactions. That adds one small transaction once, so it is ignored below.

BSV/USD is $20.13 (WhatsOnChain, 5 Oct 2026).

## Cost (network fee plus the 1% bWalletX fee)

| Fee rate | All 70 files | 35 unique titles |
|---|---|---|
| **100 sat/kB (wallet default)** | **31,126,342 sats ≈ $6.27** | **16,993,096 sats ≈ $3.42** |
| 10 sat/kB | 3,112,758 sats ≈ $0.63 | 1,699,371 sats ≈ $0.34 |
| 1 sat/kB | 311,404 sats ≈ $0.06 | 170,002 sats ≈ $0.03 |

## Cheaper options

1. Mint one take per title (35 mints instead of 70). This roughly halves the cost.
2. Re-encode to 128 kbps (about 16 kB per second, roughly 2/3 of the current size). For the 35 unique titles that comes to about 112 MB, or about 11.3M sats ≈ **$2.28** at 100 sat/kB.
3. Lower the fee rate. Miners accept much less than 100 sat/kB. At 1-10 sat/kB the unique set costs $0.03-$0.34, but low-fee transactions this large may confirm slowly.

Recommendation: 35 unique titles, re-encoded to 128 kbps, at the default rate. That costs about $2.30. Setting a custom low fee rate would bring it under $0.25.
