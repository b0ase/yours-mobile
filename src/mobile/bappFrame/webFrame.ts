import { BAPPS } from '../bapps';
import { STORE_BUILD } from '../storeBuild';
import { frameAllowlist } from './frameBridge';

/**
 * bApps that also run in-frame in the web and Desktop wallets (web.bwalletx.com, desktop.bwalletx.com). A browser
 * can't read another site's headers (CORS), so these are not probed: the site itself promises, with CSP
 * frame-ancestors, to let the wallet frame it (bapps.ts webFrame). Every other bApp opens in a new tab on the web.
 */
export const WEB_FRAME_ORIGINS = frameAllowlist(
  BAPPS.filter((a) => a.webFrame && !a.noFrame && !(STORE_BUILD && a.privateOnly)).map((a) => a.url),
);

export type FrameShell = { native: boolean; extension: boolean };
/** How a bApp opens in this shell: 'frame' (probe headers first on native/extension), 'trusted' (web, no probe) or 'tab'. */
export const frameModeFor = (origin: string | null, shell: FrameShell): 'frame' | 'trusted' | 'tab' => {
  if (!origin) return 'tab';
  if (shell.native || shell.extension) return 'frame';
  return WEB_FRAME_ORIGINS.has(origin) ? 'trusted' : 'tab';
};
