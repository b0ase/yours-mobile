import { describe, expect, test } from 'bun:test';
import { Beef, BSM, P2PKH, PrivateKey, Script, Signature, Spend, Transaction, Utils } from '@bsv/sdk';
import {
  buildMeltTx,
  burnScript,
  checkQuote,
  meltChallenge,
  pollMelt,
  signChallenge,
  splitAvatar,
  type MeltQuote,
} from './npgMelt';

const JIG_KEY = new PrivateKey(42);
const ORIGIN = `${'ab'.repeat(32)}_o3`;

// A RelayX-era parent: output 0 is the 273-sat P2PKH jig at the holder's address.
const parent = new Transaction();
parent.addOutput({ lockingScript: new P2PKH().lock(JIG_KEY.toAddress()), satoshis: 273 });
const LOCATION = `${parent.id('hex')}_o0`;

const quote = (over: Partial<MeltQuote> = {}): MeltQuote => ({
  quote_id: 'mq_test123',
  expires: new Date(Date.now() + 600_000).toISOString(),
  series: 2,
  n: 9,
  name: 'Naora',
  elements: [
    { file: 'T_018_Hair.png', hue: -102, slot: 'Hair' },
    { file: 's2/v2/0009.webp', slot: 'avatar' },
  ],
  note: null,
  challenge: meltChallenge('mq_test123', LOCATION),
  burn_script_hex: burnScript(ORIGIN, 'mq_test123').toHex(),
  fee_sats: 0,
  fee_to: null,
  mint: { count: 2, sats_each: 1 },
  ...over,
});

describe('npg melt', () => {
  test('burn script is OP_FALSE OP_RETURN "npg-melt" <origin> <quote_id>, byte for byte', () => {
    const hex = burnScript(ORIGIN, 'mq_test123').toHex();
    expect(hex.startsWith('006a086e70672d6d656c74')).toBe(true); // spec prefix
    expect(hex).toContain(Utils.toHex(Utils.toArray(ORIGIN, 'utf8')));
    expect(hex.endsWith(Utils.toHex(Utils.toArray('mq_test123', 'utf8')))).toBe(true);
  });

  test('challenge string and quote checks', () => {
    expect(meltChallenge('mq_x', 'tx_o3')).toBe('npg-melt|v1|mq_x|tx_o3');
    expect(checkQuote(quote(), LOCATION, ORIGIN)).toBeNull();
    expect(checkQuote(quote({ burn_script_hex: '006a' }), LOCATION, ORIGIN)).toMatch(/burn output/);
    expect(checkQuote(quote({ challenge: 'npg-melt|v1|mq_test123|other' }), LOCATION, ORIGIN)).toMatch(/challenge/);
    expect(checkQuote(quote({ fee_sats: 50, fee_to: 'nope' }), LOCATION, ORIGIN)).toMatch(/fee address/);
  });

  test('BSM signature over the challenge verifies with the jig key', () => {
    const c = meltChallenge('mq_test123', LOCATION);
    const sig = signChallenge(c, JIG_KEY.toWif());
    const parsed = Signature.fromCompact(sig, 'base64');
    expect(BSM.verify(Utils.toArray(c, 'utf8'), parsed, JIG_KEY.toPublicKey())).toBe(true);
  });

  test('avatar badge is split from the cards; quotes without one are fine', () => {
    expect(splitAvatar(quote()).avatar?.slot).toBe('avatar');
    expect(splitAvatar(quote()).cards).toHaveLength(1);
    expect(splitAvatar(quote({ elements: [{ file: 'a.png', slot: 'Hair' }] })).avatar).toBeUndefined();
  });

  test('builds the noSend tx: jig is input 0 signed by its key, burn is output 0, EF carries the parent', async () => {
    const calls: Record<string, unknown> = {};
    let pending: Transaction | null = null;
    const wallet = {
      createAction: async (args: any) => {
        calls.create = args;
        const tx = new Transaction();
        tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script() });
        tx.inputs[0].sequence = 0xffffffff;
        for (const o of args.outputs)
          tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
        pending = tx;
        const beef = new Beef();
        beef.mergeTransaction(tx);
        return { signableTransaction: { reference: 'ref1', tx: beef.toBinaryAtomic(tx.id('hex')) } };
      },
      signAction: async (args: any) => {
        calls.sign = args;
        pending!.inputs[0].unlockingScript = Script.fromHex(args.spends[0].unlockingScript);
        const beef = new Beef();
        beef.mergeTransaction(pending!);
        return { txid: pending!.id('hex'), tx: beef.toBinaryAtomic(pending!.id('hex')) };
      },
      abortAction: async () => {
        calls.abort = true;
        return { aborted: true };
      },
    };
    const services = {
      getBeefForTxid: async () => {
        const b = new Beef();
        b.mergeTransaction(parent);
        return b;
      },
    };
    const out = await buildMeltTx(wallet as any, services, quote(), { location: LOCATION, wif: JIG_KEY.toWif() });
    expect((calls.create as any).options).toMatchObject({ noSend: true, randomizeOutputs: false });
    expect((calls.create as any).outputs[0]).toMatchObject({
      satoshis: 0,
      lockingScript: burnScript(ORIGIN, 'mq_test123').toHex(),
    });
    expect(calls.abort).toBeUndefined();
    const ef = Transaction.fromHexEF(out.ef);
    expect(ef.inputs[0].sourceTXID ?? ef.inputs[0].sourceTransaction?.id('hex')).toBe(parent.id('hex'));
    // The EF carries the parent output (satoshis + script), so the server can check the spend without fetching it.
    const src = ef.inputs[0].sourceTransaction!.outputs[0];
    expect(src.satoshis).toBe(273);
    const spend = new Spend({
      sourceTXID: parent.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 273,
      lockingScript: src.lockingScript,
      transactionVersion: ef.version,
      otherInputs: [],
      outputs: ef.outputs,
      inputIndex: 0,
      unlockingScript: ef.inputs[0].unlockingScript!,
      inputSequence: ef.inputs[0].sequence ?? 0xffffffff,
      lockTime: ef.lockTime,
    });
    expect(spend.validate()).toBe(true);
    expect(ef.outputs[0].lockingScript.toHex()).toBe(burnScript(ORIGIN, 'mq_test123').toHex());
  });

  test('a failure after createAction aborts the unsent action', async () => {
    let aborted = false;
    const wallet = {
      createAction: async () => ({ signableTransaction: { reference: 'r', tx: [1, 2, 3] } }),
      signAction: async () => ({}),
      abortAction: async () => {
        aborted = true;
        return { aborted: true };
      },
    };
    const services = {
      getBeefForTxid: async () => {
        const b = new Beef();
        b.mergeTransaction(parent);
        return b;
      },
    };
    await expect(
      buildMeltTx(wallet as any, services, quote(), { location: LOCATION, wif: JIG_KEY.toWif() }),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  test('polls until done, and stops at the time limit', async () => {
    const seen: string[] = [];
    let n = 0;
    const f = (async () => ({ ok: true, json: async () => ({ status: ++n < 3 ? 'minting' : 'done' }) })) as any;
    const s = await pollMelt(f, 'mq', (x) => seen.push(x.status), { every: 1, max: 100, sleep: async () => {} });
    expect(s.status).toBe('done');
    expect(seen).toEqual(['minting', 'minting', 'done']);
    const g = (async () => ({ ok: true, json: async () => ({ status: 'minting' }) })) as any;
    const t = await pollMelt(g, 'mq', () => {}, { every: 10, max: 30, sleep: async () => {} });
    expect(t.status).toBe('minting');
  });
});
