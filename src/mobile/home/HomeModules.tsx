import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  CreditCard,
  History,
  LayoutGrid,
  LineChart,
  Minus,
  Music,
  PiggyBank,
  Plus,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { SHARES_CARD_ENABLED, STORE_BUILD, THEME_STORE_PAID_ENABLED } from '../storeBuild';
import { SectionBoundary } from '../wallet/SectionBoundary';
import {
  MODULE_IDS,
  WIDE_PANE_MODULES,
  addModule,
  removeModule,
  shiftModule,
  visibleLayout,
  type ModuleId,
} from './layout';
import { useHomeLayout } from './useHomeLayout';
import { WIDE_ON } from '../wide/flag';
import { AskBModule, HistoryModule, MusicModule, NotificationsModule, PotsModule, PriceChartModule } from './modules';
import './home.css';

// Paid store content: its own chunk behind the inlined flag, so a store build never contains it.
// Holdings reads the wide layout's wallet feed, so it is a Desktop module.
const Holdings = WIDE_ON ? lazy(() => import('./Holdings')) : null;
const SharesCard = SHARES_CARD_ENABLED ? lazy(() => import('../shareClaim/SharesCard')) : null;
const StoreShowcase = THEME_STORE_PAID_ENABLED ? lazy(() => import('./StoreShowcase')) : null;

const BIcon = ((p: { size?: number }) => (
  <img src={bGlyph} alt="" width={p.size} height={p.size} />
)) as unknown as LucideIcon;

type HomeModuleDef = {
  id: ModuleId;
  title: string;
  blurb: string;
  icon: LucideIcon;
  /** 'full' spans both columns on Desktop; 'half' takes one. */
  size: 'full' | 'half';
  /** Allowed in App Store / Play builds (no paid or blocked content). */
  store: boolean;
  /** Rendered by the host page (the card), not here. */
  slot?: boolean;
  Component?: ComponentType;
};

const HOME_MODULES: Record<ModuleId, HomeModuleDef> = {
  card: {
    id: 'card',
    title: 'Card',
    blurb: 'Your balance card',
    icon: CreditCard,
    size: 'full',
    store: true,
    slot: true,
  },
  askB: {
    id: 'askB',
    title: 'Ask b',
    blurb: 'Ask b to do something',
    icon: BIcon,
    size: 'full',
    store: true,
    Component: AskBModule,
  },
  showcase: {
    id: 'showcase',
    title: 'Store showcase',
    blurb: 'Themes, emoji, music and names',
    icon: ShoppingBag,
    size: 'full',
    store: false,
    Component: StoreShowcase ?? undefined,
  },
  history: {
    id: 'history',
    title: 'History',
    blurb: 'Payments in and out',
    icon: History,
    size: 'half',
    store: true,
    Component: HistoryModule,
  },
  priceChart: {
    id: 'priceChart',
    title: 'BSV price chart',
    blurb: 'The last 30 days',
    icon: LineChart,
    size: 'full',
    store: true,
    Component: PriceChartModule,
  },
  pots: {
    id: 'pots',
    title: 'Pots',
    blurb: 'Money set aside, regular payments',
    icon: PiggyBank,
    size: 'half',
    store: true,
    Component: PotsModule,
  },
  notifications: {
    id: 'notifications',
    title: 'Notifications',
    blurb: 'Chat, payments and replies',
    icon: Bell,
    size: 'half',
    store: true,
    Component: NotificationsModule,
  },
  holdings: {
    id: 'holdings',
    title: 'Holdings',
    blurb: 'Every balance, sortable',
    icon: Wallet,
    size: 'full',
    store: true,
    Component: Holdings ?? undefined,
  },
  music: {
    id: 'music',
    title: 'Music',
    blurb: "What's playing",
    icon: Music,
    size: 'half',
    store: true,
    Component: MusicModule,
  },
};

/** Can this module show in this build? (Store builds drop paid content; a module whose chunk is absent never shows.) */
const moduleAllowed = (id: ModuleId, store = STORE_BUILD): boolean => {
  const d = HOME_MODULES[id];
  if (!d) return false;
  if (store && !d.store) return false;
  if (WIDE_ON && WIDE_PANE_MODULES.includes(id)) return false;
  return d.slot || !!d.Component;
};

