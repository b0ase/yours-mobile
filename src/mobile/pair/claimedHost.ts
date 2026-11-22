/**
 * The relay's origin is only a header (any non-browser client can set it), and origin proofs are no longer trusted
 * (review 3, 22 Nov 2026), so every sheet and list that names a paired site names it as a claim (review 4).
 */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The phone-signing pad's note (BitsignHost): where the drawing goes, as a claim. */
export const drawNote = (origin: string, review: boolean) =>
  `Sends only this drawing to a site that claims to be ${hostOf(origin)}. ${
    review ? 'You approve the seal and its fee next.' : 'No keys, no payment.'
  }`;

/** Paired websites (PairedSitesList): a site's line. An old stored `proven` flag is ignored. */
export const pairedSiteLabel = (s: { origin: string }) => `claims to be ${hostOf(s.origin)}`;
