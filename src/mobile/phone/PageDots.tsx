import { House } from 'lucide-react';
import type { Screen, ScreenId } from './screens';
import { screenLabel } from './icons';

/** Page dots along the top of the dock: a tablist of real buttons; HOME is a small house. */
export const PageDots = ({
  strip,
  current,
  onGo,
}: {
  strip: readonly Screen[];
  current: ScreenId;
  onGo: (s: Screen) => void;
}) => (
  <div role="tablist" aria-label="Screens" className="flex justify-center h-4">
    <div className="flex items-center">
      {strip.map((s, i) => {
        const on = s.id === current;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={`${screenLabel(s.id, s.label)}, page ${i + 1} of ${strip.length}`}
            onClick={() => onGo(s)}
            className="flex items-center justify-center bg-transparent border-0 p-0"
            style={{ width: 20, height: 16 }}
          >
            {s.id === 'home' ? (
              <House size={10} color={on ? '#FFD24D' : '#667085'} strokeWidth={3} />
            ) : (
              <span
                className="block rounded-full"
                style={{ width: 6, height: 6, background: on ? '#FFD24D' : '#667085' }}
              />
            )}
          </button>
        );
      })}
    </div>
  </div>
);
