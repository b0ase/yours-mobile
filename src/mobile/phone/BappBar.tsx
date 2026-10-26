import { useState } from 'react';
import { ArrowLeftRight, MessageCircle, Newspaper, Wallet, X } from 'lucide-react';
import { BappIcon } from '../brand/bappIcons/BappIcon';
import { HomeButton } from './Dock';
import { Sheet } from './Sheet';
import { barButtons, type BappBarDef, type BarSlot } from './bappBarModel';

/**
 * The five-button bApp bar on the phone (bappBarModel.ts): Wallet · Exchange · (b) · Feed · Chat scoped to the open
 * bApp, in the dock's place and size (--dock-h), so pages padded with .bw-dock-pad clear it. Slots the app has no
 * real screen for are greyed out and do nothing. Theme tokens only, so it follows Gold and the Mono/Duo/Tri packs.
 * Props only, no router hooks: the shell (inside <Router>) passes the path and the navigate function.
 */
const ICONS: Record<BarSlot, typeof Wallet> = {
  wallet: Wallet,
  exchange: ArrowLeftRight,
  feed: Newspaper,
  chat: MessageCircle,
};
const ON = 'var(--bw-accent-hi)';
const OFF = 'var(--bw-muted, #98A2B3)';

type Props = {
  def: BappBarDef;
  pathname: string;
  search: string;
  onGo: (route: string) => void;
  onHome: () => void;
  onAgent: () => void;
};

export const BappBar = ({ def, pathname, search, onGo, onHome, onAgent }: Props) => {
  const buttons = barButtons(def, pathname, search);
  const slot = (i: number) => {
    const b = buttons[i];
    const Icon = ICONS[b.slot];
    const off = b.route === null;
    return (
      <button
        key={b.slot}
        type="button"
        data-slot={b.slot}
        disabled={off}
        aria-disabled={off}
        aria-current={b.active ? 'page' : undefined}
        aria-label={off ? `${def.name} ${b.label}: not available yet` : `${def.name} ${b.label}`}
        onClick={() => b.route && onGo(b.route)}
        className="flex flex-1 flex-col items-center gap-1 py-1 bg-transparent border-0 select-none min-w-0 disabled:cursor-default"
        style={{ opacity: off ? 0.35 : 1 }}
      >
        <Icon size={20} color={b.active ? ON : off ? OFF : 'var(--bw-text, #F2F2F0)'} />
        <span
          className="text-[10px] leading-tight whitespace-nowrap"
          style={{ color: b.active ? ON : OFF, fontWeight: b.active ? 700 : 500 }}
        >
          {b.label}
        </span>
      </button>
    );
  };
  return (
    <nav
      aria-label={`${def.name} bar`}
      data-phone-dock
      data-bw-bottom-nav
      data-bapp-bar={def.id}
      className="absolute bottom-0 left-0 right-0 z-[100] flex flex-col"
      style={{
        height: 'var(--dock-h)',
        background: 'var(--bw-nav, #0A0B0D)',
        borderTop: '1px solid var(--bw-line, #2b2f36)',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="h-4 shrink-0" />
      <div className="flex-1 min-h-0 flex items-center px-1">
        <div className="flex-1 flex items-center justify-around min-w-0">{[0, 1].map(slot)}</div>
        <HomeButton onHome={onHome} onAgent={onAgent} disabled={false} />
        <div className="flex-1 flex items-center justify-around min-w-0">{[2, 3].map(slot)}</div>
      </div>
    </nav>
  );
};

/** The app's icon, next to ☰ top-left: opens the app's Home and its sections. */
export const BappAppButton = ({ def, onGo }: { def: BappBarDef; onGo: (route: string) => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`${def.name} menu`}
        aria-haspopup="dialog"
        data-bapp-icon={def.id}
        onClick={() => setOpen(true)}
        className="w-9 h-9 rounded-[10px] overflow-hidden flex items-center justify-center bg-transparent border-0 p-0"
      >
        <BappIcon slug={def.icon} size={36} label={def.name} className="w-9 h-9" />
      </button>
      {open && (
        <Sheet label={def.name} onClose={() => setOpen(false)}>
          <div className="flex items-center gap-3">
            <BappIcon slug={def.icon} size={36} label={def.name} className="w-9 h-9 rounded-[10px]" />
            <p className="flex-1 m-0 text-base font-bold" style={{ color: 'var(--bw-text, #F2F2F0)' }}>
              {def.name}
            </p>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="w-8 h-8 rounded-full flex items-center justify-center bg-transparent"
              style={{ border: '1px solid var(--bw-line, #2b2f36)' }}
            >
              <X size={16} color="var(--bw-text, #F2F2F0)" />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {def.sections.map((s) => (
              <button
                key={s.route}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onGo(s.route);
                }}
                className="w-full text-left rounded-xl px-3 py-3 text-sm font-semibold border-0"
                style={{ background: 'var(--bw-card, #17191E)', color: 'var(--bw-text, #F2F2F0)' }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
};
