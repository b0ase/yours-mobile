import { describe, expect, test } from 'bun:test';
import { OP, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import {
  issueMapScript,
  issuerSigningPrivateKey,
  MAP_PREFIX,
  parseIssueScript,
  scriptSha256,
  signableTicker,
  signIssueWithKey,
  verifyIssueTx,
} from './issuer';

// Regression for the forged-issuer review finding (24 Nov 2026): AIP signs the pushes before the separator with no
// boundaries, so a parser that takes "the first MAP anywhere" accepted a replayed real signature followed by an
// unsigned MAP. Only the canonical layout (signed MAP first, AIP right after) may verify.

const { toArray } = Utils;
const victim = PrivateKey.fromRandom();
const victimKey = victim.toPublicKey().toString();
const push = (s: Script, v: string) => s.writeBin(toArray(v, 'utf8'));

const tokenScript = () => {
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_IF);
  push(s, 'ord');
  return s.writeOpCode(OP.OP_ENDIF);
};

const statementFor = (scriptHex: string, ticker?: string) =>
  signIssueWithKey(
    issueMapScript({ kind: 'bsv21', ticker, scriptSha256: scriptSha256(scriptHex), identityKey: victimKey }),
    issuerSigningPrivateKey(victim),
  );

/** Victim's signed pushes, hidden from a MAP reader (OP_0 in front, or a re-split prefix), then an unsigned MAP after the AIP. */
function forge(signed: Script, pairs: [string, string][], variant: 'op0' | 'resplit'): Script {
  const ch = signed.chunks;
  const ret = ch.findIndex((c) => c.op === OP.OP_RETURN);
  const pipe = ch.findIndex((c, i) => i > ret && c.data?.length === 1 && c.data[0] === 0x7c);
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  const signedPushes = ch.slice(ret + 1, pipe);
  if (variant === 'op0') {
    s.writeOpCode(OP.OP_0);
    for (const c of signedPushes) s.writeBin(c.data!);
  } else {
    const first = signedPushes[0].data!;
    s.writeBin(first.slice(0, 5));
    s.writeBin(first.slice(5));
    for (const c of signedPushes.slice(1)) s.writeBin(c.data!);
  }
  for (const c of ch.slice(pipe)) s.writeBin(c.data!);
  s.writeBin([0x7c]);
  push(s, MAP_PREFIX);
  push(s, 'SET');
  for (const [k, v] of pairs) {
    push(s, k);
    push(s, v);
  }
  return s;
}

const verifyIn = (token: Script, statement: Script) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: token, satoshis: 1 });
  tx.addOutput({ lockingScript: statement, satoshis: 0 });
  const parsed = Transaction.fromHex(tx.toHex()); // as a reader sees it
  return verifyIssueTx(parsed, `${parsed.id('hex')}_0`);
};

describe('issuer statements: only the canonical layout verifies', () => {
  test('a genuine statement still verifies (with and without ticker)', () => {
    const tok = tokenScript();
    const a = verifyIn(tok, statementFor(tok.toHex()));
    expect(a.ok).toBe(true);
    const b = verifyIn(tok, statementFor(tok.toHex(), 'VOID'));
    expect(b.ok).toBe(true);
  });

  for (const variant of ['op0', 'resplit'] as const) {
    test(`a replayed signature with an unsigned MAP after it is refused (${variant})`, () => {
      const tok = tokenScript();
      const other = new Script().writeOpCode(OP.OP_TRUE); // the victim signed a statement for some other output
      const forged = forge(
        statementFor(other.toHex()),
        [
          ['app', 'bWallet'],
          ['type', 'issue'],
          ['kind', 'bsv21'],
          ['script_sha256', scriptSha256(tok.toHex())],
          ['identity_key', victimKey],
        ],
        variant,
      );
      expect(parseIssueScript(forged)).toBeNull();
      expect(verifyIn(tok, forged).ok).toBe(false);
    });
  }

  test('extra, duplicate or reordered keys and empty pushes are refused', () => {
    const tok = tokenScript();
    const h = scriptSha256(tok.toHex());
    const variants: [string, string][][] = [
      [
        ['app', 'bWallet'],
        ['type', 'issue'],
        ['kind', 'bsv21'],
        ['script_sha256', h],
        ['identity_key', victimKey],
        ['x', 'y'],
      ],
      [
        ['app', 'bWallet'],
        ['app', 'bWallet'],
        ['type', 'issue'],
        ['kind', 'bsv21'],
        ['script_sha256', h],
        ['identity_key', victimKey],
      ],
      [
        ['type', 'issue'],
        ['app', 'bWallet'],
        ['kind', 'bsv21'],
        ['script_sha256', h],
        ['identity_key', victimKey],
      ],
    ];
    for (const pairs of variants) {
      const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
      push(s, MAP_PREFIX);
      push(s, 'SET');
      for (const [k, v] of pairs) {
        push(s, k);
        push(s, v);
      }
      expect(verifyIn(tok, signIssueWithKey(s, issuerSigningPrivateKey(victim))).ok).toBe(false);
    }
    // An empty push inside the signed MAP (aipMessage skips it, so the signature would still match).
    const real = statementFor(tok.toHex()).chunks;
    const withGap = new Script(real.slice(0, 4));
    withGap.writeOpCode(OP.OP_0);
    for (const c of real.slice(4)) withGap.writeBin(c.data!);
    expect(verifyIn(tok, withGap).ok).toBe(false);
  });

  test('a genuine statement still verifies when every push is re-encoded as PUSHDATA1', () => {
    const tok = tokenScript();
    const real = statementFor(tok.toHex(), 'VOID').chunks;
    const re = new Script([...real.slice(0, 2), ...real.slice(2).map((c) => ({ op: OP.OP_PUSHDATA1, data: c.data }))]);
    expect(verifyIn(tok, re).ok).toBe(true);
  });

  test('tickers that cannot round-trip are left out of the statement, so the issuer still verifies', () => {
    expect(signableTicker('|')).toBeNull();
    expect(signableTicker('\uFEFFX')).toBeNull();
    expect(signableTicker('')).toBeNull();
    expect(signableTicker('VOID')).toBe('VOID');
    expect(signableTicker('A|B')).toBe('A|B');
    const tok = tokenScript();
    expect(verifyIn(tok, statementFor(tok.toHex(), signableTicker('\uFEFFX') ?? undefined)).ok).toBe(true);
  });
});
