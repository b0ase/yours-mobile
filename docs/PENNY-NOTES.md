# Penny Notes

Status: **decided 5 Oct 2026, design** · Prototype: `/Volumes/2026/Projects/bwalletx-bond` · Supersedes the "bond" framing in DOLLAR-BOND.md

## What it is

A dollar stablecoin on BSV, backed only by BSV locked in public contracts (the MakerDAO / DAI model). A note is
cash: spend it, send it, price things in it. No interest, no maturity, no bank account behind it.

- **Notes**: amounts in cents. One unit = 1¢; a "$10 note" is simply 1,000 units in one output. Amounts aggregate
  and split like any token, so there are no fixed denominations to manage. The wallet shows them as dollars ($12.34).
- **Vaults**: anyone locks BSV and mints notes against it, up to 1 / minimum ratio of its value (10x to start: $1 of
  BSV mints 10¢). They keep the BSV and its upside. To unlock it they hand back the notes they minted.
- **Liquidation**: if BSV falls so a vault is below 150%, anyone can repay its notes and take its BSV at a 10%
  discount, which keeps every note backed. At 10x a vault survives an 85% fall in BSV.
- **Price feed**: 3-of-5 independent signers, median price, fresh timestamps.

Why it matters: everyone wants a dollar on BSV. MNEE exists but needs a co-signer and is backed by dollars in a bank.
Penny Notes are backed by BSV you can see on chain.

## Parameters (start)

|                       |                                                             |
| --------------------- | ----------------------------------------------------------- |
| Unit                  | 1¢                                                          |
| Minimum ratio to mint | 1000% (10x)                                                 |
| Liquidation ratio     | 150%                                                        |
| Liquidation discount  | 10%                                                         |
| Fee                   | 0% (notes are cash; a small mint fee for bCorp is optional) |
| Minimum vault         | $0.50                                                       |

All are per-vault constructor values: changing them doesn't change the contract code.

## The key design choice: what a note is on chain

**A. Stateful contract tokens (the prototype today).** Each note output is a small sCrypt script. Only bWalletX
(and anything we teach) understands them.

**B. A BSV-21 token, `$PENNY` (recommended).** Notes are an ordinary BSV-21 token with 2 decimals, so they show up
in every 1Sat-compatible wallet, trade on the 1Sat market, and send by name today. The vault contract holds the BSV;
new notes are released only in the same transaction that mints against a vault, and notes are burned when a vault
closes or is liquidated.

Either way the prototype's main gap remains: a script can't see other inputs, so the vault can't check by itself that
real notes were burned. Today an issuer co-signs burns. With B, bCorp is that issuer and runs the release/burn rules in
the open (every vault, every mint and burn is on chain and auditable); the plan is to replace the co-signer with an
on-chain check before notes are used for real amounts.

## Stability pool: the return for backing (decided 5 Oct 2026, design)

Vault owners get no yield: they keep their BSV's upside and the PNEEs they mint. The stability pool is how anyone else
earns for helping keep notes backed, without a promised rate (modelled on Liquity's Stability Pool).

- **Deposit**: anyone deposits PNEEs into the pool and can withdraw what's left at any time. No lock, no stated rate.
- **Liquidation**: when a vault falls below 150%, the pool repays (burns) the vault's PNEEs from deposits and takes the
  vault's BSV at the 10% discount. Each depositor's PNEEs shrink and their BSV grows, pro rata to their share.
- **Return**: the discount. Repaying $100 of notes gets about $110 of BSV, so depositors gain when vaults are
  liquidated, and only then. No liquidations means no gain, and a crash fast enough to leave a vault below 100%
  means a loss.
- **Order**: the pool liquidates first. Outside keepers (`pnpm bond liquidate`) only step in when the pool is empty
  or too small.
- **On chain**: the pool is one contract output holding pooled PNEEs plus a running "product/sum" record, so deposits
  and gains can be counted without touching every depositor. Withdrawals pay PNEEs and BSV out together.
- **Wallet**: Exchange › Bonds › Stability pool: deposit, balance (PNEEs + BSV gained, in dollars), withdraw.
  The PNEEs card's Back PNEEs sheet shows it as the second way to back notes.

Same trust gap as vaults: the pool can't yet prove by script that the burned PNEEs were real, so the issuer co-signs
pool liquidations until the on-chain burn check exists.

Legal: depositors are paid for doing a job (absorbing bad vaults), not promised a return, which is why this beats a
savings bond. It still needs legal review before it opens to the public, and store editions stay browse-only.
Not offered: interest on minting and fixed-rate PNEE savings bonds (options 2 and 3); they are closer to a security.

## Watching: Shieldpool (removing the co-signer)

[Shieldpool](https://shieldpool.net) (Werkswinkel / twostack, MIT + Apache, testnet pre-release 0.2.0 as of Oct 2026) is
a shielded payment pool for BSV. It verifies a STARK proof in script, in the same transaction that moves the money
(a 1.78 MB verifier in its own slot tx), so its coordinator can stall the pool but can't take funds.

Why it matters here: it shows a BSV script can check a proof about other transactions. That is a possible route to
the vault's and the stability pool's missing check (were the burned PNEEs real?) without the issuer co-signing.

Not ready for us: testnet only, a handful of transfers, CLI only (Dart/Rust, no JS SDK), ~94k sats per round, and a
private-payments product would draw regulator and app-store attention (never in the store edition).
Next: watch for a mainnet pool and a usable library; ask the developers whether their verifier could check our
vault and pool rules. Unverified until we read their code (tstokenlib, twostack/pool-coordinator).

## Steps

1. Note token: deploy `$PENNY` (BSV-21, 2 decimals), supply held by the vault issuer key; release on mint, burn on close.
2. Vault contract: fee 0 default, `unitCents` 1, mint tied to a note release in the same tx.
3. Wallet: Penny Notes card (balance in dollars), send by name, receive, pay. Open / top up / close a vault from the
   Bonds tab; vault health (ratio) shown in dollars.
4. Stability pool: contract, `pnpm bond pool deposit|withdraw|liquidate` in the pilot, then the wallet screen.
5. Mainnet pilot with tiny amounts (owner approval each time), then independent price signers, then a review of the
   scripts before any meaningful amount.
