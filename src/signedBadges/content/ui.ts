/**
 * The badge ("✓ signed by $alice"), its card, and the "Sign" button on the user's own posts. Each lives in a closed
 * shadow root so the site's CSS can't restyle it and its scripts can't read or click into it. Every page-derived
 * string is set with textContent, never as HTML.
 */
import { badgeLabel } from '../match';
import { proofTxid, shortKey, type VerifiedProof } from '../record';

const GOLD = '#FFD24D';
const GOLD_LO = '#EAB300';
const INK = '#010101';

const BADGE_CSS = `
  :host{all:initial}
  button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;cursor:pointer;
    font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-radius:999px;padding:3px 8px 3px 4px;
    white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
  .badge{background:linear-gradient(135deg,${GOLD},${GOLD_LO});color:${INK};box-shadow:0 0 0 1px #0000001f}
  .sign{background:transparent;color:${GOLD_LO};border:1px solid ${GOLD_LO};padding:2px 8px}
  .sign[disabled]{opacity:.6;cursor:default}
  .tick{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:999px;
    background:${INK};color:${GOLD};font-size:9px;flex:none}
  button:focus-visible{outline:2px solid ${GOLD};outline-offset:2px}`;

const CARD_CSS = `
  :host{all:initial}
  .card{position:fixed;z-index:2147483646;width:300px;max-width:calc(100vw - 24px);box-sizing:border-box;
    background:#0b0b0b;color:#f5f5f5;border:1px solid ${GOLD_LO};border-radius:16px;padding:14px;
    box-shadow:0 16px 48px #000a;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  h3{margin:0 0 8px;font-size:14px;color:${GOLD};display:flex;justify-content:space-between;align-items:center}
  .x{all:unset;cursor:pointer;color:#999;font-size:16px;padding:0 4px}
  .row{border-top:1px solid #ffffff1a;padding:8px 0}
  .name{font-weight:700}
  .key{all:unset;cursor:pointer;font:11px ui-monospace,Menlo,monospace;color:#bbb}
  .muted{color:#999;font-size:12px}
  a{color:${GOLD};text-decoration:none}
  a:hover{text-decoration:underline}
  .foot{margin-top:6px;color:#888;font-size:11px}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A host element for one badge or button: inline, isolated, marked so the scanner skips it as post text. */
const makeHost = (): { host: HTMLElement; root: ShadowRoot } => {
  const host = document.createElement('span');
  host.setAttribute('data-bwx-sb', '');
  host.setAttribute('style', 'all:initial;display:inline-flex;vertical-align:middle;margin:0 6px;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = BADGE_CSS;
  root.appendChild(style);
  return { host, root };
};

let openCard: { host: HTMLElement; off: () => void } | undefined;
export const closeCard = () => {
  openCard?.off();
  openCard?.host.remove();
  openCard = undefined;
};

const showCard = (anchor: HTMLElement, proofs: readonly VerifiedProof[], me?: string) => {
  closeCard();
  const host = document.createElement('div');
  host.setAttribute('data-bwx-sb', '');
  host.setAttribute('style', 'all:initial');
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = CARD_CSS;
  const card = el('div', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Signed post');
  const h = el('h3', undefined, proofs.length > 1 ? `✓ Signed by ${proofs.length}` : '✓ Signed post');
  const x = el('button', 'x', '×');
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeCard);
  h.appendChild(x);
  card.appendChild(h);
  for (const p of proofs.slice(0, 5)) {
    const row = el('div', 'row');
    row.appendChild(el('div', 'name', p.publicKey === me ? `${p.name ?? 'You'} (you)` : (p.name ?? 'Unnamed signer')));
    const key = el('button', 'key', shortKey(p.publicKey));
    key.title = `${p.publicKey} (click to copy)`;
    key.addEventListener('click', () => {
      void navigator.clipboard?.writeText(p.publicKey).then(() => (key.textContent = 'Copied'));
    });
    row.appendChild(key);
    const when = Date.parse(p.signedAt);
    row.appendChild(el('div', 'muted', `Signed ${Number.isNaN(when) ? p.signedAt : new Date(when).toLocaleString()}`));
    row.appendChild(el('div', 'muted', p.source === 'bwalletx' ? 'With bWalletX' : 'With AuthSig'));
    const txid = proofTxid(p);
    if (txid) {
      const a = el('a', undefined, 'On-chain record ↗');
      a.href = `https://whatsonchain.com/tx/${txid}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      row.appendChild(a);
    }
    card.appendChild(row);
  }
  if (proofs.length > 5) card.appendChild(el('div', 'muted', `and ${proofs.length - 5} more`));
  card.appendChild(
    el(
      'div',
      'foot',
      'The signature checks out for the text shown here. A $name is shown only when that name’s own wallet vouches for the key.',
    ),
  );
  root.append(style, card);
  document.documentElement.appendChild(host);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + 320 > window.innerHeight ? Math.max(8, r.top - 6 - card.offsetHeight) : r.bottom + 6;
  card.style.top = `${top}px`;
  card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 312))}px`;
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeCard();
  const onDown = (e: MouseEvent) => {
    if (!e.composedPath().includes(host) && !e.composedPath().includes(anchor)) closeCard();
  };
  const onScroll = () => closeCard();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  openCard = {
    host,
    off: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    },
  };
};

/** "✓ signed by $alice": click (or Enter) opens the card. */
export const makeBadge = (proofs: readonly VerifiedProof[], me?: string): HTMLElement => {
  const { host, root } = makeHost();
  const b = el('button', 'badge');
  b.appendChild(el('span', 'tick', '✓'));
  b.appendChild(document.createTextNode(badgeLabel(proofs, me)));
  b.title = 'Signed with a BSV wallet. Click for details.';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openCard) closeCard();
    else showCard(host, proofs, me);
  });
  root.appendChild(b);
  return host;
};

/** "Sign" on the user's own post. `onSign` runs only for a real click (never a script's synthetic one). */
export const makeSignButton = (onSign: () => Promise<{ success: boolean; error?: string }>): HTMLElement => {
  const { host, root } = makeHost();
  const b = el('button', 'sign', '✍ Sign');
  b.title = 'Sign this post with bWalletX and record the proof on chain';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted || b.hasAttribute('disabled')) return;
    b.setAttribute('disabled', '');
    b.textContent = 'Check bWalletX…';
    void onSign().then((r) => {
      b.removeAttribute('disabled');
      b.textContent = r.success ? '✓ Signed' : '✍ Sign';
      if (!r.success && r.error && r.error !== 'Not signed') b.title = r.error;
    });
  });
  root.appendChild(b);
  return host;
};
