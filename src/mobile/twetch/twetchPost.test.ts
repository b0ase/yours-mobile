import { describe, expect, test } from 'bun:test';
import { PrivateKey, Script, Utils } from '@bsv/sdk';
import { AIP } from '@1sat/templates';
import {
  AIP_PREFIX,
  B_PREFIX,
  CHALLENGE_SKEW_MS,
  MAP_PREFIX,
  TEXT_MAX,
  aipMessage,
  assemblePostScript,
  bsmVerifyAddress,
  buildPostScript,
  dataPushes,
  feeLabel,
  mapFields,
  previewText,
  signChallenge,
  validateChallenge,
  validatePostParams,
} from './twetchPost';

/**
 * A live Twetch reply (public chain data, no secrets): tx 03686ac2eaf6d975d1608b6c86cfd3b462b540c9272ec9e6f64e0d1ff43f5f0b,
 * user 19, "i fuk wit it" replying to 05c3bbce…82bf. This is its whole OP_RETURN output script.
 */
const LIVE = {
  text: 'i fuk wit it',
  replyTxid: '05c3bbcee3fa4cae0fc532fa49cc47c3057364696e58cfba0f13cb4ac32e82bf',
  address: '1QBZzd7c2CbEMRm18NrntqiMuy7VaJcZkE',
  signature: 'H2kNNSU9dbBjgB+HXM/RXvQOMXFUw0AkzeGPeTNyS6ESC8ZQiM/b9iIZzbDgHW6Ks+K3oSgoST5qz1AAJRlSi0w=',
  script:
    '006a2231394878696756345179427633744870515663554551797131707a5a56646f4175740c692066756b207769742069740d746578742f6d61726b646f776e055554462d38017c223150755161374b36324d694b43747373534c4b79316b683536575755374d74555235035345540361707006747765746368047479706504706f7374057265706c794030356333626263656533666134636165306663353332666134396363343763333035373336343639366535386366626130663133636234616333326538326266017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f4543445341223151425a7a643763324362454d526d31384e726e7471694d75793756614a635a6b454c5848326b4e4e5355396462426a67422b48584d2f525876514f4d5846557730416b7a65475065544e795336455343385a51694d2f623969495a7a6244674857364b732b4b336f53676f535435717a3141414a526c536930773d',
};

/** @1sat/templates' AIP verifier (go-templates / bmap rules), fed the B and MAP protocols before the AIP. */
const oneSatValid = (pushes: number[][], address: string, sigB64: string) => {
  const proto = (from: number, to: number) => {
    const s = new Script();
    for (const p of pushes.slice(from + 1, to)) s.writeBin(p);
    return { protocol: Utils.toUTF8(pushes[from]), script: s.toBinary(), pos: 0 };
  };
  const pipe = pushes.findIndex((p) => Utils.toUTF8(p) === '|');
  const aip = new AIP({
    algorithm: 'BITCOIN_ECDSA',
    address,
    signature: Utils.toArray(sigB64, 'base64'),
    fieldIndexes: undefined,
    valid: undefined,
  } as never);
  AIP.validateAIP(aip, [proto(0, pipe), proto(pipe + 1, pushes.length - 1)]);
  return aip.verify();
};

describe('Twetch post layout', () => {
  test('rebuilds a live Twetch post byte for byte', () => {
    const pushes = dataPushes({ text: LIVE.text, replyTxid: LIVE.replyTxid });
    expect(assemblePostScript(pushes, LIVE.address, LIVE.signature)).toBe(LIVE.script);
  });

  test('the AIP payload is 0x6a + every push before AIP (both pipes): the live signature verifies over it', () => {
    const pushes = dataPushes({ text: LIVE.text, replyTxid: LIVE.replyTxid });
    expect(bsmVerifyAddress(aipMessage(pushes), LIVE.signature, LIVE.address)).toBe(true);
    // ...and not over the near misses
    expect(bsmVerifyAddress([...aipMessage(pushes), 0x7c], LIVE.signature, LIVE.address)).toBe(false);
    expect(bsmVerifyAddress(aipMessage(pushes).slice(1), LIVE.signature, LIVE.address)).toBe(false);
    expect(oneSatValid(pushes, LIVE.address, LIVE.signature)).toBe(true);
  });

  test('field order: B | MAP SET app twetch type post reply files ts |', () => {
    expect(
      mapFields({ text: 'x', replyTxid: 'a'.repeat(64), files: ['b://' + 'c'.repeat(64)] }, 1793000000000),
    ).toEqual([
      'SET',
      'app',
      'twetch',
      'type',
      'post',
      'reply',
      'a'.repeat(64),
      'files',
      `["b://${'c'.repeat(64)}"]`,
      'ts',
      '1793000000000',
    ]);
    const p = dataPushes({ text: 'hi' }).map((b) => Utils.toUTF8(b));
    expect(p).toEqual([
      B_PREFIX,
      'hi',
      'text/markdown',
      'UTF-8',
      '|',
      MAP_PREFIX,
      'SET',
      'app',
      'twetch',
      'type',
      'post',
      '|',
    ]);
  });

  test('a post we build verifies with our verifier and @1sat/templates', () => {
    const key = PrivateKey.fromRandom();
    const input = { text: 'gm from bChatX\n\nline two ✨', replyTxid: 'b'.repeat(64) };
    const hex = buildPostScript(input, key, 1793000000000);
    const pushes = dataPushes(input, 1793000000000);
    const tail = Utils.toHex(Utils.toArray(AIP_PREFIX, 'utf8'));
    expect(hex.startsWith('006a')).toBe(true);
    expect(hex).toContain(tail);
    // Pull the signature back out: last push, base64 text.
    const sig = Utils.toUTF8(Utils.toArray(hex.slice(-176), 'hex'));
    const address = key.toPublicKey().toAddress();
    expect(hex).toBe(assemblePostScript(pushes, address, sig));
    expect(bsmVerifyAddress(aipMessage(pushes), sig, address)).toBe(true);
    expect(oneSatValid(pushes, address, sig)).toBe(true);
    expect(bsmVerifyAddress(aipMessage(pushes), sig, PrivateKey.fromRandom().toPublicKey().toAddress())).toBe(false);
  });

  test('long text uses PUSHDATA2', () => {
    const key = PrivateKey.fromRandom();
    const hex = buildPostScript({ text: 'a'.repeat(1000) }, key);
    expect(hex).toContain('4de803' + '61'.repeat(1000));
  });
});

