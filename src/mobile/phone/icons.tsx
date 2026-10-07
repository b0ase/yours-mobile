import {
  ArrowLeftRight,
  Gamepad2,
  Globe,
  House,
  LayoutGrid,
  MessageCircle,
  Newspaper,
  Store,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { marketLabel } from '../storeBuild';
import type { ScreenId } from './screens';
import type { DockItem } from './dockModel';

export const SCREEN_ICON: Record<ScreenId, LucideIcon> = {
  wallet: Wallet,
  exchange: Store,
  home: House,
  apps: LayoutGrid,
  games: Gamepad2,
  people: Users,
  feed: Newspaper,
  chat: MessageCircle,
};

export const screenLabel = (id: ScreenId, label: string) => (id === 'exchange' ? marketLabel() : label);

export const ACTION_INFO = { sendReceive: { label: 'Send/Receive', icon: ArrowLeftRight } } as const;

export const itemLabel = (i: DockItem, labels: Record<string, string>) =>
  i.kind === 'screen'
    ? screenLabel(i.id, labels[i.id] ?? i.id)
    : i.kind === 'action'
      ? ACTION_INFO[i.id].label
      : i.name;

export const itemIcon = (i: DockItem): LucideIcon =>
  i.kind === 'screen' ? SCREEN_ICON[i.id] : i.kind === 'action' ? ACTION_INFO[i.id].icon : Globe;
