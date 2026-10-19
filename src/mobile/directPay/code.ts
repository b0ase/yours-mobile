/**
 * Phone to phone: does scanned text look like a webrtpay code? Deliberately free of any import from the vendored
 * package so the Scan sheet can ask without pulling it in (directPay.test.ts checks the prefix matches the package's
 * CODE_PREFIX). Callers only ask behind DIRECT_PAY_ENABLED, so store builds drop the check and the string.
 */
export const DIRECT_PAY_CODE = /^\s*webrtpay1:/i;

export const isDirectPayCode = (text: string | null | undefined): boolean => DIRECT_PAY_CODE.test(text ?? '');
