/**
 * Side-effect import, first in every entry: AbortSignal.timeout / AbortSignal.any on iOS 15 (utils/abortTimeout.ts).
 */
import { installAbortSignalPolyfill } from './abortTimeout';

installAbortSignalPolyfill();
