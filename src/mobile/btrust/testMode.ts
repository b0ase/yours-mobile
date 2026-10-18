// bTrust test timings (heirs can claim 3 blocks after building, lead heir 3 blocks later), for a tiny real-money
// test. Developer builds only: in every other build import.meta.env.DEV is the literal false, so the check below
// is dead code and the minifier drops it (and the flag name) from the bundle.

export const TEST_BANNER = 'TEST: heirs can claim within the hour';

type Env = { dev: boolean; href?: string; flag?: string | null };

/** Pure rule (tested): only a developer build may turn test mode on, by URL or localStorage. */
export const testModeFor = ({ dev, href = '', flag = null }: Env) => dev && (/btrust-test/.test(href) || flag === '1');

export function btrustTestMode(): boolean {
  if (!import.meta.env.DEV) return false;
  let flag: string | null = null;
  try {
    flag = localStorage.getItem('btrust-test');
  } catch {
    /* storage blocked */
  }
  return testModeFor({ dev: true, href: typeof window === 'undefined' ? '' : window.location.href, flag });
}
