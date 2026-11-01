/**
 * Signed post badges, content-script side (VITE_SIGNED_BADGES=1 builds only; content.ts calls this behind the
 * literal SIGNED_BADGES_ENABLED flag).
 *
 * Every frame answers the background's "what is selected?" (the Sign selected text menu). The top frame of X,
 * LinkedIn, GitHub and YouTube also scans the posts near the screen, asks the background for their proofs (it
 * verifies them; nothing here trusts the overlay), draws "✓ signed by $name" badges, and a "Sign" button on the
 * user's own posts (X, GitHub). Only keys and the posts' own text go to the background; lookups happen there.
 */
import { hashCandidates, matchProofs, type PostRef } from '../match';
import { isContentHashKey, xPostKey, type VerifiedProof } from '../record';
import { badgeSiteFor } from '../sites';
import { canSignHere, findPosts, type FoundPost } from './adapters';
import { closeCard, makeBadge, makeSignButton } from './ui';

// Message names (same strings as background.ts; not imported so the content bundle stays free of the sdk).
const SB_LOOKUP = 'bwxSbLookup';
const SB_SIGN = 'bwxSbSign';
const SB_WHOAMI = 'bwxSbWhoAmI';
const SB_GET_SELECTION = 'bwxSbGetSelection';
const SB_REFRESH = 'bwxSbRefresh';

const sha256Hex = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const send = <T>(msg: Record<string, unknown>): Promise<T | undefined> =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r: T) => resolve(chrome.runtime.lastError ? undefined : r));
    } catch {
      resolve(undefined); // extension reloaded under this tab
    }
  });

type Drawn = { sig: string; host?: HTMLElement };

export const startSignedBadges = () => {
  try {
    chrome.runtime.onMessage.addListener((msg: { action?: string }, sender, reply) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (msg?.action === SB_GET_SELECTION) {
        // AuthSig's selection text: the first range as a string (line breaks kept).
        const s = window.getSelection();
        reply({ text: s && s.rangeCount ? s.getRangeAt(0).toString() : '' });
        return false;
      }
      if (msg?.action === SB_REFRESH && window.top === window) void scan(true);
      return false;
    });
  } catch {
    return; // extension reloaded
  }
  if (window.top !== window || !badgeSiteFor(location.hostname)) return;

  const proofs: Record<string, { at: number; list: VerifiedProof[] }> = {};
  const drawn = new WeakMap<Element, Drawn>();
  let me: string | undefined;
  let running = false;
  let again: { fresh: boolean } | undefined;
  const TTL = 2 * 60_000;

  const refOf = async (p: FoundPost, i: number): Promise<PostRef> => {
    // The text as we sign it (raw / trimmed / normalised), and off X up to two long text nodes (AuthSig's
    // selected-text proofs hash one node). Kept small: every hash is one overlay lookup.
    const texts = hashCandidates([p.signText, ...(p.platform === 'X' ? [] : p.nodes.slice(0, 2))]);
    const hashes = await Promise.all(texts.map(async (text) => ({ key: await sha256Hex(text), text })));
    return {
      id: String(i),
      xKey: p.xStatusId ? xPostKey(p.xStatusId) : undefined,
      texts: p.texts,
      hashes,
      truncated: p.truncated,
    };
  };

  const near = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.bottom > -window.innerHeight * 0.5 && r.top < window.innerHeight * 1.5 && r.height > 0;
  };

  const draw = (p: FoundPost, ref: PostRef, list: VerifiedProof[] | undefined) => {
    const sig = `${ref.xKey ?? ''}|${ref.hashes.map((h) => h.key).join(',')}|${list?.map((x) => x.publicKey + x.name).join(',') ?? ''}|${me ?? ''}`;
    const prev = drawn.get(p.el);
    if (prev?.sig === sig && prev.host?.isConnected) return;
    prev?.host?.remove();
    const parts: HTMLElement[] = [];
    if (list?.length) parts.push(makeBadge(list, me));
    // The user's own post they haven't signed yet (someone else may have).
    if (canSignHere(p) && !list?.some((x) => x.publicKey === me))
      parts.push(
        makeSignButton(async () => {
          const r = (await send<{ success: boolean; error?: string }>({
            action: SB_SIGN,
            content: p.signText,
            postId: p.xStatusId,
            authorHandle: p.authorHandle,
          })) ?? { success: false, error: 'bWalletX was updated: reload this page' };
          if (r.success) void scan(true);
          return r;
        }),
      );
    let host: HTMLElement | undefined;
    if (parts.length) {
      host = document.createElement('span');
      host.setAttribute('data-bwx-sb', '');
      host.setAttribute('style', 'all:initial;display:inline-flex;align-items:center;');
      host.append(...parts);
      p.anchor.appendChild(host);
    }
    drawn.set(p.el, { sig, host });
  };

  const scan = async (fresh = false) => {
    if (running) {
      again = { fresh: fresh || !!again?.fresh };
      return;
    }
    running = true;
    try {
      if (me === undefined) me = (await send<{ identityKey?: string }>({ action: SB_WHOAMI }))?.identityKey ?? '';
      const posts = findPosts(location.hostname).filter((p) => near(p.el));
      const refs = await Promise.all(posts.map(refOf));
      const now = Date.now();
      const want = new Map<string, string | undefined>();
      for (const r of refs) {
        if (r.xKey) want.set(r.xKey, undefined);
        for (const h of r.hashes) if (isContentHashKey(h.key) && !want.has(h.key)) want.set(h.key, h.text);
      }
      const missing = [...want].filter(([k]) => fresh || !proofs[k] || now - proofs[k].at > TTL);
      for (let i = 0; i < missing.length; i += 60) {
        const batch = missing.slice(i, i + 60).map(([key, text]) => (text === undefined ? { key } : { key, text }));
        const r = await send<{ success: boolean; data?: Record<string, VerifiedProof[]> }>({
          action: SB_LOOKUP,
          items: batch,
          fresh,
        });
        if (!r?.success || !r.data) continue;
        for (const { key } of batch) proofs[key] = { at: now, list: r.data[key] ?? [] };
      }
      const table = Object.fromEntries(Object.entries(proofs).map(([k, v]) => [k, v.list]));
      const matched = matchProofs(refs, table);
      posts.forEach((p, i) => draw(p, refs[i], matched.get(String(i))));
    } finally {
      running = false;
      if (again) {
        const next = again;
        again = undefined;
        setTimeout(() => void scan(next.fresh), 300);
      }
    }
  };

  // Throttled, not debounced: a feed that never stops changing (videos, live counts) still gets scanned.
  let timer: number | undefined;
  const soon = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void scan();
    }, 700);
  };
  new MutationObserver((records) => {
    // Our own badges going in or out are not a page change.
    if (
      records.every((r) =>
        [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).hasAttribute?.('data-bwx-sb')),
      )
    )
      return;
    soon();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('popstate', closeCard);
  soon();
};
