/// <reference lib="webworker" />
import { mineRange } from './opnsPow';

/**
 * OpNS miner worker. One job = one character.
 *   in:  { pow: number[], char: number, prefix: number[] }
 *   out: { type: 'progress', tried, rate } … then { type: 'found', nonce, hash, tried }
 * The page cancels by terminating the worker.
 */
declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 256 * 256; // ~65k attempts between progress reports

self.onmessage = (e: MessageEvent<{ pow: number[]; char: number; prefix: number[] }>) => {
  const { pow, char, prefix } = e.data;
  const t0 = performance.now();
  let tried = 0;
  let ctr = 0;
  for (;;) {
    const r = mineRange(pow, char, prefix, ctr, CHUNK);
    if ('nonce' in r) {
      self.postMessage({ type: 'found', nonce: r.nonce, hash: r.hash, tried: tried + CHUNK / 2 });
      return;
    }
    tried += r.tried;
    ctr += r.tried / 256;
    const secs = (performance.now() - t0) / 1000;
    self.postMessage({ type: 'progress', tried, rate: secs > 0 ? tried / secs : 0 });
    if (ctr >= 0xffffffff) {
      self.postMessage({ type: 'exhausted', tried });
      return;
    }
  }
};
