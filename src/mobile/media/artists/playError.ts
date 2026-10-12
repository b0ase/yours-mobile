/** Short guest-facing message for a failed track start (play() rejection or media load error). */
export const LOAD_FAILED = "This track didn't load. Try again.";

export const playErrorMessage = (err: unknown): string =>
  (err as { name?: unknown } | null)?.name === 'NotAllowedError'
    ? 'Your browser blocked playback — tap Play again'
    : "Couldn't start playback — tap Play again";
