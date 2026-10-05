// Exchange › Contracts (src/mobile/contracts/contractNft.ts): a contract is a PUBLIC 1Sat NFT, so buyers can
// read and audit it. Each copy is the same envelope inscribed again; a buyer's copy is minted in the
// transaction that pays the author. This module parses envelopes; the chain checks are shared with
// strategies (strategyKeys.js).
const CONTRACT_TYPE = 'application/vnd.bwalletx.contract+json';
const CONTRACT_FORMAT = 'bwalletx.contract-nft/1';

function parseContractEnvelope(text) {
  try {
    const o = JSON.parse(text);
    if (o?.format !== CONTRACT_FORMAT || !o.contract || typeof o.contract !== 'object' || !o.sale || !o.author) return null;
    if (o.contract.format !== 'bwalletx.contract/1' || typeof o.contract.name !== 'string') return null;
    const price = Number(o.sale.priceUsd);
    const copies = Number(o.sale.copies);
    if (!(price >= 0) || !Number.isInteger(copies) || copies < 1 || typeof o.sale.payTo !== 'string') return null;
    if (!['testnet', 'mainnet'].includes(o.contract.network)) return null;
    return o;
  } catch {
    return null;
  }
}

module.exports = { CONTRACT_TYPE, CONTRACT_FORMAT, parseContractEnvelope };
