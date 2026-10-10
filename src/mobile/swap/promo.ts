import type { SwapStage } from './swapApi';

/** Short stage text for the wallet's "Swap in progress · <stage>" card. */
export const stageLabel = (s: SwapStage): string =>
  ({
    waiting: 'waiting for your deposit',
    deposit_seen: 'deposit seen',
    swapping: 'swapping',
    on_hold: 'on hold at ChangeNOW',
    sending: 'sending BSV',
    done: 'done',
    failed: 'needs attention',
    refunded: 'refunded',
    expired: 'expired',
  })[s] ?? s;
