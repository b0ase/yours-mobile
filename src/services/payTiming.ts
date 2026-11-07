/**
 * Where an own payment's time goes, as one "[payTiming]" line (owner's iPhone, 7 Nov 2026, doc dbb9beec: the seal's
 * single createAction took ~25 s and nothing said why). On iOS the worker forwards only warn and error to the page,
 * so the caller logs the line with console.warn; private test builds keep "[payTiming]" lines in localStorage
 * (mobile/main.ts). Diagnostics only: nothing here changes what is paid or when.
 */
export function payTimer(now: () => number = Date.now) {
  const t0 = now();
  let last = t0;
  const marks: [string, number][] = [];
  return {
    /** The time since the previous mark (or the start), under this name. */
    mark(name: string) {
      const t = now();
      marks.push([name, t - last]);
      last = t;
    },
    total: () => now() - t0,
    line(label: string) {
      const parts = marks.map(([n, ms]) => `${n} ${ms} ms`).join(', ');
      return `[payTiming] ${label}: ${parts ? `${parts}; ` : ''}total ${now() - t0} ms`;
    },
  };
}
