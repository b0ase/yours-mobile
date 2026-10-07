/**
 * bwalletx.com/lock/verify: the same verifier as the app (verify.ts), bundled for the site.
 *   bun build src/mobile/locks/verifyWeb.ts --target browser --minify --outfile <bwalletx-site>/lock/verify.js
 */
import { verifyLockTx } from './verify';

(window as unknown as { bwxVerifyLock: typeof verifyLockTx }).bwxVerifyLock = verifyLockTx;
