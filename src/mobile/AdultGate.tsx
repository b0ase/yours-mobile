import { Lock } from 'lucide-react';
import { ADULT_OK_KEY } from './bappStandard';

/** Adult (18+) tiles never reach a store build; a literal env check so Rollup drops the age-gate text too (store grep). */
const ADULT_UI: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/** The tile face before the confirmation: no name, no art. Empty in a store build, which has no adult tile. */
// eslint-disable-next-line react-refresh/only-export-components -- plain values read by the Apps page, kept beside the gate
export const ADULT_ICON = ADULT_UI
  ? `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" fill="#3A0A0E"/><text x="30" y="38" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="800" fill="#ff5a5a">18+</text></svg>',
    )}`
  : '';

/** The tile's name before the confirmation; a literal so a store bundle never carries it. */
// eslint-disable-next-line react-refresh/only-export-components -- plain values read by the Apps page, kept beside the gate
export const ADULT_NAME = ADULT_UI ? 'Adults only' : '';

// eslint-disable-next-line react-refresh/only-export-components -- plain values read by the Apps page, kept beside the gate
export const readAdultOk = () => {
  try {
    return localStorage.getItem(ADULT_OK_KEY) === '1';
  } catch {
    return false;
  }
};

/** The 18+ confirmation for an adult tile on the Apps page (bWalletX only). Remembered on this device. */
export const AdultGate = ({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) =>
  !ADULT_UI ? null : (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Adults only"
      className="fixed inset-0 z-[120] flex items-end justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-3"
        style={{ background: 'var(--bw-surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lock size={16} color="#ff5a5a" />
          <span className="text-[15px] font-bold text-[color:var(--bw-text)]">Adults only (18+)</span>
        </div>
        <p className="m-0 text-[12px] text-[color:var(--bw-muted)]">
          {name} has adult content. It is a separate brand from Ninja Punk Girls. Only continue if you are 18 or over.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full py-2 text-[13px] font-bold border-0"
            style={{ background: 'var(--bw-line)', color: 'var(--bw-text)' }}
          >
            Go back
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(ADULT_OK_KEY, '1');
              } catch {
                /* private mode: ask again next time */
              }
              onConfirm();
            }}
            className="flex-1 rounded-full py-2 text-[13px] font-bold border-0"
            style={{ background: '#ff3b3b', color: '#fff' }}
          >
            I am 18 or over
          </button>
        </div>
      </div>
    </div>
  );
