import { useEffect, type RefObject } from 'react';
import { LayoutGrid } from 'lucide-react';

/** Owner, 9 Nov 2026: the Apps button is a full-width gold bar at the top of the b screen, under its header. */
export const AppsBar = ({ onGo }: { onGo: () => void }) => (
  <button type="button" className="bw-apps-bar" onClick={onGo}>
    <LayoutGrid size={15} aria-hidden />
    Apps
  </button>
);

const SWIPE_PX = 72;

/**
 * Swipe up on Ask b → the apps (owner, 8 Nov 2026). Only from a conversation already at its end, and never from the
 * message box, so reading older replies and typing are untouched: the same rule as pull-down-to-b, which only starts
 * from the top of the apps page. PhoneShell's own gesture doesn't run here (this isn't an app screen).
 */
export const useSwipeUpToApps = (on: boolean, go: () => void, root: RefObject<HTMLElement>) => {
  useEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    let start: { x: number; y: number } | null = null;
    const atEnd = () => {
      const list = el.querySelector('.askb-pagepad');
      return !list || list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    };
    const down = (e: TouchEvent) => {
      start = null;
      const t = e.target as Element | null;
      if (e.touches.length !== 1 || !t || t.closest?.('textarea, input, [data-agent-input]') || !atEnd()) return;
      start = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!start || !p) return;
      const up = start.y - p.clientY;
      const side = Math.abs(p.clientX - start.x);
      if (up < -10 || (side > 12 && side > up)) return void (start = null);
      if (up > 8) e.preventDefault(); // at the end already: the list doesn't rubber-band
    };
    const up = (e: TouchEvent) => {
      const p = e.changedTouches[0];
      if (start && p && start.y - p.clientY > SWIPE_PX) go();
      start = null;
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up, { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', up);
    };
  }, [on, go, root]);
};
