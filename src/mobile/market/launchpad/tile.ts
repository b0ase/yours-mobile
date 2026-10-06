/**
 * Everything MarketPage needs to show the Launchpad tile and panel. MarketPage refers only to these
 * names, behind CURVE_COINS_ENABLED (storeBuild.ts), so a store build drops this module, the panel and
 * every Launchpad / BlastPad string, sourcemaps included.
 */
export const CURVE_FILTER = 'launchpad' as const;
export const CURVE_LABEL = 'Launchpad';
export const loadCurvePanel = () => import('./LaunchpadPanel').then((m) => ({ default: m.LaunchpadPanel }));
