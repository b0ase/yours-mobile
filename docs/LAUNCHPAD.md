# Launchpad (Exchange › Launchpad)

In-app "Launch your own coin" (`src/mobile/exchange/launch/`): BSV-21 deploy from the active wallet,
1B default supply, icon, flat launch fee (`LAUNCH_FEE_SATS`, 100,000 sats to the mint-fee address; none
in a build without one, and never in a store build), one approval sheet, holders' room at launch,
result opens the coin's Exchange page. Advanced: decimals, room entry minimum, category,
website/X/Telegram (on-chain MAP coin card), optional indexing fund. Launches are listed under
"Launched in bWalletX" (this device + bit-sign `/api/bitsign/launches`). bWalletX only (`MARKET_ENABLED`).

## Parity with tokenblaster.lol (internal; not shown in the UI)

Implemented: ticker, name, story (description), image, supply (1B default), decimals (0 default),
flat launch fee, indexing fund (optional), launch acknowledgement (as a notice on the approval sheet).

Not implemented (they depend on a bonding-curve market and server vault, i.e. partner launchpads):
fee route to creator (payout address), fee sharing split (2–10 wallets), holder rewards,
buyback & burn, supply minted into a curve pool, graduation, signed launch slot (pool/reserve/vault
addresses).
