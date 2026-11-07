/**
 * The bit-sign phone-signing call names (pair/bitsign.ts has the contract), alone so the dApp browser's injected
 * provider (dapp/provider.ts) can name them without pulling in the pad code.
 */
export const BITSIGN_CAPABILITIES = 'bitsign.capabilities';
export const BITSIGN_DRAW = 'bitsign.drawSignature';
export const isBitsignAction = (action: string) => action === BITSIGN_CAPABILITIES || action === BITSIGN_DRAW;
