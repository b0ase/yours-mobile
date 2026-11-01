/**
 * Signed post badges, service-worker side (VITE_SIGNED_BADGES=1 builds only: background.ts calls this behind the
 * literal SIGNED_BADGES_ENABLED flag, so none of it is in other bundles).
 *
 * - `bwxSbLookup` from our content script: verified proofs for the posts on screen (lookup.ts, names.ts).
 * - `bwxSbSign` from our content script (a real click on "Sign" on the user's own post) and the "Sign selected
 *   text" context menu: ONE sheet shows the exact text, where it is and the fee; Allow signs as the wallet itself
 *   and writes the proof token (verify.ts signProof). Nothing is signed or spent without that sheet.
 * - `SIGNED_POST_RESPONSE` from the sheet (an extension page only).
 *
 * Every page fact (URL, host) comes from Chrome's sender or tab, never from the message. A web page can't send
 * any of these messages (no externally_connectable) and can't answer the sheet.
 */
import { GlobalKVStore, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import type { SignedPostPrompt } from '../promptProtocol';
import { createProofLookup, cleanLookupItems } from './lookup';
import { createNameCheck, signerFromName } from './names';
import { AUTHSIG_PROTOCOL_ID, MAX_CONTENT_CHARS, encodeProofValue, storageKeyFor } from './record';
import { estimateProofSats, sha256Hex, signProof, type KvEntry } from './verify';
import { platformFor, xStatusIdFromUrl } from './sites';

export const SB_LOOKUP = 'bwxSbLookup';
export const SB_SIGN = 'bwxSbSign';
export const SB_WHOAMI = 'bwxSbWhoAmI';
export const SB_GET_SELECTION = 'bwxSbGetSelection';
export const SB_REFRESH = 'bwxSbRefresh';
export const SB_RESPONSE = 'SIGNED_POST_RESPONSE';
export const SB_PROMPT_KIND = 'signedPost';
const MENU_ID = 'bwx-sign-selection';

type Sender = chrome.runtime.MessageSender;
type Answer = (r: unknown) => void;

export type SignedBadgesDeps = {
  /** The wallet as itself (admin originator): unlocks first when needed. */
  adminWallet: () => Promise<WalletInterface>;
  /** The open account's identity key, without unlocking ('' when none). */
  identityKey: () => string;
  satsPerKb: () => number;
  usdPerBsv: () => Promise<number | undefined>;
  /** Queue the sheet (background showPromptUi). */
  showPrompt: (kind: string, requestID: string) => void;
  /** Remember the tab a sheet is for, so it opens over that tab. */
  noteTab: (originator: string, tab: { tabId: number; windowId: number }) => void;
  closePromptIfIdle: () => void;
  isExtensionSender: (s: Sender) => boolean;
  timeoutMs: number;
};

type Pending = { request: SignedPostPrompt; resolve: (r: { allow: boolean; signer?: string }) => void };

export const installSignedBadges = (deps: SignedBadgesDeps) => {
  const store = new GlobalKVStore({
    wallet: new ProtoWallet('anyone') as unknown as WalletInterface,
    protocolID: AUTHSIG_PROTOCOL_ID,
    networkPreset: 'mainnet',
  });
  const proofs = createProofLookup({
    get: async (key) =>
      ((await store.get({ key, protocolID: AUTHSIG_PROTOCOL_ID, limit: 25 }, { includeToken: true })) ??
        []) as unknown as KvEntry[],
  });
  const names = createNameCheck((url, init) => fetch(url, init));
  const pending = new Map<string, Pending>();
  let busy = false;

  /** Ask once, sign, record. Resolves with what the content script needs to redraw. */
  const signFlow = async (p: {
    content: string;
    kind: 'post' | 'selection';
    pageUrl: string;
    tab?: { tabId: number; windowId: number };
    authorHandle?: string;
    /** A post on X: the status id the content script read from the post's own link (x.com pages only). */
    xStatusId?: string;
  }): Promise<{ success: boolean; error?: string; key?: string; outpoint?: string }> => {
    if (busy) return { success: false, error: 'Another signature is waiting for you in bWalletX' };
    const content = p.content;
    if (!content.trim() || content.length > MAX_CONTENT_CHARS)
      return { success: false, error: `Select between 1 and ${MAX_CONTENT_CHARS.toLocaleString()} characters` };
    let url: URL;
    try {
      url = new URL(p.pageUrl);
    } catch {
      return { success: false, error: 'This page has no address to sign on' };
    }
    if (url.protocol !== 'https:') return { success: false, error: 'Signing works on https pages only' };
    const host = url.hostname.toLowerCase();
    const platform = platformFor(host);
    const xStatusId = p.kind === 'post' && platform === 'X' ? (p.xStatusId ?? xStatusIdFromUrl(p.pageUrl)) : undefined;
    const contentHash = sha256Hex(content);
    const key = storageKeyFor({ xStatusId, contentHash });
    // A post on X is recorded at its own address (AuthSig's pageUrl), not the timeline it was signed from.
    const recordUrl =
      xStatusId && p.authorHandle && /^[A-Za-z0-9_]{1,15}$/.test(p.authorHandle)
        ? `https://x.com/${p.authorHandle}/status/${xStatusId}`
        : url.toString();
    busy = true;
    try {
      // Unlock first (when locked), so the sheet below is the last thing the user sees before signing.
      const wallet = await deps.adminWallet();
      const preview = encodeProofValue({
        signature: '00'.repeat(71),
        publicKey: '02'.padEnd(66, '0'),
        signedAt: new Date().toISOString(),
        protocol: 'authsig-v1',
        content,
        contentHash,
        pageUrl: recordUrl,
        platform: host,
        signer: '$abcdefghijklmnop',
      });
      const requestID = `sb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const answer = await new Promise<{ allow: boolean; signer?: string }>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestID)) resolve({ allow: false });
        }, deps.timeoutMs);
        if (p.tab) deps.noteTab(host, p.tab);
        void deps.usdPerBsv().then((usdPerBsv) => {
          pending.set(requestID, {
            request: {
              requestID,
              originator: host,
              kind: p.kind,
              platform,
              content,
              pageUrl: recordUrl.split('?')[0],
              onX: key.startsWith('x-post-'),
              feeSats: estimateProofSats(key, preview, deps.satsPerKb()),
              ...(usdPerBsv ? { usdPerBsv } : {}),
            },
            resolve: (r) => {
              clearTimeout(timer);
              resolve(r);
            },
          });
          deps.showPrompt(SB_PROMPT_KIND, requestID);
        });
      });
      if (!answer.allow) return { success: false, error: 'Not signed' };
      const signer = signerFromName(answer.signer);
      const { publicKey } = await wallet.getPublicKey({ identityKey: true });
      const claim = signer && (await names.nameMatches(signer, publicKey.toLowerCase())) ? signer : undefined;
      const writer = new GlobalKVStore({ wallet, protocolID: AUTHSIG_PROTOCOL_ID, networkPreset: 'mainnet' });
      const { outpoint } = await signProof(wallet, writer, {
        key,
        content,
        extras: {
          pageUrl: recordUrl,
          platform: host,
          ...(claim ? { signer: claim } : {}),
          ...(xStatusId ? { postId: xStatusId } : {}),
          ...(p.authorHandle && /^[A-Za-z0-9_.-]{1,60}$/.test(p.authorHandle) ? { authorHandle: p.authorHandle } : {}),
        },
      });
      proofs.forget(key);
      if (p.tab) chrome.tabs?.sendMessage(p.tab.tabId, { action: SB_REFRESH, key })?.catch(() => undefined);
      return { success: true, key, outpoint };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  };

  // "Sign selected text with bWalletX" on every page (extension only: the phone shim has no context menus).
  const menus = (chrome as unknown as { contextMenus?: typeof chrome.contextMenus }).contextMenus;
  if (menus) {
    menus.removeAll(() => {
      menus.create({ id: MENU_ID, title: 'Sign selected text with bWalletX', contexts: ['selection'] }, () => {
        void chrome.runtime.lastError; // already there after a worker restart
      });
    });
    menus.onClicked.addListener((info, tab) => {
      if (info.menuItemId !== MENU_ID || !tab?.id || !tab.url) return;
      const tabRef = { tabId: tab.id, windowId: tab.windowId };
      const pageUrl = info.frameUrl && info.frameId ? info.frameUrl : tab.url;
      // The exact selection (line breaks kept) from the frame it was made in; Chrome's selectionText otherwise.
      chrome.tabs
        .sendMessage(tab.id, { action: SB_GET_SELECTION }, { frameId: info.frameId ?? 0 })
        .then((r: { text?: unknown } | undefined) =>
          typeof r?.text === 'string' && r.text.trim() ? r.text : undefined,
        )
        .catch(() => undefined)
        .then((text) =>
          signFlow({ content: text ?? info.selectionText ?? '', kind: 'selection', pageUrl, tab: tabRef }),
        )
        .then((r) => {
          if (!r.success && r.error && r.error !== 'Not signed')
            chrome.notifications?.create(`bwx-sign-${Date.now()}`, {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: 'Not signed',
              message: r.error,
            });
        });
    });
  }

  const handles = (action: unknown) =>
    action === SB_LOOKUP || action === SB_SIGN || action === SB_WHOAMI || action === SB_RESPONSE;

  /** Our content script in a normal tab (never an extension page, never another extension). */
  const fromOurContentScript = (s: Sender) =>
    s.id === chrome.runtime.id && !deps.isExtensionSender(s) && s.tab?.id !== undefined && !!s.url;

  /** Returns true when the answer comes later (Chrome keeps the channel open). */
  const onMessage = (message: { action?: unknown } & Record<string, unknown>, sender: Sender, answer: Answer) => {
    switch (message.action) {
      case SB_RESPONSE: {
        if (!deps.isExtensionSender(sender)) {
          answer({ success: false, error: 'Unauthorized' });
          return false;
        }
        const p = pending.get(String(message.requestID ?? ''));
        if (p) pending.delete(p.request.requestID);
        p?.resolve({
          allow: message.allow === true,
          signer: typeof message.signer === 'string' ? message.signer : undefined,
        });
        answer({ success: !!p });
        deps.closePromptIfIdle();
        return false;
      }
      case SB_WHOAMI:
        answer(fromOurContentScript(sender) ? { success: true, identityKey: deps.identityKey() || undefined } : {});
        return false;
      case SB_LOOKUP: {
        if (!fromOurContentScript(sender)) {
          answer({ success: false, error: 'Unauthorized' });
          return false;
        }
        const items = cleanLookupItems(message.items);
        void proofs
          .lookup(items, message.fresh === true)
          .then((byKey) => names.nameProofs(byKey))
          .then((data) => answer({ success: true, data }))
          .catch((e) => answer({ success: false, error: e instanceof Error ? e.message : String(e) }));
        return true;
      }
      case SB_SIGN: {
        if (!fromOurContentScript(sender) || sender.frameId !== 0) {
          answer({ success: false, error: 'Unauthorized' });
          return false;
        }
        const content = typeof message.content === 'string' ? message.content : '';
        const authorHandle = typeof message.authorHandle === 'string' ? message.authorHandle : undefined;
        const xStatusId =
          typeof message.postId === 'string' && /^\d{1,25}$/.test(message.postId) ? message.postId : undefined;
        void signFlow({
          content,
          kind: 'post',
          pageUrl: sender.url!,
          tab: { tabId: sender.tab!.id!, windowId: sender.tab!.windowId },
          authorHandle,
          xStatusId,
        }).then(answer);
        return true;
      }
      default:
        return false;
    }
  };

  return {
    handles,
    onMessage,
    promptPayload: (requestID?: string) => (requestID ? pending.get(requestID)?.request : undefined),
    nextPromptID: (): string | undefined => pending.keys().next().value,
    hasPending: () => pending.size > 0,
    failAll: () => {
      for (const p of pending.values()) p.resolve({ allow: false });
      pending.clear();
    },
  };
};

export type SignedBadgesBackground = ReturnType<typeof installSignedBadges>;
