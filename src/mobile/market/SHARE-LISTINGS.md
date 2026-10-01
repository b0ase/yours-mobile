# Share offers (Market → Tokens → Shares 🔒)

Two gates apply before anything is shown: a valid KYC certificate (step 1), then a current
investor self-certification (step 2). Until both pass, the chip shows a locked panel and no
offer details.

The offers are pre-launch. No price appears anywhere and there's no Buy button. Each offer has
**Register interest** instead, which sends a signed (identity key, offer id, timestamp) to
bit-sign at `POST /api/bitsign/share-offers/events` so bCorp can follow up about an allocation.
`PURCHASE_BLOCKED_COUNTRIES` in `src/mobile/kyc/config.ts` (empty by default) disables
Register interest only. It never hides an offer.

Audit: each qualification, each section view (with the offer ids shown) and each interest goes
to bit-sign (`bct_share_offer_events`) and to a local log (`bwallet.kyc.audit.<identityKey>`).

## Sources

- **bCorp**: `shareListings.json` (`section: "bcorp"`). The class size and company number are
  placeholders.
- **bApps**: one alphabet-share offer per bApp, generated from `src/mobile/bapps.ts` plus
  bWallet. Class letters ("Class W — bWallet"), ids (`bapp-<name>`) and the class size are all
  placeholders. Status is `pre-launch`.
- **Other companies**: `shareListings.json` (`section: "other"`), behind `SHOW_OTHER_COMPANIES`
  (off by default). Rows show only when `issuerVerified` is true. They get a grey Third-party
  badge and the notice "Offer terms, statements and promises are the issuer's responsibility;
  The Bitcoin Corporation does not endorse or verify them."

There's no live listing source yet. bit-sign ticker rooms all default to protocol `'403'`, so
that field doesn't identify bCorp shares.

## Issuer onboarding (not built yet)

Before a third-party offer can set `issuerVerified: true`, the issuer needs:

1. KYB of the issuing company (company number, registered office, PSCs).
2. KYC of each director (the same Veriff flow investors use).
3. Upload of the issuer's own offer document, linked as `offerUrl`.
4. Acceptance of the listing terms [LEGAL REVIEW]: who is responsible for the offer, and the
   financial-promotion position for showing it to self-certified investors.

## Nominee and transfer lock

The offers follow the nominee model in `docs/TOKENS-AND-SHARES-HANDOFF.md` §5. Each offer has
`nominee` ("Held via nominee"), `transferLocked` and `lockedUntil` ("Locked until <date>").
A missing `transferLocked` reads as locked.
