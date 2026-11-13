/**
 * The native seal's fee model (moved here from sealScreen.ts so nativeSeal.ts can hold a seal to the fee its sheet
 * showed). Pure: no imports, no wallet, no clock.
 */

const varintLen = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
const pushLen = (n: number) => (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5);

/** One P2PKH input (148), the 0-sat seal output of `script` bytes and one P2PKH change output (34). */
const txBytesFor = (script: number): number => {
  const opReturnOut = 8 + varintLen(script) + script;
  return 4 + 1 + 148 + 1 + opReturnOut + 34 + 4; // version, ins, P2PKH in, outs, OP_RETURN, change, locktime
};

const feeFor = (bytes: number, satsPerKb: number): number => {
  const rate = Number.isFinite(satsPerKb) && satsPerKb > 0 ? satsPerKb : 100;
  return Math.max(1, Math.ceil((bytes * rate) / 1000));
};

/**
 * The seal transaction's size in bytes, as the wallet will build it: one P2PKH input (148), the 0-sat
 * OP_FALSE OP_RETURN <payload JSON> output (bit-sign seal-inscription.ts sealLockingScriptHex over the v2 payload of
 * nds-seal-record.ts buildSealPayloadV2), and one P2PKH change output (34). Every hash in the payload has a fixed
 * length, so only the field ids and the reference change it.
 */
export const sealTxBytes = (fieldIds: string[], ref: string): number => {
  const h = '0'.repeat(64);
  const payload = {
    protocol: 'b0ase-bitsign',
    version: '2.0',
    type: 'nds_field_seal',
    docHash: h,
    origHash: h,
    recordHash: h,
    svgHash: h,
    fields: fieldIds.join(','),
    key: `02${h}`,
    ref,
    ts: '2026-01-01T00:00:00.000Z',
  };
  const data = new TextEncoder().encode(JSON.stringify(payload)).length;
  return txBytesFor(2 + pushLen(data) + data); // OP_FALSE OP_RETURN <push>
};

/**
 * The seal's network fee by the wallet's OWN fee model: the sat/kB rate its createAction pays (the toolbox feeModel,
 * ChromeStorage getCustomFeeRate, 100 sat/kB by default) × the expected size, rounded up. Owner, 3 Nov 2026: the
 * button said ~715 sats (bit-sign's 1 sat/byte cap) and the seal paid 75. bit-sign's estimateSealFeeSats is only
 * logged now, never shown.
 */
export const estimateSealFee = (fieldIds: string[], ref: string, satsPerKb: number): number =>
  feeFor(sealTxBytes(fieldIds, ref), satsPerKb);

/** The same model over the exact seal output the wallet is about to pay for (its locking script, hex). */
export const sealScriptFee = (lockingScriptHex: string, satsPerKb: number): number =>
  feeFor(txBytesFor(Math.ceil(lockingScriptHex.length / 2)), satsPerKb);
