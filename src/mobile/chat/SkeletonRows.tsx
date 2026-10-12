/**
 * Placeholder rows with the exact geometry of a chat list row (48px avatar, two text lines), so the
 * list fills in place with no layout shift when the real rows arrive.
 */
const LINE = '#1f2127';
const BLOCK = '#16181c';

export const SkeletonRows = ({ count = 6, label = 'Loading' }: { count?: number; label?: string }) => (
  <ul className="w-full" aria-busy="true" aria-label={label}>
    {Array.from({ length: count }, (_, i) => (
      <li key={i} className="w-full flex items-center gap-3 px-4 py-[10px]" aria-hidden="true">
        <div className="rounded-full shrink-0 animate-pulse" style={{ width: 48, height: 48, background: BLOCK }} />
        <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div className="flex items-baseline gap-2">
            <span
              className="h-[15px] my-[3px] rounded animate-pulse"
              style={{ width: `${40 + ((i * 17) % 30)}%`, background: BLOCK }}
            />
            <span className="ml-auto h-[11px] w-8 rounded animate-pulse" style={{ background: BLOCK }} />
          </div>
          <div
            className="mt-[6px] h-[13px] rounded animate-pulse"
            style={{ width: `${55 + ((i * 23) % 35)}%`, background: BLOCK }}
          />
        </div>
      </li>
    ))}
  </ul>
);