/** The card slot: renders its children only while the card module is on the home. */
export const HomeTop = ({ children }: { children: ReactNode }) => {
  const { ids } = useHomeLayout();
  return ids.includes('card') ? <>{children}</> : null;
};

/** Every other module, in the user's order, then "Edit home". */
export const HomeRest = () => {
  const { ids, set } = useHomeLayout();
  const [editing, setEditing] = useState(false);
  const shown = visibleLayout(ids, (id) => moduleAllowed(id));
  const rest = shown.filter((id) => !HOME_MODULES[id].slot);
  return (
    <div className="bw-home">
      {editing ? (
        <HomeEditor ids={shown} set={set} all={ids} onDone={() => setEditing(false)} />
      ) : (
        <div className="bw-home-grid">
          {/* Your shareholding: renders nothing unless a company returns this wallet's own signed register entry. */}
          {SharesCard && (
            <SectionBoundary name="Your shareholding">
              <Suspense fallback={null}>
                <SharesCard />
              </Suspense>
            </SectionBoundary>
          )}
          {rest.map((id) => {
            const d = HOME_MODULES[id];
            const C = d.Component!;
            return (
              <div key={id} className={`bw-home-cell bw-home-cell-${id} ${d.size}`}>
                <SectionBoundary name={d.title}>
                  <Suspense fallback={<div className="bw-home-panel bw-home-skel" />}>
                    <C />
                  </Suspense>
                </SectionBoundary>
              </div>
            );
          })}
        </div>
      )}
      {!editing && (
        <button type="button" className="bw-home-edit" onClick={() => setEditing(true)}>
          <LayoutGrid size={14} aria-hidden="true" /> Edit home
        </button>
      )}
    </div>
  );
};

const HomeEditor = ({
  ids,
  all,
  set,
  onDone,
}: {
  ids: ModuleId[];
  all: ModuleId[];
  set: (ids: ModuleId[]) => void;
  onDone: () => void;
}) => {
  const available = MODULE_IDS.filter((id) => moduleAllowed(id) && !ids.includes(id));
  return (
    <section className="bw-home-panel bw-home-editor" aria-label="Edit home">
      <header className="bw-home-head">
        <LayoutGrid size={16} className="bw-home-ico" aria-hidden="true" />
        <span className="bw-home-title">Your home</span>
        <button type="button" className="bw-home-done" onClick={onDone}>
          Done
        </button>
      </header>
      <ul className="bw-home-elist">
        {ids.map((id) => {
          const d = HOME_MODULES[id];
          const pos = all.indexOf(id);
          const floor = all[0] === 'card' ? 1 : 0;
          return (
            <li key={id}>
              <d.icon size={18} className="bw-home-ico" aria-hidden="true" />
              <span className="bw-home-tiletext">
                <span className="bw-home-line">{d.title}</span>
                <span className="bw-home-sub bw-home-line">{d.slot ? 'Always at the top' : d.blurb}</span>
              </span>
              {!d.slot && (
                <>
                  <button
                    type="button"
                    className="bw-home-round ghost"
                    aria-label={`Move ${d.title} up`}
                    disabled={pos <= floor}
                    onClick={() => set(shiftModule(all, id, -1))}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="bw-home-round ghost"
                    aria-label={`Move ${d.title} down`}
                    disabled={pos >= all.length - 1}
                    onClick={() => set(shiftModule(all, id, 1))}
                  >
                    <ArrowDown size={14} />
                  </button>
                </>
              )}
              <button
                type="button"
                className="bw-home-round ghost"
                aria-label={`Remove ${d.title}`}
                onClick={() => set(removeModule(all, id))}
              >
                <Minus size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {available.length > 0 && (
        <>
          <div className="bw-home-sub bw-home-addlabel">Add to your home</div>
          <ul className="bw-home-elist">
            {available.map((id) => {
              const d = HOME_MODULES[id];
              return (
                <li key={id}>
                  <d.icon size={18} className="bw-home-ico" aria-hidden="true" />
                  <span className="bw-home-tiletext">
                    <span className="bw-home-line">{d.title}</span>
                    <span className="bw-home-sub bw-home-line">{d.blurb}</span>
                  </span>
                  <button
                    type="button"
                    className="bw-home-round"
                    aria-label={`Add ${d.title}`}
                    onClick={() => set(addModule(all, id))}
                  >
                    <Plus size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
};
