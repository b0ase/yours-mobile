# Brief: unjam the browser OpNS minter (cloud session)

GitHub repo **bitcoin-corp/bwallet**, branch **main** (the owner's Mac has it as `/Volumes/2026/Projects/bwalletX`
branch `bwallet`, remote `bcorp`; `b0ase/yours-mobile` branch `bwallet` is the same code). Work on a branch off
`main`, open a PR, and merge it yourself when all gates pass (owner rule). pnpm only. Never touch keys, never
spend, never run a live mint. The owner then runs `git pull bcorp main` on the Mac and deploys.

## Symptom (owner, 13 Oct 2026)

desktop.bwalletx.com/bmint/opns, owner account `b0aseX`. Every name now ends with:

> danielwagner — Waiting · The name tree for "danielwagner" is still catching up with your last mints. Wait for them
> to confirm (about 10 minutes), then try again.

It has said that for hours; reloading and redeploying change nothing. Console saved at
`/Volumes/2026/Projects/bwalletx-x/delete-me-2` (545 lines): repeated `[OneSatServices] getMerklePath error: not found`
from `isMined`, plus CORS errors for `push.bwalletx.com/config.json` (separate, already fixed server side).

## Evidence

The console names 14 txids the wallet is waiting on. WhatsOnChain (`/v1/bsv/main/tx/hash/<txid>`) on 13 Oct:

| status                      | txids                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| on chain (200)              | 14467f50…c9217, 55fe86d1…c230a, 90c0b3dc…c41e1                                                                                                     |
| never seen (404)            | 0815e7c1…dfc896, 229814b3…792e2, 23878148…3fa9b, 29a9d9a4…63753, 77f3659f…95bde, a128ae0c…2cdbd63, afc97599…4e892, b1a18a16…30659a, bcf938b3…6c5b9 |
| rate-limited, unknown (429) | 27b19b19…9605, 9aa42350…8ac59                                                                                                                      |

Full ids: `grep -oE "txid: [0-9a-f]{64}" delete-me-2 | sort -u`.

So most of the wallet's "last mints" never reached the network (broadcast failed or was rejected), but the local
mine-tree cache still treats them as ours. `ordinals.1sat.app` (the names overlay) was also returning 502 all afternoon.

## Where the code is

- `src/mobile/names/opnsRegister.ts`: `mineName` → `pickNode`, `catchingUp(name)` thrown at two places
  (no usable node although the indexer has one; claimed-char loop > 3 retries). `tree.isOurs`, `tree.isSpent`,
  `childOf`.
- The local mine-tree cache (`tree`) and `isMined` / `getMerklePath` polling: follow the imports from opnsRegister.ts
  (`src/mobile/names/opns*.ts`, `src/mobile/names/mineTree*.ts` or similar).
- Page: `src/mobile/names/OpnsMintPage.tsx` (batch, Resume, status lines).
- Headless CLI equivalent (works, for reference): `/Volumes/2026/Projects/bwalletx-cli/src/opns/{headless,batch,opnsRegister}.ts`.

## What to build

1. **Detect transactions the network never received.** After broadcast, and on every Resume / page load, check each
   cached unconfirmed txid against WhatsOnChain (and/or ARC status). A txid that is unknown after ~2 minutes (and not
   just rate-limited: treat 429 as "unknown, retry later", not "missing") is dead: remove its nodes from the local
   tree cache, forget the name as "ours", unlock any reserved UTXOs, and mark the name as `pending` again.
2. **Say which it is.** Replace the single "still catching up" line with three honest states:
   - _Confirming_ (tx seen in mempool, not yet indexed): keep the wait wording, show the txid short form.
   - _Never reached the network_ (404 after the grace period): "Your last mint of X never reached the network. It has
     been released; Resume mines it again." Then actually do that.
   - _Names server down_ (overlay 5xx / timeout): "The names server isn't answering (ordinals.1sat.app). Resume later."
     Don't blame the tree.
3. **Names mined elsewhere since.** The owner's CLI (agent account `opns`) has now minted some of the same names
   (e.g. danielwagner, davidcase, lukerohenaz, richardboase). The browser page must treat those as _taken_ (or
   "yours, in another account" when the owner address matches) and move on, not retry forever.
4. **Tests** in `src/mobile/names/*.test.ts` for the three states and for the dead-tx eviction.

## Gates (all must pass before merge)

`pnpm run format:check` · `pnpm typecheck` · `pnpm lint --max-warnings 0` · `pnpm test` · `pnpm build:mobile` ·
`pnpm build:mobile:store` + the store greps in `docs/STORE-AUDIT.md` (no buy/sell/offer wording in `build-mobile/`)
· `pnpm build:mobile` again. Then merge the PR into `main`. Put a short summary of what changed and the merge commit
in the PR description. The owner pulls and deploys with the Dock app "Deploy bWalletX".

Do not touch `~/.bwalletx/` or the running CLI job on the owner's Mac.
