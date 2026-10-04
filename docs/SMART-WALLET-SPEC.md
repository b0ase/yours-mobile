# Smart bWalletX: agents, strategies, encrypted NFTs and the bWalletX CLI

Status: **design, not started** · Owner decisions: 4 Oct 2026 · bWalletX only (not in the store bWallet)

## Why

Plenty of wallets will be social. bWalletX should also be **smart**: AI agents act for the user, including
trading, inside limits the user sets. Agents should be usable from the app, from a terminal, and from
other AI agents.

## Contents

1. Agent accounts
2. Agents (one or many)
3. Strategies are programs
4. The b agent in the app
5. The bWalletX CLI
6. MCP (Claude and other agents)
7. Market › Strategies
8. Encrypted NFTs (strategies, paid and adult media)
9. Rules we follow
10. Build order
11. Open questions

---

## 1. Agent accounts

An **agent account** is a wallet account that an agent may act on without asking each time.

- **Fresh keys.** Each agent account gets its own new keys. They are not derived from the user's 12 words,
  so a leaked agent key, for example on a server running the bWalletX CLI, can't touch the main wallet.
- **The balance is the budget.** The user moves money in ("fund"), and the agent can only spend what is
  there. Pulling money back is **Sweep back**: everything returns to a chosen account in one transaction.
- **Visible.** Agent accounts show in the account list with an **AGENT** badge and their labels.
- **Stop.** Each account has a Stop button, and Settings has **Stop all agents**. A stopped account rejects
  every agent action until the user resumes it.
- **Activity log.** Every agent action is recorded with time, what it did, the transaction id and which
  strategy rule caused it. The log lives on the device, is exported with the account, and is also
  written to the agent account's own storage so the CLI can read it.
- **Optional daily cap.** A per-account limit in dollars per day. It's off by default, because the
  balance is already the limit.
- **Labels.** Free text such as "long-term", "degen" or "$B0ASEX fund". Labels are for people; they
  change nothing.
- **Identity, optional.** An agent account can claim a name, mint its $NAME token and open a room like
  any account (`myagent@bwalletx.com` → $MYAGENT).

Backup: an agent account's keys are included in the wallet's encrypted backup, and the account can be
exported as a key file for the CLI (see §5).

## 2. Agents

An **agent** is an AI worker with a name, an AI provider and a set of accounts it may act on.

- **One agent per account**, or **one agent across several accounts.** The user picks which accounts an
  agent can see. An agent never sees the main wallet unless the user explicitly adds it.
- **Several agents at once**, for example a *Trader* on two strategy accounts, a *Treasurer* that tops them
  up from a savings account, and a *Reporter* that can only read.
- **Permissions per agent per account:** `read` (balances, history), `trade` (Market buy/sell/list),
  `send` (to addresses or names), `mint`, `rooms` (join, post). Defaults: read + whatever the account's
  strategy needs.
- **Where an agent runs:** in the app (§4), in the bWalletX CLI (§5) or through MCP (§6). It's the same
  agent definition, accounts and strategies everywhere.

## 3. Strategies are programs

A **strategy** is a program the agent follows. It's no different from any other software: you load it
into an account and that account's agent runs it, with your money, in your account.

A strategy file contains:

- **Goals** in plain language, which the AI reads.
- **Rules**: exact settings the wallet enforces regardless of what the AI decides. Examples: allowed tokens,
  buy below or sell above prices, maximum per trade, maximum per day, stop conditions.
- **Spec**: the published description (§7.2).
- **Version** and a changelog. A strategy is versioned like software (v1.0, v1.1).

**Enforcement.** Rules and the spec's limits are checked by the wallet before any action is signed. If
the AI asks for something outside them, the action is refused and logged. The AI chooses *when* and
*whether* within the rules; it can never widen them.

**Loading.** Account › **Load strategy** (app) or `bwalletx strategy load` (CLI). One strategy per account
at a time; an agent on several accounts can run a different one in each.

**Paper mode.** Any strategy can run against live prices with pretend money first, logging what it
would have done.

## 4. The b agent in the app

The b agent (top bar b) is already a chat assistant with the user's own AI key, or paid per message.
It gains:

- **Wallet tools** scoped to the accounts the user gives it (§2 permissions).
- **Strategy design in chat.** The user describes what they want; the agent asks questions and builds the
  strategy, shown as a live card that updates during the conversation. Buttons on the card:
  - **Try on paper**: paper mode (§3).
  - **Run**: load into an agent account.
  - **Publish & sell**: one tap to inscribe and list (§7). The agent pre-fills the spec, and the user
    checks every field.
