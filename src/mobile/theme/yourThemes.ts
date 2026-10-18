import { EDITION_PACKS, type Accent } from './accents';

/** The editions this wallet owns, in Store order, with where each was bought (null = this account). Pure. */
export const yourThemes = (boughtOn: ReadonlyMap<string, string | null>): { a: Accent; from: string | null }[] =>
  EDITION_PACKS.filter((a) => boughtOn.has(a.id)).map((a) => ({ a, from: boughtOn.get(a.id) ?? null }));
