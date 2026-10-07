import { House } from 'lucide-react';

/**
 * Page dots along the top of the dock, for the app screens only (Option B, plan §14.4): a tablist of real
 * buttons; Home is a small house; the screen on show shows its title (tap it to rename the screen).
 */
export const PageDots = ({
  titles,
  current,
  onGo,
  onRename,
}: {
  titles: readonly string[];
  current: number;
  onGo: (i: number) => void;
  onRename: (i: number) => void;
}) => (
  <div role="tablist" aria-label="App screens" className="flex justify-center h-4">
    <div className="flex items-center">
      {titles.map((title, i) => {
        const on = i === current;
        return (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={
              on
                ? `${title}, screen ${i + 1} of ${titles.length}. Tap to rename`
                : `${title}, screen ${i + 1} of ${titles.length}`
            }
            onClick={() => (on ? onRename(i) : onGo(i))}
            className="flex items-center justify-center bg-transparent border-0 p-0"
            style={{ minWidth: 20, height: 16 }}
          >
            {on ? (
              <span
                data-testid="page-title"
                className="rounded-full px-2 text-[10px] font-bold leading-[14px] whitespace-nowrap"
                style={{ background: '#FFD24D', color: '#010101' }}
              >
                {title}
              </span>
            ) : i === 0 ? (
              <House size={10} color="#667085" strokeWidth={3} />
            ) : (
              <span className="block rounded-full" style={{ width: 6, height: 6, background: '#667085' }} />
            )}
          </button>
        );
      })}
    </div>
  </div>
);
