import { setPhoneLayout, usePhoneLayout } from './flag';

/** Settings › Testing: the phone layout test switch (default off). */
export const PhoneLayoutToggle = () => {
  const on = usePhoneLayout();
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white">New phone layout (preview)</div>
        <div className="text-xs text-[#98A2B3]">
          Swipe between screens, a dock with the b in the middle (tap = Home, hold = ask b). Turn off to go back.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="New phone layout"
        onClick={() => setPhoneLayout(!on)}
        className="relative h-7 w-12 shrink-0 rounded-full border-0 transition-colors"
        style={{ background: on ? '#FFD24D' : '#2b2f36' }}
      >
        <span
          className="absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all"
          style={{ left: on ? 'calc(100% - 1.625rem)' : '0.125rem' }}
        />
      </button>
    </div>
  );
};
