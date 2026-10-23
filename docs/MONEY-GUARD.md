# Money guard

Two safety nets for a wallet shipped as six builds (web, extension, Android direct, Play, iOS store, iOS private).
Releases are slow, and the mistakes that cost the most are the ones that lose access to money.

## 1. Kill switches: pause a feature without a release

`src/mobile/config/killSwitch.ts`. Every build reads `https://bwalletx.com/status.json`, checks it again at most
10 minutes later, and pauses whatever the file lists.

| Feature         | What it stops                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spending`      | Every payment: sends, tips, locks, token sends, dApp payments, background jobs. It wraps the wallet's `createAction` and `signAction`, which every payment goes through. |
| `passkeyCreate` | "Create my passkey" on sign-up.                                                                                                                                          |

Nothing that gets people back to their money can be paused: unlock, Show my 12 words, backups and restore
(including restore with a passkey). Receiving and balances keep working while `spending` is paused.

The message people see is built into the app: "Paused for a fix. Your money is safe. Please try again soon." The
file can't change it, so a tampered file can't put a scam message in the wallet. If the file is missing or broken,
or the network is down, nothing is paused.

### To pause

In `bwalletx-site`, edit `status.json`, commit and push to `main` (Vercel deploys it in about a minute):

```json
{ "paused": ["spending"] }
```

To pause only the builds with the bug, name their versions:

```json
{ "paused": [{ "feature": "spending", "versions": ["5.2.39"] }] }
```

Wallets pick it up within about 10 minutes, or at once after a restart. To lift the pause, set `"paused": []` and push.

## 2. Money code needs the owner's OK

- **Known-answer tests** (`src/moneyGuard/golden.test.ts`): fixed inputs (the public BIP39 test phrase, fixed
  passwords and a fixed passkey output) must give the same addresses, passwords and decrypted backups as 5.2.39
  did. If one fails, a change has moved addresses or broken old passwords or backups. **Never edit the expected
  values to make a test pass**; find out what changed. They run with every other test in CI.
- **The `money-ok` label** (`.github/workflows/money-guard.yml`): a pull request that touches a file listed in
  `.github/money-paths.txt` (keys, passwords, keystore, backups, restore) fails the "Money guard" check until the
  owner has reviewed it and added the `money-ok` label. Claude never adds this label itself.
