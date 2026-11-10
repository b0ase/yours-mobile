# The b\*X standard: one way to launch anything

Owner, 10 Nov 2026: "the product is the contracting platform we've built in bChatX and bWalletX." Every b\*X site
(bGamesX, bMusicX, bMoviesX, bWebX with bDNSX, and most others) is a front door onto that platform for one kind of
thing. A creator launches their thing the same way on every site, with one onboarding package. Not every b\*X site
needs all of it; most will.

## The package

| Step                  | What happens                                                                                                                                                                                                                     | Where it lives                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1. Connect            | The creator connects bWalletX. Their own paymail (`name@bwalletx.com`) is the payee **by default**. A creator with no paymail claims one first. It is never our address.                                                         | bWalletX (Connect, BRC-100)                             |
| 2. The asset on chain | The thing is recorded on chain, signed by the creator: a game repo, a domain, a website, an album, a film. Ownership is proved first (for a repo, a signed file committed to it), so nobody launches someone else's work.        | the b\*X site + bWalletX mint                           |
| 3. A token            | A BSV-21 token for the thing, 1,000,000,000 supply, **all of it minted to the creator's own wallet**. We never hold any.                                                                                                         | bWalletX launchpad                                      |
| 4. A room             | A bChatX room for the thing: where work is agreed, questions asked, deliveries announced.                                                                                                                                        | bChatX                                                  |
| 5. Contracts          | The creator offers work for a share of the token ("build this level for 1% of the game's token"). The tokens sit in escrow (multisig) for the contract and are released to the contributor when the work is delivered or merged. | bChatX rooms (bounties, GitHub links) + bWalletX escrow |
| 6. Sales              | Buyers pay the creator's paymail directly from their own wallet: once (an album, a game, the right to listen) or as they use it (about 1p an hour).                                                                              | bWalletX payments                                       |
| 7. Investors          | Registered investors can buy into the thing. Shown only to people who registered as investors under an exemption that applies, and only once the FCA route for third-party offers is in place (see below).                       | bWalletX + $403                                         |

The package is priced once per launch. bGamesX: **$9.99** for the repo record, the token, cover art, music and the
room. Each site sets its own price for its asset type; costs are shown up front in dollars and paid in BSV at the
moment of approval.

## Rules every site follows

- **The creator owns everything from their own wallet.** We never hold keys, tokens or earnings.
- **One approval per payment.** One sheet, never a chain of prompts.
- **The creator's paymail is paid by default** for sales, plays and tips, resolved at payment time.
- **Status shown honestly.** A step that isn't live says "coming soon" on the page; nothing is described as live
  before it is.
- **Investment offers stay off** until the route is in place. Third-party raises (other people's games, sites,
  albums) are likely "arranging deals in investments" and need FCA authorisation or Appointed Representative
  status with an authorised firm. Our own companies' raises can use the self-certified sophisticated / high-net-worth
  investor exemptions. Owner, 10 Nov 2026: no lawyer, play it ultra safe.
- **Wording:** contracts pay "a share of the token". Investment wording appears only in the investor step, only for
  registered investors.

## How to build a site to the standard

Build the package once and reuse it: signing, escrow and payments are shared bWalletX parts; rooms and contracts are
shared bChatX parts. A site supplies only its asset type, its ownership check, its page design and its price.
bGamesX is the first instance (onboarding design: `bGamesX onboarding.md`; console v0 on bx-holding
`feat/bgamesx-console`). bMusicX and bWebX follow.

## Status (10 Nov 2026)

| Part                                | Status                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Connect, paymail as payee           | Live (bWalletX Connect)                                                   |
| Asset on chain (mint)               | Live in the wallet; per-site ownership checks being built (bGamesX first) |
| Token, 100% to creator              | Live (wallet launchpad); package checkout coming soon                     |
| Rooms                               | Live (bChatX)                                                             |
| Contracts with escrow paid on merge | Coming soon (rooms already carry bounties and GitHub links)               |
| Sales: pay once                     | Being built (bMusicX right to listen: $9.99 album, $1 track)              |
| Sales: about 1p an hour             | Coming soon (one shared meter, BRC-121 payments)                          |
| Investors                           | Off until the FCA route exists                                            |
