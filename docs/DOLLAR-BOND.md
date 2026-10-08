# $1 bonds backed by BSV

Status: **design note, not started** · Owner idea: 5 Oct 2026 · bWalletX only

## The idea

BSV has no dollar unit that is backed by BSV itself rather than by a custodian's bank account. A
**$1 bond** is a token worth one US dollar, minted by locking more than a dollar's worth of BSV in a
**vault**. Anyone with BSV can mint dollars without selling their BSV; anyone holding bonds knows each
one is backed on chain by more than $1 of BSV.

It's the over-collateralised design proven on other chains (MakerDAO's DAI, Liquity's LUSD), built
with BSV scripts and launched from the smart wallet.

## How it works

1. **Open a vault.** Lock BSV in a vault script that only the owner can unlock, and only once the vault's
   debt is repaid.
2. **Mint bonds.** Mint up to the **minimum collateral ratio** in $1 bonds (a BSV-21 token, symbol
   e.g. `$USDB`). Example at 200%: lock $200 of BSV, mint 100 bonds.
3. **Use them.** Pay with them, sell them on the Exchange for BSV or other tokens, or hold them.
4. **Close.** Burn the bonds plus the **stability fee** (the bond's interest), and the BSV unlocks.
5. **Liquidation.** If BSV falls and a vault's ratio drops below the **liquidation ratio** (e.g. 150%),
   anyone may repay its bonds and take its BSV at a discount (e.g. 10%). The vault owner keeps whatever
   is left over. This keeps every bond backed by more than $1.
6. **Redemption (optional).** Anyone may hand in $1 of bonds for $1 of BSV from the least-collateralised
   vaults (Liquity-style), which holds the price near $1 from below.

## Parameters (starting points, to tune on testnet)

| Parameter             | Start     | Notes                                        |
| --------------------- | --------- | -------------------------------------------- |
| Minimum ratio to mint | 200%      | BSV is volatile; start conservative          |
| Liquidation ratio     | 150%      | Below this, anyone can liquidate             |
| Liquidation discount  | 10%       | The keeper's reward                          |
| Stability fee         | 2% a year | Paid in bonds when closing; the bond's yield |
| Minimum vault         | $50       | Keeps dust vaults out                        |

## The parts

- **Vault script.** A covenant (sCrypt-style) holding the BSV. Spend paths: _close_ (owner signs + burns
  the vault's bonds), _top up_ (owner adds BSV), _liquidate_ (anyone, with a signed price showing the ratio
  is below the line, and burning the vault's bonds).
- **Bond token.** A BSV-21 token whose mint is only valid in the same transaction that opens or increases
  a vault, and whose burn is checked by the vault's close / liquidate paths.
- **Price feed (oracle).** The contracts need BSV/USD. Prices are signed by several independent signers,
  and the vault uses the median of a quorum (e.g. 3 of 5), with a timestamp no older than a few minutes.
  **This is the trust point:** bad prices mean wrong liquidations. Signers and their keys are public.
- **Keepers.** Anyone watching vaults and liquidating unsafe ones. In bWalletX this is an agent strategy
  (see SMART-WALLET-SPEC.md), sold on the Exchange's Strategies section.

## In the smart wallet

- **Exchange › Bonds:** buy and sell bonds; open, top up and close your own vaults; see every vault's
  ratio.
- **Agents:** a "keep my vault safe" strategy tops up a vault from an agent account before liquidation; a
  "keeper" strategy liquidates unsafe vaults for the discount.
- **Contracts:** the vault is the first contract template in Exchange › Contracts (SMART-WALLET-SPEC.md §8).

## Risks

- **Oracle:** wrong or stale prices. Mitigation: quorum of independent signers, freshness limits,
  pause on large disagreement.
- **Crash liquidity:** in a fast fall, liquidations need buyers. Mitigation: high starting ratios,
  keeper strategies, a stability pool later (bonds deposited to absorb liquidations).
- **Script bugs:** locked funds or wrong liquidations. Mitigation: testnet, a capped mainnet launch,
  independent review of the scripts.
- **Peg drift:** bonds can trade above or below $1. Redemption (step 6) and the stability fee pull
  them back.
- **Rules:** dollar-denominated tokens draw regulators' attention in the UK, EU and US.

## First step

A testnet prototype of one vault: open, mint, top up, close and liquidate, with a simple 3-of-5 price
feed. It answers whether the scripts are practical on BSV before anything else is built.
