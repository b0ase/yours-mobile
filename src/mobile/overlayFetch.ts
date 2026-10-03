import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * 1Sat overlay submissions (POST api.1sat.app/…/overlay/submit) carry an `x-topics` header that
 * api.1sat.app leaves out of Access-Control-Allow-Headers (checked 3 Oct 2026). A browser or
 * WebView therefore blocks the request ("Failed to fetch"), so bought and sent BSV-21 tokens were
 * never handed to the indexer and didn't show up. On a phone, send just these requests through the
 * native HTTP stack (no CORS); everything else still uses the WebView's fetch.
 */
export const goesNative = (url: string, method: string, headers: Headers): boolean => {
  if (method.toUpperCase() !== 'POST' || !headers.has('x-topics')) return false;
  try {
    const u = new URL(url);
    return u.hostname === 'api.1sat.app' && u.pathname.endsWith('/overlay/submit');
  } catch {
    return false;
  }
};

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function installOverlayFetch(native = Capacitor.isNativePlatform()) {
  if (!native) return;
  const webFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!goesNative(req.url, req.method, req.headers)) return webFetch(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const res = await CapacitorHttp.request({
      method: 'POST',
      url: req.url,
      headers,
      data: toBase64(new Uint8Array(await req.arrayBuffer())),
      dataType: 'file',
      responseType: 'text',
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null);
    return new Response(body, { status: res.status, headers: res.headers });
  };
}
