/**
 * Who may act as the wallet itself (security review H1).
 *
 * The admin originator (chrome.runtime.id, or 'yours-mobile' on the phone) skips every
 * permission prompt. It used to be granted to anyone whose originator string equalled it, and
 * a web page's originator is its host — so a page served from http://<extension-id>/ or
 * http://yours-mobile/ passed the origin cross-check and became the wallet. Admin status now
 * comes ONLY from the sender being the extension's own pages; a web sender naming the admin
 * originator is refused outright.
 */

/** The web/phone builds' stand-in runtime id (src/mobile MOBILE_EXTENSION_ID). */
export const MOBILE_RUNTIME_ID = 'yours-mobile';

export type MessageSender = { id?: string; origin?: string; url?: string };

/** The sender is one of the extension's (or mobile app's) own pages, not a web page. */
export const isExtensionSender = (sender: MessageSender | undefined, runtimeId: string): boolean => {
  if (!sender || !runtimeId) return false;
  const base = `chrome-extension://${runtimeId}`;
  if (sender.id !== runtimeId) return false;
  if (sender.origin !== base) return false;
  // Identity is id + origin. On the real extension both come from Chrome. In the web/phone builds
  // the hub stamps them (src/mobile/main.ts senderFor) and sender.url is the page's real address
  // (https://web.bwalletx.com/…, capacitor://…), so the URL must not be required to share the
  // chrome-extension:// prefix. Web pages and bApp frames never get this origin: the hub gives them
  // their own https origin (dappBrowser), which is what blocks the H1 spoof.
  // On the real extension a URL, when present, must still be one of ours.
  if (runtimeId !== MOBILE_RUNTIME_ID && sender.url !== undefined && !sender.url.startsWith(`${base}/`)) return false;
  return true;
};

/** Error text when a non-extension sender claims the admin originator, else null. */
export const reservedOriginatorRefusal = (
  fromExtension: boolean,
  originator: unknown,
  adminOriginator: string,
): string | null => {
  if (fromExtension) return null;
  if (typeof originator === 'string' && originator.trim().toLowerCase() === adminOriginator.toLowerCase()) {
    return 'Reserved originator';
  }
  return null;
};

/** A dApp host that would collide with the admin originator (mobile in-app browser / bApp frames). */
export const isReservedHost = (host: string, adminOriginator: string): boolean => {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const bare = h.replace(/:\d+$/, '');
  const a = adminOriginator.toLowerCase();
  return h === a || bare === a;
};
