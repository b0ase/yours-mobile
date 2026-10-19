/**
 * bmintx.com/check: the same verifier as the app (verify.ts + sources.ts), bundled for the static site.
 *   bun build src/mobile/bmint/check/checkWeb.ts --target browser --minify --outfile <bmintx-site>/check/check.js
 */
import { checkMint } from './sources';
import { parseOutpoint, sha256File } from './verify';

(window as unknown as { bmxCheck: unknown }).bmxCheck = { checkMint, parseOutpoint, sha256File };
