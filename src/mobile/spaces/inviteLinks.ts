/**
 * Space pages, invites and room pages opening the app (invite.ts parses them):
 *   bwalletx://space/<slug>  · https://<host>/s/<slug>  → the Spaces screen on that Space    (BSPACES_ENABLED)
 *   bwalletx://invite/<code> · https://<host>/i/<code>  → counts a use, then the Space or the room
 *   bwalletx://room/<ticker> · https://<host>/r/<ticker> → the room's chat (chat/roomLink.ts)
 *   https://<host>/room/<ref>[?invite=<token>]           → the room's chat; an invite link is claimed first
 * The https forms need universal / app links (docs/BSPACES-PLAN.md, "To make it live").
 *
 * Gating: Space pages only with BSPACES_ENABLED (inlined, so a store build drops them). Room links and room
 * invites open in every build (owner, 2 Nov 2026: a room link lands in that room's chat, like Telegram): only the
 * routing is ungated; a token room still opens only in bWalletX (the store build shows its note, never Buy).
 * A bChatX link this build doesn't open in the app shows in the bChatX frame rather than being dropped.
 * Held until a screen with the router takes it.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BSPACES_ENABLED, XINVITES_ENABLED } from '../storeBuild';
import { offerXInvite, openXInviteInBrowser, parseXInviteLink } from '../chat/xInvites';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { bchatxDoorRoute, bchatxDoorUrl, requestRoomLink } from '../chat/roomLink';
import { openDappBrowser } from '../dappBrowser';
import { isNative } from '../native';
import { parseThemeLink } from '../theme/themeLink';
import { requestThemeSheet } from '../theme/themeNav';
import { parseComposeLink } from '../bmail/meeting';
import { openBMailDraft } from '../bmail/store';
import { appLinkFor, parseSpaceInvite, type PendingLink } from './invite';
import { isSignLink } from '../chat/signLink';

let pending: PendingLink | null = null;
let xPending = false;
const listeners = new Set<() => void>();

/** Accepts a link if this build handles its kind. */
export const offerAppLink = (url?: string | null) => {
  // A "Sign on your phone" QR (/r/<T>?sign=&h=) is chat/useSignLinks.ts's, not a plain room link.
  if (isSignLink(url)) return;
  // bwalletx://theme/<pack> (bwalletx.com/themes Install): Theme › App colours offers that pack, every build.
  const theme = parseThemeLink(url);
  if (theme) return requestThemeSheet(theme);
  // bwalletx://mail/compose?to=&subject=&body= (bChatX meeting invites, owner 26 Oct 2026): Compose, pre-filled.
  // Every build. The user presses Send; nothing is sent from a link.
  const compose = parseComposeLink(url);
  if (compose) return openBMailDraft(compose);
  // Room X invite (…/i/x/<code>#k=…): the key stays in memory until the Chat claim screen takes it.
  // A build without X invites (Play / App Store) never swallows one: bchatx.com's web page opens instead.
  if (!XINVITES_ENABLED) {
    if (url && openXInviteInBrowser(url)) return;
  }
  const x = XINVITES_ENABLED ? parseXInviteLink(url) : null;
  if (x) {
    offerXInvite(x);
    xPending = true;
    listeners.forEach((l) => l());
    return;
  }
  const link = appLinkFor(url, BSPACES_ENABLED);
  if (!link) return;
  pending = link;
  listeners.forEach((l) => l());
};

export const takeAppLink = () => {
  const c = pending;
  pending = null;
  return c;
};

export const onAppLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

// Always listen on device: even a build without these screens must hand /i/x/ links to the browser.
if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offerAppLink(url));
  void CapApp.getLaunchUrl().then((r) => offerAppLink(r?.url));
}

const client = () => new BchatClient(defaultHttp(isNative), loadSession());

/** A bChatX page inside the bChatX frame (its BRC-100 bridge reaches the wallet), else the in-app browser. */
export const openBchatxDoor = (path: string, go: (path: string) => void) => {
  const route = bchatxDoorRoute(path);
  if (route) return go(route);
  go('/m/chat');
  openDappBrowser(bchatxDoorUrl(path)).catch((e) => console.error('[room link]', e));
};

/** The room's chat: the Chatrooms page takes it once signed in (chat/roomLink.ts decides member / invite / door). */
const openRoom = (ref: string, invite: string | null, door: string | null, go: (path: string) => void) => {
  requestRoomLink({ ref, invite, door });
  go('/m/chat');
};

/** Mounted once by the top bar (or PhoneShell): a link goes to its screen. */
export const useSpaceInviteLinks = (enabled = true) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    const go = () => {
      if (xPending) {
        xPending = false;
        navigate('/m/chat');
        return;
      }
      const link = takeAppLink();
      if (!link) return;
      if (link.kind === 'door') return openBchatxDoor(link.path, navigate);
      if (link.kind === 'space') return navigate(`/m/spaces?space=${link.slug}`);
      if (link.kind === 'room') return openRoom(link.ticker, link.invite ?? null, null, navigate);
      // An invite: what it opens is only known from the server (this counts one use).
      void (async () => {
        const inv = parseSpaceInvite(
          await client()
            .openInvite(link.code)
            .catch(() => null),
        );
        const door = `/i/${link.code}`;
        if (inv?.target.kind === 'room') return openRoom(inv.target.ticker, null, door, navigate);
        if (inv && BSPACES_ENABLED) return navigate(`/m/spaces?invite=${link.code}`);
        // Unknown invite, or a Space without Spaces in this build: bChatX's invite page says what it is.
        openBchatxDoor(door, navigate);
      })();
    };
    go();
    return onAppLink(go);
  }, [navigate, enabled]);
};
