/**
 * Strategies this wallet has unlocked (bought or its own), by the outpoint of the copy, so they load
 * without asking the key service again. The NFT stays the proof of ownership; this is only a cache.
 */
import type { Strategy } from '../agents/strategy';

const KEY = 'bwallet.myStrategies';
type Mine = Record<string, { strategy: Strategy; at: number }>;

export const myStrategies = (): Mine => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Mine;
  } catch {
    return {};
  }
};

export const rememberStrategy = (outpoint: string, strategy: Strategy, now = Date.now()) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...myStrategies(), [outpoint]: { strategy, at: now } }));
  } catch {
    /* storage unavailable: unlock again next time */
  }
};
