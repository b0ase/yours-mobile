import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackClose } from '../backStack';
import type { Confirm } from './confirm';

import { CARD, GOLD, GOLD_BUTTON, MUTED } from './style';

export { CARD, GOLD, MUTED };

/** Bottom sheet used by every PNEE screen. */
export const Sheet = ({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="flex-1 text-base font-bold text-white">{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
            <X size={18} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

export const Lines = ({ lines }: { lines: { label: string; value: string }[] }) => (
  <div className="rounded-xl p-3 flex flex-col gap-1.5" style={{ background: CARD }}>
    {lines.map((l, i) => (
      <div key={`${i}-${l.label}`} className="flex justify-between gap-3 text-xs">
        <span style={{ color: MUTED }}>{l.label}</span>
        <span className="font-bold text-white text-right">{l.value}</span>
      </div>
    ))}
  </div>
);

export const Button = ({
  children,
  onClick,
  disabled,
  ghost,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ghost?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`rounded-xl py-3 text-sm font-bold cursor-pointer flex items-center justify-center gap-2 ${ghost ? 'border bg-transparent' : 'border-0'}`}
    style={ghost ? { borderColor: '#F5B80055', color: GOLD } : { ...GOLD_BUTTON, opacity: disabled ? 0.5 : 1 }}
  >
    {children}
  </button>
);

/** The confirm before a chain action: exact amounts, what happens, one button. The wallet then asks as usual. */
export const ConfirmSheet = ({
  confirm,
  busy,
  onConfirm,
  onClose,
}: {
  confirm: Confirm;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) => (
  <Sheet title={confirm.title} onClose={busy ? () => undefined : onClose}>
    <Lines lines={confirm.lines} />
    <p className="text-xs m-0" style={{ color: '#D0D5DD' }}>
      {confirm.note}
    </p>
    <Button disabled={busy} onClick={onConfirm}>
      {busy ? 'Working…' : confirm.button}
    </Button>
  </Sheet>
);
