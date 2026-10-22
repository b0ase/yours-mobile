import { useCallback, useEffect, useRef, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { scanTokenLocks, type TokenLockScan } from './tokenLockApi';
import { tokenLocksScanned } from './tokenLocks';

export type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning'; detail: string }
  | { kind: 'done'; found: number; added: number }
  | { kind: 'error'; message: string };

/** "Find my token locks": run on demand, or once by itself (`auto`) when this device has never scanned. */
export function useTokenLockScan(
  ctx: OneSatContext,
  account: string,
  cs: ChromeStorageService | undefined,
  onScanned: (scan: TokenLockScan) => void,
  auto = false,
) {
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const live = useRef(true);
  const done = useRef(onScanned);
  done.current = onScanned;
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const run = useCallback(async () => {
    if (!account || !ctx.services) return;
    setState({ kind: 'scanning', detail: 'Starting…' });
    try {
      const res = await scanTokenLocks(
        ctx,
        account,
        cs,
        (detail) => live.current && setState({ kind: 'scanning', detail }),
      );
      if (!live.current) return;
      setState({ kind: 'done', found: res.found, added: res.added });
      done.current(res);
    } catch (e) {
      if (live.current)
        setState({
          kind: 'error',
          message: `Couldn't search the chain right now${e instanceof Error && e.message ? ` (${e.message})` : ''}. Your locks are safe; try again later.`,
        });
    }
  }, [ctx, account, cs]);

  const autoTried = useRef(false);
  useEffect(() => {
    if (!auto || autoTried.current || !account || !ctx.services || tokenLocksScanned(account)) return;
    autoTried.current = true;
    void run();
  }, [auto, account, ctx.services, run]);

  return { state, run };
}

export const scanLine = (s: ScanState): string | null =>
  s.kind === 'scanning'
    ? s.detail
    : s.kind === 'error'
      ? s.message
      : s.kind === 'done'
        ? s.found === 0
          ? 'No token locks found on chain for this wallet.'
          : s.added > 0
            ? `Found ${s.found} token lock${s.found === 1 ? '' : 's'} on chain (${s.added} new).`
            : `Found ${s.found} token lock${s.found === 1 ? '' : 's'} on chain, all already listed.`
        : null;
