# Plan: BRC-141 animated QR in bWalletX

Status: plan only, no code. Spec: https://bsv.brc.dev/peer-to-peer/0141 (fountain-coded air-gap transport, by Darren Kellenschwiler).

## Why
One QR holds a paymail or a `bitcoin:` URI. It cannot carry a certificate, a BEEF transaction or a signed request. BRC-141 splits a payload into fountain-coded frames shown as a looping animated QR; the scanner rebuilds it from any large-enough subset of frames, in any order, with no network.

## Where we use it
1. **bAvatar card exchange**: hold up your card, the other phone gets the bAvatar plus identity key and paymail certificate (signed), not just a name. Single-frame art QR on the card back stays as is (`src/mobile/wallet/cardBackQr.ts`); animated mode is an extra "Share card" view.
2. **Tap-to-pay payment requests**: full BRC-29 / payment request (amount, outputs, memo, expiry, payee cert) instead of a bare `bitcoin:` URI. Feeds the existing pay flow in `src/mobile/scan/payUri.ts`.
3. **Sweep handoff between devices**: pass a sweep request or the resulting BEEF from one device to another (`src/sweep/`), no server in between. Never private keys: the existing `isPublicPayload` rule in `flipQr.ts` extends to the reassembled payload.
4. **Air-gapped signing**: online device shows an unsigned tx as animated QR, offline device signs and shows the signed tx back. Fits bTrust key shares later.

## How
- Library: `@bsv/air-gap` pinned exactly at `0.1.3` (latest on npm, 16 Oct 2026). No caret.
- Render: our existing `qrcode` package (`src/components/QrCode.tsx`) draws each frame; the library only encodes/decodes frames. Frame rate and size tuned on real phones.
- Scan: existing camera scanner (`src/mobile/scan/Scanner.tsx`, `jsqr`). `parseScan.ts` detects a BRC-141 frame header and switches to a collecting mode with a progress ring; plain QRs behave as today.
- Error correction: **M or higher** on every frame, because frames may sit over bAvatar art or theme framing. Same lesson as `flipQr.ts` (ZXing-js misreads some Q matrices, so test M vs Q before choosing).
- Safety: reassembled payload goes through the same type checks as single QRs, with a size cap, and the one-sheet permission view before anything is paid or signed.

## Tests
- Conformance vectors from the spec / `@bsv/air-gap`: encode and decode must match byte for byte.
- Round-trip with dropped and shuffled frames; decode via jsqr from rendered frames (as `flipQr.testkit.ts` does for single QRs).
- Refusal tests: key-like payloads never encode.

## Store builds
No implications: pure JS, uses the camera permission we already have, no new native code, no new entitlements.
