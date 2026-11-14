import { afterEach, beforeEach, expect } from 'bun:test';

/**
 * Run `fn` with console.error / console.warn (and optionally console.log) swapped for recorders, and put the real
 * ones back in `finally`. Used where a test deliberately causes an error that the code (or an upstream library)
 * logs: the test asserts those exact lines instead of letting them print as noise, so an unexpected extra log fails
 * the test rather than scrolling past in the run output.
 */
export type ConsoleLevel = 'error' | 'warn' | 'log' | 'info';
export type Captured = Record<ConsoleLevel, unknown[][]>;

export async function captureConsole<T>(
  fn: () => T | Promise<T>,
  levels: ConsoleLevel[] = ['error', 'warn'],
): Promise<{ result: T; logs: Captured }> {
  const logs: Captured = { error: [], warn: [], log: [], info: [] };
  const c = console as unknown as Record<ConsoleLevel, (...a: unknown[]) => void>;
  const saved = levels.map((l) => [l, c[l]] as const);
  for (const l of levels) c[l] = (...a: unknown[]) => void logs[l].push(a);
  try {
    return { result: await fn(), logs };
  } finally {
    for (const [l, f] of saved) c[l] = f;
  }
}

/** The message of an Error (or the string itself) in a captured argument, for assertions. */
export function msgOf(a: unknown): string {
  return a instanceof Error ? a.message : String(a);
}

/** One captured call as a line: "warn [tag] message …" (Errors by message, objects as JSON). */
export function renderCall(level: ConsoleLevel, args: unknown[]): string {
  const part = (a: unknown) =>
    typeof a === 'string' ? a : a instanceof Error ? a.message : a === undefined ? 'undefined' : JSON.stringify(a);
  return [level, ...args.map(part)].join(' ');
}

/**
 * For a file where many tests log on purpose: every test runs with the given console levels recorded, and after it
 * the recorded lines must match exactly what the test declared with `expectLines(...)` (nothing, if it declared
 * nothing): same count, same order, each line equal to the string or matching the RegExp. A log the test did not
 * expect, a missing one or a different message fails that test.
 */
export function consoleGate(levels: ConsoleLevel[] = ['error', 'warn']) {
  const c = console as unknown as Record<ConsoleLevel, (...a: unknown[]) => void>;
  let saved: (readonly [ConsoleLevel, (...a: unknown[]) => void])[] = [];
  let got: string[] = [];
  let want: (string | RegExp)[] = [];
  beforeEach(() => {
    got = [];
    want = [];
    saved = levels.map((l) => [l, c[l]] as const);
    for (const l of levels) c[l] = (...a: unknown[]) => void got.push(renderCall(l, a));
  });
  afterEach(() => {
    for (const [l, f] of saved) c[l] = f;
    const same =
      got.length === want.length && want.every((w, i) => (typeof w === 'string' ? w === got[i] : w.test(got[i])));
    if (!same) expect(got).toEqual(want.map(String)); // fails, showing both lists
  });
  return {
    /** The lines this test logs, in order (renderCall format: "warn [tag] message"), as strings or patterns. */
    expectLines: (...lines: (string | RegExp)[]) => void want.push(...lines),
    /** `n` lines matching `line`. */
    expectRepeated: (n: number, line: string | RegExp) => void want.push(...Array.from({ length: n }, () => line)),
  };
}
