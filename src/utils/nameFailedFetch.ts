/**
 * Browsers report any blocked or dropped request as a bare TypeError: "Load failed" on iPhone, "Failed to fetch" in
 * Chrome. Users saw only that, with no clue which service failed (owner, 17 Oct 2026: RelayX importer). Wrap fetch
 * once so the error names the host. It stays a TypeError, because retry code tells network failures apart by type.
 */
export const failedFetchMessage = (input: RequestInfo | URL, original: string) => {
  let host = '';
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    host = new URL(url, globalThis.location?.href).host;
  } catch {
    // Not a URL we can read: keep the browser's own words.
  }
  return host ? `Couldn't reach ${host} (${original}). Check your connection and try again.` : original;
};

export function nameFailedFetch(target: { fetch: typeof fetch } = globalThis) {
  const original = target.fetch;
  if (!original || (original as { named?: boolean }).named) return;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await original.call(globalThis, input, init);
    } catch (e) {
      if (e instanceof TypeError && !e.message.startsWith("Couldn't reach"))
        throw new TypeError(failedFetchMessage(input, e.message));
      throw e;
    }
  }) as typeof fetch & { named?: boolean };
  wrapped.named = true;
  target.fetch = wrapped;
}
