import { Wallet, Store, LayoutGrid, Newspaper, MessageCircle } from 'lucide-react';
import Menu, { type BottomMenuProps } from '../../components/BottomMenu';
import { useServiceContext } from '../../hooks/useServiceContext';
import { usePendingIndexing } from '../tokens/pendingIndexing';
import { indexingEnabled, marketLabel } from '../storeBuild';
import { asMenuItem, TAB_ORDER, TAB_TAP, tabFor } from './tabs';
import { usePhoneLayout } from '../phone/flag';
import { WIDE_ON } from '../wide/flag';

/**
 * Mobile swap for BottomMenu's export (vite.config.mobile.ts). Five tabs:
 * Apps · Market · Wallet · Feed · Chat (Settings lives in the account drawer). Reuses upstream's Menu item.
 */
const TAB_INFO: Record<string, { label: string; icon: typeof Wallet }> = {
  bsv: { label: 'Wallet', icon: Wallet },
  market: { label: marketLabel(), icon: Store },
  browser: { label: 'Apps', icon: LayoutGrid },
  feed: { label: 'Feed', icon: Newspaper },
  chat: { label: 'Chat', icon: MessageCircle },
};
const TABS = TAB_ORDER.map((id) => ({ id, ...TAB_INFO[id] }));

export type { BottomMenuProps };
export default Menu;

export const BottomMenu = ({ selected, handleSelect, theme }: BottomMenuProps) => {
  const phone = usePhoneLayout();
  const active = tabFor(selected);
  // Own tokens whose room isn't set up (minus "Not now"): count on the Wallet tab.
  const { apiContext, chromeStorageService } = useServiceContext();
  const pending = usePendingIndexing(
    apiContext,
    chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress,
  ).length;
  // Phone layout test switch on: the dock (phone/PhoneShell.tsx) replaces this bar.
  if (phone || WIDE_ON) return null;
  return (
    <>
      <div
        className="flex items-center w-full absolute bottom-0 z-[100]"
        style={{
          height: '3.75rem',
          backgroundColor: theme.color.component.bottomMenuBackground,
          borderTop: '1px solid #1C1C1E',
        }}
      >
        {TABS.map((t) => (
          <Menu
            key={t.id}
            label={t.label}
            theme={theme}
            icon={t.icon}
            onClick={() => {
              handleSelect(asMenuItem(t.id));
              // Re-tapping the lit tab (e.g. from Media or the b agent) must still navigate back to it.
              window.dispatchEvent(new CustomEvent(TAB_TAP, { detail: t.id }));
            }}
            isSelected={active === t.id}
            badge={t.id === 'bsv' && pending && indexingEnabled() ? String(pending) : undefined}
          />
        ))}
      </div>
    </>
  );
};
