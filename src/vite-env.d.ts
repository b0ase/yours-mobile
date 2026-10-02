/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WOC_API_KEY: string;
  /** '1' = App Store / Google Play build (src/mobile/storeBuild.ts). */
  readonly VITE_STORE_BUILD?: string;
  readonly VITE_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
