/** BIP21 for my receive address, so another bWallet (or any wallet) can scan it to pay me. */
export const myPayUri = (address: string) => `bitcoin:${address}`;
