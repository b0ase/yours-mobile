/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WOC_API_KEY: string;
  /** '1' = App Store / Google Play build (src/mobile/storeBuild.ts). */
  readonly VITE_STORE_BUILD?: string;
  readonly VITE_CHANNEL?: string;
  /** bMint note studio allow-list: identity pubkeys or identity addresses, comma-separated (bmint/lib/studioAccess.ts). */
  readonly VITE_BMINT_STUDIO_KEYS?: string;
  readonly VITE_OPNS_FEE_ADDRESS?: string;
  /** Live chat relay base URL (src/mobile/chat/live.ts); default https://rt.b0ase.com. */
  readonly VITE_RT_URL?: string;
  /** '0' = build without the live chat stream. */
  readonly VITE_LIVE_CHAT?: string;
  /** bMusic server base URL (src/mobile/media/stream/api.ts). */
  readonly VITE_BMUSIC_URL?: string;
  /** '1' = show the bMusic artist programme (off by default; needs the server). */
  readonly VITE_ARTIST_PROGRAMME?: string;
  /** '1' = ask the fee pot to pay network fees (off by default; needs the server). */
  readonly VITE_FEE_POT?: string;
  /** Phone to phone direct pay prototype (storeBuild.ts DIRECT_PAY_ENABLED); "1" to turn it on. */
  readonly VITE_DIRECT_PAY?: string;
  /** Comma-separated STUN urls for phone to phone; default stun:stun.l.google.com:19302. */
  readonly VITE_DIRECT_PAY_STUN?: string;
  /** '1' = show "Find people you follow on X" (off by default; needs bit-sign #295 turned on). */
  readonly VITE_X_FOLLOWS_IMPORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
