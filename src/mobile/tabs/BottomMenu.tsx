import { Wallet, Store, LayoutGrid, Play, MessageCircle } from 'lucide-react';
import Menu, { type BottomMenuProps } from '../../components/BottomMenu';
import { asMenuItem, tabFor, type MobileTab } from './tabs';

/**
 * Mobile swap for BottomMenu's export (vite.config.mobile.ts). Five tabs:
 * Wallet · Market · Apps · Media · Chat (Settings lives in the account drawer). Reuses upstream's Menu item.
 */
const TABS: { id: MobileTab; label: string; icon: typeof Wallet }[] = [
  { id: 'bsv', label: 'Wallet', icon: Wallet },
  { id: 'market', label: 'Market', icon: Store },
  { id: 'browser', label: 'Apps', icon: LayoutGrid },
  { id: 'media', label: 'Media', icon: Play },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
];

export type { BottomMenuProps };
export default Menu;

export const BottomMenu = ({ selected, handleSelect, theme }: BottomMenuProps) => {
  const active = tabFor(selected);
  return (
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
          onClick={() => handleSelect(asMenuItem(t.id))}
          isSelected={active === t.id}
        />
      ))}
    </div>
  );
};
