# Phone to phone (prototype)

Pay someone standing next to you by QR, phone to phone, with no server. First step of the tap-to-pay idea
(BLE/NFC later replaces the QR codes as the signaling carrier).

**Status:** prototype, OFF by default (`VITE_DIRECT_PAY=1`), never in a store build (`DIRECT_PAY_ENABLED`,
src/mobile/storeBuild.ts). Money path: owner review before it is turned on anywhere.

## How it works

Built on the vendored `@bsv/webrtpay` 0.1.0 (src/vendor/webrtpay, see its README).

1. **Payee:** Scan › Phone to phone › optional amount › shows an offer QR (`webrtpay1:…`, 5 minutes).
2. **Payer:** Scan › reads the offer. One approval sheet (ApprovalCard, "bWalletX · Phone to phone"): amount,
   payee identity key in Details. Nothing is answered (no ICE, no clock) and nothing is spent before Pay.
3. **Payer:** Pay → shows an answer QR. **Payee:** Scan their code (within about 15 s).
4. The data channel opens; both wallets sign the DTLS transcript under `[2, 'webrtpay channel']` (identity bound to
   the channel, so whoever carries the QR codes cannot redirect anything).
5. Payer builds the BRC-29 payment (PeerPay `PaymentToken`: AtomicBEEF + derivation prefix/suffix) with `noSend`,
   checks the channel is still open (else aborts: nothing spent), broadcasts, sends the token, waits for the ack.
6. Payee runs `verifyDirectPayment` (the output pays this wallet's BRC-29 key for the proven sender, exact amount)
   BEFORE `internalizeAction`; a re-delivered token is acknowledged without internalizing twice (seen store).
7. Both see a success screen; History labels both sides **phone to phone** (txHistory.ts).

Fallback: if the phones can't connect, nothing was spent; the sheet says so and offers **Send normally** (the Send
card with the amount; they type the $name).

Undelivered: if the broadcast happened but no ack came back, the token is kept on the payer's device
(`bwx.directpay.pending`). The next phone-to-phone session with the same payee delivers that token first and spends
nothing new.

## Security notes

- Wallet calls carry no originator: the UI's wallet is the wallet itself (admin), so no permission prompt; the
  approval sheet is the user's consent.
- `[2, 'webrtpay channel' | 'webrtpay signaling' | 'webrtpay relay']` are reserved (audit C1): an outside app with
  the channel key could pose as the user to a payer or payee. Side effect: outside webrtpay apps can't use bWalletX
  for channel auth.
- Prototype cap: 0.1 BSV per payment (`MAX_DIRECT_SATS`).
- STUN: `VITE_DIRECT_PAY_STUN` (default `stun:stun.l.google.com:19302`), which sees both phones' public IPs. No TURN:
  phones on networks that can't punch through fail and fall back.
- Offer/answer QR codes show the phone's candidate IP addresses to anyone who can read them (upstream README).

## Tests

- `src/mobile/directPay/directPay.test.ts`: token validation path, re-delivery, payer order (abort before broadcast,
  keep after), reserved protocol handling, flag off + no static imports, History label.
- `src/mobile/directPay/directPay.loopback.test.ts`: two wallets over a real WebRTC data channel (node-datachannel,
  skipped unless `WEBRTPAY_NDC` points at an install).

Not yet tested: two real phones (iOS WKWebView ↔ Android WebView, cellular NAT), the extension side panel.
