import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getWalletKind, setWalletKind, subscribeWalletKind, type WalletKind } from './walletKind';
import { walletKindsFor } from '../storeBuild';

const useWalletKind = () => useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);

// Tokens | NFTs | Friends (address book, owner 4 Oct 2026). Tickets are ordinary tokens that get burned on entry, so they sit under Tokens
// (owner, 3 Oct 2026); the Tickets view (WalletKindGate kind="tickets") is kept but nothing opens it.
// Credits ($BCREDIT) are shelved the same way (2 Oct 2026).
const KINDS: [WalletKind, string][] = walletKindsFor<[WalletKind, string]>([
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['friends', 'Friends'], // back to Friends (owner, 6 Oct 2026)
]);
const SHOWN = new Set(KINDS.map(([k]) => k));

/** Tokens | NFTs (sized so four fit a 320px phone), styled like Market's type switch (market/MarketPage.tsx). */
export const WalletKindSwitch = () => {
  const kind = useWalletKind();
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  // Switching must not move the page: remember where the switch sits on screen, and after the new section
  // renders scroll it back there. If the new section is too short to scroll that far, pad the scroller's
  // bottom so the browser can't clamp the scroll position and pull the switch out from under the finger.
  const choose = (id: WalletKind) => {
    anchor.current = ref.current?.getBoundingClientRect().top ?? null;
    setWalletKind(id);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const want = anchor.current;
    anchor.current = null;
    if (!el || want == null) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const box = scroller ?? (document.scrollingElement as HTMLElement | null);
    if (!box) return;
    const pin = () => {
      const delta = el.getBoundingClientRect().top - want;
      if (Math.abs(delta) < 1) return;
      const target = box.scrollTop + delta;
      const room = box.scrollHeight - box.clientHeight;
      if (target > room) {
        const pad = parseFloat(getComputedStyle(box).paddingBottom) || 0;
        box.style.paddingBottom = `${pad + target - room}px`;
      }
      box.scrollTop = target;
    };
    pin();
    // The new section may still settle (lists load, images size) — hold the switch in place for a moment,
    // but let go as soon as the user scrolls or touches.
    let frames = 45;
    let raf = 0;
    const stop = () => {
      frames = 0;
      cancelAnimationFrame(raf);
    };
    const tick = () => {
      if (frames-- <= 0) return;
      pin();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    box.addEventListener('wheel', stop, { passive: true, once: true });
    box.addEventListener('touchstart', stop, { passive: true, once: true });
    return () => {
      stop();
      box.removeEventListener('wheel', stop);
      box.removeEventListener('touchstart', stop);
    };
  }, [kind]);
  return (
    <div
      ref={ref}
      className="w-[92%] mx-auto mt-6 mb-3 flex gap-1 rounded-xl p-1 bg-[#17191E]"
      role="tablist"
      aria-label="Wallet type"
    >
      {KINDS.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={kind === id}
          onClick={() => choose(id)}
          className="flex-1 min-w-0 rounded-lg py-2 px-0.5 text-[13px] font-bold border-0 outline-none cursor-pointer"
          style={{ background: kind === id ? '#A1FF8B' : 'transparent', color: kind === id ? '#010101' : '#98A2B3' }}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

/** Shows its children while the Wallet shows `kind`. Mounted on first visit and then kept (hidden), so
 *  switching back doesn't remount, refetch (the NFT list) or change the page height. */
export const WalletKindGate = ({ kind, children }: { kind: WalletKind; children: ReactNode }) => {
  const active = useWalletKind() === kind && SHOWN.has(kind);
  const visited = useRef(false);
  if (active) visited.current = true;
  if (!visited.current) return null;
  return <div style={{ display: active ? 'contents' : 'none' }}>{children}</div>;
};
