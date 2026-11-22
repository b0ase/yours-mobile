// Stub (report #385, red step): the real repair follows in the next commit.
export class HeldAsFailedError extends Error {
  constructor(
    public txid: string,
    public reason: 'not-mined' | 'unavailable' | 'unrepaired',
  ) {
    super(`held as failed: ${txid}`);
    this.name = 'HeldAsFailedError';
  }
}
export const isHeldAsFailed = (_e: unknown): _e is HeldAsFailedError => false;
export const withFailedRowRepair = <W>(wallet: W, _deps: unknown): W => wallet;
export const makeUnfailRepair = (_w: unknown) => async () => 'unavailable' as const;
