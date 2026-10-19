# Vendored: @bsv/webrtpay 0.1.0 (experimental)

Direct wallet-to-wallet BSV payments over WebRTC data channels, authenticated with BRC-100 identity keys.

- Upstream: https://github.com/bsv-blockchain/ts-stack, `packages/messaging/webrtpay` (PR #1234).
- Commit: `75d29cd95b83f337fb9bc58a8969c754065f4e67` (ts-stack `main`, 19 Oct 2026).
- Not published on npm, so the `src/` tree is copied here byte-for-byte. Protocol: `PROTOCOL.md` (upstream
  `docs/protocol.md`). Licence: `LICENSE.txt` (Open BSV License version 6, BSV Association), not this repo's MIT.
- The Node-only relay server (`server/`) is not copied; nothing here imports `ws` or Node builtins.

Rules:

- Do not edit these files. They are excluded from Prettier and ESLint to stay identical to upstream; type-checking
  still covers them. To update, copy the upstream `src/` again and change the commit above.
- Only `src/mobile/directPay/` may import this directory, and only the lazy `DirectPaySheet` chunk behind
  `DIRECT_PAY_ENABLED` reaches it at runtime (directPay.test.ts checks), so store and default builds carry none of it.
- Its BRC-43 protocols `[2, 'webrtpay channel' | 'webrtpay signaling' | 'webrtpay relay']` are wallet-internal
  (services/reservedProtocolList.ts): outside apps are refused them before any prompt.
- Swap to the npm package once it is published.
