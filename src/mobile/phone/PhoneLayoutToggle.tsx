import { setPhoneLayout, usePhoneLayout } from './flag';

/** Settings › Appearance › Classic layout: on = the old layout, off (default) = the phone layout. */
export const PhoneLayoutToggle = () => {
  const classic = !usePhoneLayout();
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white">Classic layout</div>
        <div className="text-xs text-[#98A2B3]">
          The older layout with tabs along the top. Turn off for the dock with the b in the middle.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={classic}
        aria-label="Classic layout"
        onClick={() => setPhoneLayout(classic)}
        className="relative h-7 w-12 shrink-0 rounded-full border-0 transition-colors"
        style={{ background: classic ? '#FFD24D' : '#2b2f36' }}
      >
        <span
          className="absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all"
          style={{ left: classic ? 'calc(100% - 1.625rem)' : '0.125rem' }}
        />
      </button>
    </div>
  );
};
