import { describe, expect, test } from 'bun:test';
import {
  CHAIN_IDLE_MS,
  chainActive,
  continuesChain,
  endChain,
  isAlreadyProcessedAbort,
  markChainStep,
  startsChain,
} from './dappChain';

describe('a site multi-step action (vexvoid.com streamed mint, 11 Oct 2026)', () => {
  test('chunk steps continue a chain; the origin step and a plain payment do not', () => {
    // @1sat/actions inscribe: origin = noSend with no inputs; chunks spend the previous chunk and pass noSendChange.
    expect(continuesChain({ options: { noSend: true } })).toBe(false);
    expect(
      continuesChain({
        inputs: [{ outpoint: 'a'.repeat(64) + '.0', inputDescription: 'prior', unlockingScriptLength: 108 }],
        options: { noSend: true, noSendChange: ['b'.repeat(64) + '.1'], knownTxids: ['a'.repeat(64)] },
      }),
    ).toBe(true);
    expect(continuesChain({ options: { sendWith: ['a'.repeat(64)] } })).toBe(true);
    expect(continuesChain({ options: {} })).toBe(false);
    expect(continuesChain({})).toBe(false);
  });

  test('two-phase or noSend createActions start a chain', () => {
    expect(startsChain({ options: { signAndProcess: false } })).toBe(true);
    expect(startsChain({ options: { noSend: true } })).toBe(true);
    expect(startsChain({ options: {} })).toBe(false);
  });

  test('a chain is active until it ends or goes idle', () => {
    endChain();
    expect(chainActive(1_000)).toBe(false);
    markChainStep(1_000);
    expect(chainActive(1_000 + CHAIN_IDLE_MS - 1)).toBe(true);
    expect(chainActive(1_000 + CHAIN_IDLE_MS)).toBe(false);
    markChainStep(5_000);
    endChain();
    expect(chainActive(5_001)).toBe(false);
  });

  test("recognises the toolbox's refusal to abort an action already signed or shared", () => {
    expect(
      isAlreadyProcessedAbort(
        new Error(
          'The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.',
        ),
      ),
    ).toBe(true);
    expect(isAlreadyProcessedAbort(new Error('Insufficient funds'))).toBe(false);
  });
});