describe('validatePostParams', () => {
  test('accepts text, a reply and file refs', () => {
    expect(
      validatePostParams({ text: 'hi', replyTxid: 'a'.repeat(64), files: ['b://' + 'c'.repeat(64) + '@1'] }),
    ).toEqual({
      text: 'hi',
      replyTxid: 'a'.repeat(64),
      files: ['b://' + 'c'.repeat(64) + '@1'],
    });
  });
  test('refuses oversized or empty text', () => {
    expect(validatePostParams({ text: 'a'.repeat(TEXT_MAX) })).toEqual({ text: 'a'.repeat(TEXT_MAX) });
    expect(validatePostParams({ text: 'a'.repeat(TEXT_MAX + 1) })).toMatch(/at most 25000/);
    expect(validatePostParams({ text: '   ' })).toMatch(/required/);
    expect(validatePostParams({})).toMatch(/required/);
    expect(validatePostParams(null)).toMatch(/object/);
  });
  test('refuses control and bidi characters, lone surrogates', () => {
    expect(validatePostParams({ text: 'a\u0000b' })).toMatch(/not allowed/);
    expect(validatePostParams({ text: 'evil\u202etxt' })).toMatch(/not allowed/);
    expect(validatePostParams({ text: 'x\ud800' })).toMatch(/not allowed/);
    expect(validatePostParams({ text: 'tab\tand\nnewline' })).toEqual({ text: 'tab\tand\nnewline' });
  });
  test('refuses a bad reply txid, bad files, unknown fields', () => {
    expect(validatePostParams({ text: 'x', replyTxid: 'A'.repeat(64) })).toMatch(/replyTxid/);
    expect(validatePostParams({ text: 'x', replyTxid: 'a'.repeat(63) })).toMatch(/replyTxid/);
    expect(validatePostParams({ text: 'x', files: ['https://evil.example/x.png'] })).toMatch(/b:\/\//);
    expect(validatePostParams({ text: 'x', files: Array(11).fill('b://' + 'c'.repeat(64)) })).toMatch(/at most 10/);
    expect(validatePostParams({ text: 'x', app: 'other' })).toMatch(/unknown field app/);
  });
});

describe('login challenge', () => {
  const now = 1793083013296;
  const good = `twetch-login:${'1'.repeat(64)}:${now}`;
  test("signs only Twetch's challenge format", () => {
    expect(validateChallenge({ challenge: good }, now)).toEqual({ challenge: good });
    for (const bad of [
      '',
      'hello',
      `twetch-login:${'1'.repeat(64)}`,
      `twetch-login:${'G'.repeat(64)}:${now}`,
      `twetch-login:${'1'.repeat(64)}:${now}\n`,
      `Sign in to bank:${'1'.repeat(64)}:${now}`,
      `twetch-login:${'1'.repeat(64)}:${now}\u0000`,
      'x'.repeat(5000),
      `${'a'.repeat(32)}`,
    ])
      expect(typeof validateChallenge({ challenge: bad }, now)).toBe('string');
    expect(typeof validateChallenge({ challenge: 42 }, now)).toBe('string');
    expect(typeof validateChallenge('twetch-login', now)).toBe('string');
  });
  test('refuses stale or far-future challenges', () => {
    expect(validateChallenge({ challenge: good }, now + CHALLENGE_SKEW_MS + 1)).toBe('challenge expired');
    expect(validateChallenge({ challenge: good }, now - CHALLENGE_SKEW_MS - 1)).toBe('challenge expired');
  });
  test('the signature is a BSM signature of the challenge by the key', () => {
    const key = PrivateKey.fromRandom();
    const sig = signChallenge(good, key);
    expect(bsmVerifyAddress(Utils.toArray(good, 'utf8'), sig, key.toPublicKey().toAddress())).toBe(true);
  });
});

describe('sheet helpers', () => {
  test('preview cuts long text', () => {
    expect(previewText('short')).toBe('short');
    expect(previewText('a'.repeat(400))).toBe('a'.repeat(280) + '…');
  });
  test('fee in dollars', () => {
    expect(feeLabel(200, 40)).toBe('under $0.01');
    expect(feeLabel(100_000, 40)).toBe('$0.04');
    expect(feeLabel(200, 0)).toBe('200 sats');
  });
});
