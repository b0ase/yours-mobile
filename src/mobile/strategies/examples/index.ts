/**
 * Example strategies we wrote (docs/STRATEGY-FORMAT.md). Each JSON file is a plain `bwalletx.strategy/1`
 * file plus a `description` (the public listing text; parseStrategy drops it from the program).
 * PublishStrategy's "Start from an example" loads one into the form; the owner publishes and pays.
 */
import { parseStrategy, type Strategy } from '../../agents/strategy';
import slowDca from './slow-dca-b0asex.json';
import dipBuyer from './dip-buyer-npg.json';
import mnee from './mnee-dollar-stack.json';
import basket from './two-token-basket.json';
import nibbler from './launch-nibbler.json';
import savings from './savings-sweep.json';
import allowance from './weekly-allowance.json';
import thanks from './holder-thank-you.json';

export type ExampleStrategy = { id: string; description: string; strategy: Strategy };

export const EXAMPLE_FILES: Record<string, { description: string }> = {
  'slow-dca-b0asex': slowDca,
  'dip-buyer-npg': dipBuyer,
  'mnee-dollar-stack': mnee,
  'two-token-basket': basket,
  'launch-nibbler': nibbler,
  'savings-sweep': savings,
  'weekly-allowance': allowance,
  'holder-thank-you': thanks,
};

export const EXAMPLE_STRATEGIES: ExampleStrategy[] = Object.entries(EXAMPLE_FILES).flatMap(([id, file]) => {
  const r = parseStrategy(file);
  return r.ok ? [{ id, description: file.description, strategy: r.strategy }] : [];
});
