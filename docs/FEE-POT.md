# Fee pot: network fees on us

Owner approved 12 Oct 2026. **Off by default** (`VITE_FEE_POT=1` in the wallet, `FEE_POT_ENABLED=1` on the bMusic
server) and never in a store build. Nothing here goes live until the owner says the shared server is clean.

## What it pays

Only the **network fee** of an action the user has already approved. Never the value sent, never a token, never
another output. The user signs their own inputs; the user keeps their keys.

Covered:

| Kind                                                                 | Who       | When                                                       |
| -------------------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| `post`, `like`, `message`, `room-join`, `handle-claim`, `bpics-mint` | new users | first 30 days from account creation                        |
| `artist-play`                                                        | anyone    | bMusic artist sponsorship plays (docs/ARTIST-PROGRAMME.md) |

## Caps (all checked before anything is signed)

| Cap                  | Value                                                    | Where                      |
| -------------------- | -------------------------------------------------------- | -------------------------- |
| Per user per UTC day | 200 actions                                              | `MAX_ACTIONS_PER_USER_DAY` |
| Per action           | 500 sats fee max (bigger txs are the user's to pay)      | `MAX_FEE_SATS_PER_ACTION`  |
| Per month, all users | `FEE_POT_MONTHLY_SATS` (default 50,000 sats ≈ $10/month) | server env                 |
| Fee rate             | 100 sat/kB                                               | `FEE_RATE_SAT_PER_KB`      |

Rules: `src/mobile/feePot/feePot.ts` (tested in `feePot.test.ts`); the server mirrors them in
`bitcoin-music lib/feepot/limits.ts` and is the authority.

## How it composes with BRC-100 `createAction` (sponsor-input pattern)

We picked **"the service adds one input and its own change, then signs only that input"** over a
post-signing "child pays for parent" or an `ANYONECANPAY` scheme because:

- BRC-100 already supports external inputs (`inputs[]` with `inputBEEF` and `unlockingScriptLength`) and deferred
  signing (`options.signAndProcess: false` → `signableTransaction` + `reference`, then `signAction`). No wallet
  changes to the signing model; every BRC-100 wallet can do it.
- Every signature (user's and the pot's) is a normal `SIGHASH_ALL|FORKID`, so nobody can add or move outputs after
  either side signs.
- The fee is exactly the pot input's value minus the pot's change output, so the wallet adds no fee of its own and
  the service can check the amount without trusting the wallet.

Flow:

1. **Reserve** `POST /api/feepot/reserve {kind, identityKey, txBytes, timestamp, sig}`. `sig` is the identity
   key's BRC-43 signature (protocol `[2,'bwx feepot']`, key `1`, counterparty `anyone`) over
   `bwx-feepot|v1|reserve|kind=…|identityKey=…|bytes=…|timestamp=…`. The service applies the caps, picks a pot UTXO
   of value V, and returns `{outpoint, inputBEEF, satoshis: V, changeLockingScript, changeSatoshis: V − fee,
feeSats, reservation}`. The UTXO is held for 60 s.
2. **Build** `createAction` with the user's outputs, plus `inputs: [{outpoint, inputBEEF, unlockingScriptLength: 107}]`
   and `outputs: [... , {lockingScript: changeLockingScript, satoshis: changeSatoshis}]`, `signAndProcess: false`.
3. **Co-sign** `POST /api/feepot/cosign {reservation, tx}`. The service finds its input and its change output and
   refuses unless `V − change ≤ feeSats ≤ 500` (`contributionOk`) and the reservation is live and unused. It
   returns only `{vin, unlockingScript}` for its own input. The reservation is then spent; usage is counted.
4. **Sign** `signAction({reference, spends: {[vin]: {unlockingScript}}})`. The wallet signs the user's inputs and
   broadcasts.

If any step fails the wallet does the action the normal way (the user pays the fee). Client:
`src/mobile/feePot/client.ts`.

## Keys

The pot key is read **only** at runtime from the server env var `FEE_POT_WIF`. It is never in code, config
defaults or git; `.env.example` has a placeholder. The owner generates it, funds its address, and sets it in
Vercel. Rotate by setting a new key and sweeping the old address.

## What the owner does

1. Say the server is clean.
2. Approve and run `supabase/migrations/20261014b_feepot.sql` (bitcoin-music).
3. Generate a key, set `FEE_POT_WIF` and `FEE_POT_MONTHLY_SATS` on the bitcoin-music Vercel project, fund the address
   (≈ $10/month).
4. Set `FEE_POT_ENABLED=1` on the server, then build the wallet with `VITE_FEE_POT=1`.
