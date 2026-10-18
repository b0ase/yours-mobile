# Share offers (Market › Shares 🔒)

**Restricted (18 Oct 2026).** Showing share offers to the public could count as an invitation to invest, so:

- **No offer details ship in the app.** The static `shareListings.json` and the generated bApps alphabet-share
  offers are gone, as is the general "Register interest" button.
- **The server decides.** `SharesPanel.tsx` calls bit-sign `GET /api/bitsign/bshares/me` (the same check bShares
  uses). A 401/403 (not on the register and not a director) shows only "Members only".
- **Members see their own bCorp tranches only.** `/me` returns `offers`; `sharesView.ts` keeps only those whose
  `investorHandle` is the signed-in handle (directors manage every tranche in bShares, not here). With none, the
  panel says "Your offers appear here when the company makes one out to you."
- **Third-party issuers stay off** (`SHOW_OTHER_COMPANIES = false` in `src/mobile/kyc/config.ts`).

`sharesView.test.ts` checks that a non-member gets no offer data, and that neither the source nor the built web
bundle (`build-web/`, when present) contains the removed offer strings.
