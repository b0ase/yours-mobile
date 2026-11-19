// Shared contract-identity fixtures (b-Aware row 352, UID 630, and its review: F1 and F2). Both the wallet
// (src/mobile/contracts/contractIdentity.test.ts: copiedFrom, publishContract, contractKeys) and the catalogue
// (site/test/contracts.test.js: the real publish route, contractKeys) run on these same descriptors.
export const HASH = 'ab'.repeat(32);
export const OTHER_HASH = `${'ab'.repeat(31)}ac`;
export const SRC = 'contract Escrow {\n  pay(sig) { require(checkSig(sig, buyer)) }\n}';

const head = { format: 'bwalletx.contract/1', name: 'Escrow', version: '1', network: 'mainnet', summary: 's' };
const paths = [{ name: 'pay', who: 'buyer', requires: 'buyer signature' }];
/** A full descriptor: the head plus `fields`; a field set to undefined is left out (as JSON leaves it out). */
export const descriptor = (fields) =>
  Object.fromEntries(Object.entries({ ...head, ...fields }).filter(([, v]) => v !== undefined));

const hashOnly = descriptor({ codeHash: HASH, params: { rate: 5 }, spendPaths: paths });
const sourceOnly = descriptor({ source: SRC, params: { rate: 5 }, spendPaths: paths });
const both = descriptor({ codeHash: HASH, source: SRC, params: { rate: 5 }, spendPaths: paths });
const bare = descriptor({ codeHash: HASH });

/** [what the copier changed, the paid original, the paid copy]: the SAME contract (F1). */
export const sameCode = [
  ['code hash in upper case', hashOnly, { ...hashOnly, codeHash: HASH.toUpperCase() }],
  ['source with a trailing space', sourceOnly, { ...sourceOnly, source: `${SRC} ` }],
  [
    'source with CRLF, trailing spaces and blank lines at the ends',
    sourceOnly,
    { ...sourceOnly, source: `\n\n${SRC.replace(/\n/g, ' \t\r\n')}\r\n\r\n` },
  ],
  // NFKC folds compatibility lookalikes (here a fullwidth E); a Cyrillic look-alike is a different character.
  ['source with a fullwidth lookalike letter', sourceOnly, { ...sourceOnly, source: SRC.replace('E', 'Ｅ') }],
  ["source with an added '#' while the code hash matches", both, { ...both, source: `${SRC}#` }],
  ['code hash left out (the source still matches)', both, descriptor({ ...both, codeHash: undefined })],
  ['source left out (the code hash still matches)', both, descriptor({ ...both, source: undefined })],
  ['param 5 written as "5"', hashOnly, { ...hashOnly, params: { rate: '5' } }],
  ['a junk param key', hashOnly, { ...hashOnly, params: { rate: 5, junk: 'x' } }],
  [
    'one character of a spend path requirement',
    hashOnly,
    { ...hashOnly, spendPaths: [{ ...paths[0], requires: 'buyer signature!' }] },
  ],
  ['an empty oracle added', hashOnly, { ...hashOnly, oracle: { quorum: 0, signers: [] } }],
  ['params: {} added', bare, { ...bare, params: {} }],
  ['spendPaths: [] added', bare, { ...bare, spendPaths: [] }],
  ['source: "" added', bare, { ...bare, source: '' }],
  ['the network', hashOnly, { ...hashOnly, network: 'testnet' }],
];

/** [what changed, original, other]: a DIFFERENT contract (its code is different). */
export const differentCode = [
  ['one hex character of the code hash', hashOnly, { ...hashOnly, codeHash: OTHER_HASH }],
  ['a real change to the source', sourceOnly, { ...sourceOnly, source: SRC.replace('buyer', 'seller') }],
];

/** Paid descriptors the wallet and the catalogue both refuse: no valid code. */
export const paidNoCode = [
  ['no source or code hash', descriptor({ params: { rate: 5 } })],
  ['a blank source', descriptor({ source: ' \r\n\t\n ' })],
  ['a code hash that is not 64 hex characters', descriptor({ codeHash: HASH.slice(1) })],
  ['a code hash with a # in front, even with a source', descriptor({ codeHash: `#${HASH}`, source: SRC })],
];

/** Paid descriptors that are fine: an upper-case code hash, or a source alone. */
export const paidWithCode = [
  ['an upper-case code hash', descriptor({ codeHash: HASH.toUpperCase() })],
  ['a source alone', descriptor({ source: SRC })],
];

/** Free contracts with no code: Ann's "Tip jar" and Bob's unrelated "Escrow" on the same network (F2). */
export const freeTipJar = descriptor({ name: 'Tip jar' });
export const freeEscrow = descriptor({ name: 'Escrow' });
/** [what changed, free original, free copy]: still the same free contract (normalised fields and name). */
export const freeSame = [
  ['spaces around the name', freeTipJar, { ...freeTipJar, name: ' Tip jar ' }],
  ['param 5 written as "5"', { ...freeTipJar, params: { a: 5 } }, { ...freeTipJar, params: { a: ' 5' } }],
  ['empty containers added', freeTipJar, { ...freeTipJar, params: {}, spendPaths: [], source: '', oracle: {} }],
  ['the summary and version', freeTipJar, { ...freeTipJar, summary: 'other words', version: '2' }],
];
