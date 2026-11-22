/** Store build stand-in for index.ts (vite.config.mobile.ts): no example trading strategies, not even as data. */
import type { Strategy } from '../../agents/strategy';

export type ExampleStrategy = { id: string; description: string; strategy: Strategy };

export const EXAMPLE_FILES: Record<string, { description: string }> = {};

export const EXAMPLE_STRATEGIES: ExampleStrategy[] = [];