- **Suggestions.** The b agent may suggest strategies to adopt, including ones on the Market, based on the
  user's stated goals, budget and risk. It's the user's own assistant; bWalletX itself makes no
  recommendations (§8).

## 5. The bWalletX CLI

A command-line tool for people and agents.

```
bwalletx login                       # pair with your wallet (QR / link, like websites)
bwalletx accounts                    # list accounts you've shared with this CLI
bwalletx balance --account trader
bwalletx send 10 B0ASEX richard@bwalletx.com --account trader
bwalletx buy B0ASEX --max-usd 20 --account trader
bwalletx strategy load ./accumulator.json --account trader
bwalletx agent run trader            # run that account's strategy unattended
bwalletx log --account trader
```

Two ways to hold keys:

- **Paired (default).** The CLI pairs with the user's wallet like a website, using the existing pairing
  protocol. Keys stay in the app or extension, and actions outside an agent account's rules prompt for
  approval on the phone.
- **Standalone (agent accounts only).** The CLI holds one agent account's exported key file, encrypted
  with a passphrase, so it can run unattended on a server. Only agent accounts can be exported this way,
  never the main wallet.

Distribution: an npm package (`bwalletx`) and a single binary. Source in a public repo.

## 6. MCP (Claude and other agents)

The bWalletX CLI also runs as an **MCP server** (`bwalletx mcp`), offering the same tools (balance, send,
buy, sell, list, mint, strategy load/run/log) to Claude and any MCP-capable agent. It uses the same
accounts, permissions and rules as the CLI.

## 7. Market › Strategies

A third Market section beside Tokens and NFTs.

### 7.1 Listing and buying

- **A strategy is an encrypted NFT** (§8): the program is locked, so only owners can read and run it. The
  spec is public so buyers can compare before buying. It's signed by its author with the same signed
  creator statement tokens use.
- **Sale types:** one-off price; limited editions ("100 copies"). Buyers own their copy and can resell it.
- **Load after buying:** the strategy appears in the wallet; **Load into account** in one tap. The wallet
  unlocks it (§8) and hands it to that account's agent.
- **Your own strategies load too.** Strategies made in chat or written by hand can be loaded into your own
  agent accounts without buying anything. **Publish & sell** turns one into an encrypted NFT.
- **Social:** the author's name, $NAME token and room link, so buyers talk to the seller directly.

### 7.2 Strategy spec (required to publish)

| Field | Example |
| --- | --- |
| What it trades | $B0ASEX; BSV-21 tokens only |
| **Seller's risk rating** | Low · Medium · High · Experimental |
| Most it will spend | $10/day, $200 total |
| How often it acts | A few times a day |
| When it stops | Holds 100k tokens, or down 30% |
| Needs | Agent account with at least $50 |
| Version / changes | v1.2: tighter stop |

The app checks only mechanical things: every field is filled in, and the program's rules are within the
spec's limits (enforced at run time, §3). Buyers can filter by spec fields.

### 7.3 What a listing shows

The seller's title and description, the spec (risk shown as **"Seller's risk rating"**), and facts: author,
version, price, copies, date. Every strategy page carries:

> Strategies are programs written and sold by users. bWalletX doesn't review, rate or recommend them.

## 8. Encrypted NFTs (strategies, paid and adult media)

An **encrypted NFT** is an inscription whose content is locked: anyone can see it exists and read its
public description, but only its current owner can open it. The same mechanism serves strategies (§7),
paid documents, and paid images and video, including the adult market (§8.5).

### 8.1 Publishing

1. The wallet makes a fresh random **content key** and encrypts the file (strategy program, PDF, image,
   video) with it (AES-256-GCM).
2. The inscription holds:
   - the **encrypted content**;
   - **public metadata**: title, description, spec (for strategies), content type, size, and optionally a
     seller-made **preview** (a blurred image, a clip, or the strategy spec only);
   - the author's signed creator statement.
3. The content key is stored, itself encrypted, with the **bWalletX key service** (§8.2).

### 8.2 Unlocking for the owner

