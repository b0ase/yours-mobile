// Shared contract-identity fixtures (b-Aware row 352, UID 630, and its reviews). Both the wallet
// (src/mobile/contracts/contractIdentity.test.ts: copiedFrom, publishContract, contractKeys) and the catalogue
// (site/test/contracts.test.js: the real publish route, contractKeys) run on these same descriptors.
import { createHash } from 'node:crypto';

export const SRC = 'contract Escrow {\n  pay(sig) { require(checkSig(sig, buyer)) }\n}';
/** sha256 of SRC (already normalised): the only code hash a listing with SRC may carry. */
export const HASH = createHash('sha256').update(SRC, 'utf8').digest('hex');
/** Some other code's hash: a squatter's claim, never proven by a source. */
export const OTHER_HASH = createHash('sha256').update('something else', 'utf8').digest('hex');

const head = { format: 'bwalletx.contract/1', name: 'Escrow', version: '1', network: 'mainnet', summary: 's' };
const paths = [{ name: 'pay', who: 'buyer', requires: 'buyer signature' }];
/** A full descriptor: the head plus `fields`; a field set to undefined is left out (as JSON leaves it out). */
export const descriptor = (fields) =>
  Object.fromEntries(Object.entries({ ...head, ...fields }).filter(([, v]) => v !== undefined));

const sourced = descriptor({ source: SRC, params: { rate: 5 }, spendPaths: paths });
const hashed = descriptor({ source: SRC, codeHash: HASH, params: { rate: 5 }, spendPaths: paths });
const bare = descriptor({ source: SRC });

/**
 * [what the copier changed, the paid original, the paid copy]: the SAME contract, and the copy is in the stored form,
 * so the catalogue finds the original and answers 409.
 */
export const sameCode = [
  ['param 5 written as "5"', sourced, { ...sourced, params: { rate: '5' } }],
  ['a junk param key', sourced, { ...sourced, params: { rate: 5, junk: 'x' } }],
  [
    'one character of a spend path requirement',
    sourced,
    { ...sourced, spendPaths: [{ ...paths[0], requires: 'buyer signature!' }] },
  ],
  ['an empty oracle added', sourced, { ...sourced, oracle: { quorum: 0, signers: [] } }],
  ['params: {} added', bare, { ...bare, params: {} }],
  ['spendPaths: [] added', bare, { ...bare, spendPaths: [] }],
  ['the network', sourced, { ...sourced, network: 'testnet' }],
  ['the matching code hash added', sourced, { ...sourced, codeHash: HASH }],
  ['the code hash left out', hashed, descriptor({ ...hashed, codeHash: undefined })],
];

/**
 * [what changed, paid original, paid copy]: the same contract, but the copy's text isn't in the stored form. The
 * wallet's identity matches it, the wallet's publish normalises it before signing, and the catalogue refuses it (400).
 */
export const sameCodeUnnormalised = [
  ['source with a trailing space', sourced, { ...sourced, source: `${SRC} ` }],
  [
    'source with CRLF, trailing spaces and blank lines at the ends',
    sourced,
    { ...sourced, source: `\n\n${SRC.replace(/\n/g, ' \t\r\n')}\r\n\r\n` },
  ],
  // NFKC folds compatibility lookalikes (here a fullwidth E); a Cyrillic look-alike is a different character.
  ['source with a fullwidth lookalike letter', sourced, { ...sourced, source: SRC.replace('E', 'Ｅ') }],
  ['code hash in upper case', hashed, { ...hashed, codeHash: HASH.toUpperCase() }],
];

/** [what changed, original, other]: a DIFFERENT contract (its source is different). */
export const differentCode = [
  ['a real change to the source', sourced, { ...sourced, source: SRC.replace('buyer', 'seller') }],
];

/** Paid descriptors the wallet and the catalogue both refuse: no source, or a code hash that isn't the source's. */
export const paidNoCode = [
  ['no source or code hash', descriptor({ params: { rate: 5 } })],
  ['a blank source', descriptor({ source: ' \r\n\t\n ' })],
  ["a code hash alone (someone's hash, no source)", descriptor({ codeHash: HASH })],
  ["someone else's code hash with this source", descriptor({ source: SRC, codeHash: OTHER_HASH })],
  ['a code hash that is not 64 hex characters', descriptor({ source: SRC, codeHash: HASH.slice(1) })],
];

/** Paid descriptors that are fine: a source alone, or a source with its own code hash. */
export const paidWithCode = [
  ['a source alone', descriptor({ source: SRC })],
  ['a source with its matching code hash', descriptor({ source: SRC, codeHash: HASH })],
];

/** Free contracts with no code: Ann's "Tip jar" and Bob's unrelated "Escrow" on the same network (F2 of the first review). */
export const freeTipJar = descriptor({ name: 'Tip jar' });
export const freeEscrow = descriptor({ name: 'Escrow' });
/** [what changed, free original, free copy]: still the same free contract (normalised fields and name). */
export const freeSame = [
  ['spaces around the name', freeTipJar, { ...freeTipJar, name: ' Tip jar ' }],
  ['param 5 written as "5"', { ...freeTipJar, params: { a: 5 } }, { ...freeTipJar, params: { a: ' 5' } }],
  ['empty containers added', freeTipJar, { ...freeTipJar, params: {}, spendPaths: [], oracle: {} }],
  ['the summary and version', freeTipJar, { ...freeTipJar, summary: 'other words', version: '2' }],
  ['a bare code hash added (no source: still no code)', freeTipJar, { ...freeTipJar, codeHash: OTHER_HASH }],
];
