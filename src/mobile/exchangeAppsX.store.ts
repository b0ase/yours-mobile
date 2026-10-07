/** Store build stand-in for exchangeAppsX.ts (vite.config.mobile.ts): no exchange or market tiles. */
import type { BApp } from './bapps';
import type { RadarApp } from './radarApps';

export const EXCHANGE_BAPPS: BApp[] = [];
export const MARKET_APPS: Omit<RadarApp, 'source'>[] = [];
