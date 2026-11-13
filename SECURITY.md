# Security policy: b-Aware

bWallet and bWalletX are non-custodial BSV wallets published by The Bitcoin Corporation Ltd. If you find a way to
take or spend someone's money, read their keys, or make the wallet sign something its owner did not approve, we want
to hear from you first, and we pay for it.

The full policy, the reward table and our responses to advisories live at **https://bwalletx.com/b-Aware**
(machine-readable: `/.well-known/security.txt`). This file is the short form of policy version 5 (13 November 2026).

## Report a vulnerability

- Check **https://bwalletx.com/bugs** first. Known and already-fixed issues are listed there and earn credit, not
  money. Still-unfixed security issues are not listed, for safety; if yours looks serious and is not there, report it
  privately as below.
- Email **support@bwalletx.com** with the subject line `b-Aware`. Put the full report in the mail; we do not need a
  video, we need steps we can run.
- If the finding would let an attacker move funds or read keys, say so in the subject so it is read first.
- Do not open a public GitHub issue for a security finding. Ordinary bugs go to
  https://github.com/bitcoin-corp/bwallet/issues.

We acknowledge within 2 working days, give you a severity and a fix plan within 7 days, and tell you when the fix ships.
With your permission we credit you on the b-Aware page.

## Rewards (paid in BSV)

| Severity | What it looks like in bWallet                                                                | Reward  |
| -------- | -------------------------------------------------------------------------------------------- | ------- |
| Critical | Steal or spend funds, extract keys or the recovery phrase, sign without the owner's approval | 10 BSV  |
| High     | Bypass an approval or permission, forge a pairing or connection, drain via a dApp endpoint   | 3 BSV   |
| Medium   | Leak private data, defeat the safety filter, deny a user their own wallet                    | 0.5 BSV |
| Low      | Real but contained                                                                           | Credit  |

The reward pool is **20 BSV per calendar quarter**. First valid report of an issue wins; duplicates, issues we already
know about and issues listed under "Known and accepted" on the b-Aware page earn credit, not money. When the quarter's
pool is spent, valid reports still get credit and are paid from the next quarter's pool, in order. Severity is ours to
set, by impact on users' money and keys; we explain the reasoning in writing.

Rewards are paid in BSV to an address you give us, within 14 days of the fix going live, or within 30 days of triage
if the fix takes longer, whichever is sooner. These are the same terms as the b-Aware page. Where two published terms
conflicted, the better one is honoured for everyone who reported while both were up.

We pay people we can name, and we record every payout: who, which address, how much, and the transaction. Under
1 BSV, a stable handle and a paymail or address is enough. For 1 BSV or more (every High and Critical), you need to
verify your identity with Veriff in bWallet, and we pay only to an address of the wallet that holds that verified
identity; a typed name and country is no longer enough. The reward is held for you until you verify.

To verify, open bWallet and go to Settings › Identity › Verify your identity (or use the account page on bChatX); it is
a two-minute ID check. We never see your ID documents: Veriff holds them, and your wallet keeps only a signed
certificate that says you are verified.

This rule applies to every unpaid reward of 1 BSV or more from 26 October 2026, including reports made before then.
Anonymous reporters still get credit, but not payments of 1 BSV or more. The programme has a fixed budget. If it runs out,
we'll say so on this page before we accept new reports. Reports already accepted are paid on the terms above.

## Scope

In scope: key handling, signing and approvals (`src/background.ts`, `src/services/`, `src/security/`), storage and
backup, the BRC-100 dApp bridge (`src/inject.ts`, `src/content.ts`, `src/mobile/dappBrowser.ts`, the hub), paymail,
OpNS names, the mobile apps, the extension and the web wallet.

Out of scope: the marketing sites, rate limiting, self-XSS, findings that need a rooted or jailbroken device or
physical access, social engineering of our staff or users, automated scanner output without a working reproduction,
and third-party services we do not run (indexers, exchanges, the Yours Wallet upstream).

## Safe harbour

Research done in good faith under this policy is authorised. We will not pursue or support legal action against you
for it, and if a third party does, we will say so publicly. Good faith means: test against your own wallets and funds,
do not access, modify or destroy anyone else's data or money, do not degrade the service for others, and give us a
reasonable time to fix before you publish. We will not ask you to sign anything to get paid.

## Advisories

Our responses to published advisories that touch BRC-100 wallets, the BSV TypeScript stack or our dependencies are
listed, dated, on https://bwalletx.com/b-Aware#advisories.

## Changes to this policy

- 13 November 2026: payout terms aligned to the b-Aware page (`site/b-aware.html`): within 14 days of the fix going
  live, or within 30 days of triage if the fix takes longer, whichever is sooner. This replaces "30 days after the fix
  is live on every channel / 60 days after we confirm your report" and the monthly payment batch. The more favourable
  term applies to every report made while both were published.
- 13 November 2026: version 5. Payment no longer waits for programme funding: the programme has a fixed budget, we
  say so on the b-Aware page before accepting new reports if it runs out, and reports already accepted are paid on the
  terms above.
