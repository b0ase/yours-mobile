// Build-time stand-in for a feature that is switched off in this build (vite.brand.ts). Its callers only use it
// behind a flag that is false here, so nothing below ever runs.
export const startSignedBadges = () => undefined;
export const installSignedBadges = () => undefined;
export const SignedPostRequestPage = () => null;