- **bWalletX key service (first version).** To open an encrypted NFT, the owner's wallet proves it holds
  the NFT by signing a challenge with the key that owns it. The service checks on chain that this key
  owns the NFT now, then releases the content key **encrypted to that owner's identity key**, so only their
  wallet can read it. It works with the seller offline, and for every resale: the new owner just proves
  ownership. The service never sees the content, only keys, and it holds no money.
- **Seller-delivered (later).** The seller's wallet, or their bWalletX CLI running as a service, sends
  the content key to each buyer after a sale. Nothing to trust from bWalletX, but the seller must be
  online.

### 8.3 Selling and resale

Listing and buying use the normal Market (OrdLock). After a purchase, the buyer's wallet asks the key
service for the content key. On resale the previous owner loses access to new key requests. They may
still have a copy they already opened (§8.4).

### 8.4 What encryption can and can't do

It stops reading, copying and sharing **without buying**, which is what a market needs. It can't stop a
buyer who has opened the content from copying it; that's true of all software and media. The wallet
keeps opened content in its own storage rather than exporting it by default.

### 8.5 Adult images and video (bWalletX only)

Encrypted NFTs suit an adult market: nothing explicit is public on chain or in the Market. Listings show
only what the seller chooses as a preview, and the content opens only for its owner.

- **bWalletX only.** Never in the store bWallet (App Store and Google Play sexual-content policies). The
  store build hides the category and refuses to open adult content.
- **18+ gate.** Viewing the category, buying and opening require the owner to confirm they're 18 or over;
  stronger age checks (bit-sign KYC) where the law requires them.
- **Labelled by the seller.** An **Adult** flag in the public metadata is required to list in the
  category. The existing safety filter keeps adult listings out of every other category.
- **Report and refuse.** Reported content is reviewed. Because an inscription can't be deleted, the
  enforcement tool is the key service: it **stops releasing keys** for content that's illegal or
  non-consensual, so it can no longer be opened in bWalletX, and the listing is removed.
- **Seller responsibility.** Sellers confirm they own the content and that everyone in it is an adult who
  consented. Check the legal requirements (record-keeping, age verification by country) before launch.

## 9. Rules we follow

- **bWalletX doesn't comment.** No editorial ratings, risk labels of our own, "proven" badges, rankings by
  returns or featured picks on the Market or the website. Users publish and sell, and users buy.
- **Risk labels are the seller's**, from the spec.
- **The b agent may suggest** strategies to its user. It's the user's assistant acting on their goals.
- **Adult content is bWalletX only**, behind an 18+ gate, flagged by sellers, and blocked via the key
  service when reported content is illegal or non-consensual.
- **Strategies are software.** Buyers run them in their own accounts with their own money. bWalletX
  never runs strategies with other people's money or takes a share of their profits; if a future
  feature would, check the rules first.
- **Store builds:** trading, agent trading and Market › Strategies are bWalletX only (App Store guideline
  3.1.5(iii); Google Play's equivalent). The store bWallet may keep the b agent as a helper.

## 10. Build order

1. **Agent accounts**: fresh keys, fund, sweep back, Stop / Stop all, labels, activity log, optional
   daily cap.
2. **Strategies**: file format, rule enforcement, paper mode, Load strategy.
3. **bWalletX CLI**: paired and standalone modes, `agent run`, logs.
4. **b agent in the app**: wallet tools, strategy design in chat, Run / Try on paper.
5. **MCP server**: `bwalletx mcp`.
6. **Encrypted NFTs**: encrypt on publish, key service, unlock for owners (also enables paid media).
7. **Market › Strategies**: spec form, Publish & sell, listings, buy and load.
8. **Adult category** (bWalletX only): 18+ gate, Adult flag, preview, report and key refusal.

Each step ships on its own and is useful by itself.

## 11. Open questions

- **Rule language.** JSON settings plus plain-language goals is the plan. Do we also want scriptable rules
  (a small sandboxed language) for advanced strategies?
- **Where agents run when the phone is asleep.** In-app agents run only while the app or extension is open.
  Unattended running means the CLI on a server. Do we offer hosted agents later?
- **Price data.** Strategies need prices; the Market indexer has them. What rate limits apply?
- **Strategy updates.** When an author ships v1.3, do owners of v1.2 get it free?
- **Paid AI.** Agents in "paid" b agent mode spend from which account?
- **Key service trust.** Should keys be split across several services (threshold), so no single
  operator, including us, can open content alone?
- **Adult market rules.** Which countries, which age checks, and what record-keeping we need before launch.
