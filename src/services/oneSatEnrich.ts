/**
 * @1sat/permission-module's own classifier, enrichIntent: the function the module's createAction handler runs on a
 * site's action to decide what it is (purchase, listing, cancel-listing, transfer, inscription, …) before it builds
 * the approval sheet. The package exports only its types, so the file is imported by its path. The version is pinned
 * exactly in package.json (0.0.77), and storeGatesA9.test.ts fails if the pin moves or the file is gone.
 *
 * Used only by the store gate (services/storeMarketGate.ts), which has to classify a site's action exactly as the
 * module would, before the module (or any other sheet) is reached.
 */
export { enrichIntent } from '../../node_modules/@1sat/permission-module/dist/enrichIntent.js';
