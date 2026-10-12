/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WOC_API_KEY: string;
  /** '1' = App Store / Google Play build (src/mobile/storeBuild.ts). */
  readonly VITE_STORE_BUILD?: string;
  readonly VITE_CHANNEL?: string;
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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
