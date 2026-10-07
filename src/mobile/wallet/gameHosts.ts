/**
 * Hosts whose payments History files under Games: the bGames catalogue (src/mobile/games/gamesCatalog.ts on
 * feat/games-catalog, not merged yet) plus bGames itself. When that branch lands, build this list from
 * GAMES / the catalogue URLs instead of keeping a copy here.
 */
export const GAME_URLS = [
  'https://bitcoin-gaming.vercel.app', // bGames
  'https://insertarcade.com/',
  'https://hastearcade.com',
  'https://5tars.io',
  'https://ninjapunkgirls.online',
  'https://paiybit.com/paiybit/arcade',
  'https://bitcoinsv.itch.io/bitcoin-versus-crypto',
  'https://pixelwar.click',
  'https://numbercrunchermath.com',
  'https://agelessrepublic.com/',
  'https://hypertypist.com/',
  'https://peerjump.fun/',
];

export const GAME_HOSTS: readonly string[] = [...new Set(GAME_URLS.map((u) => new URL(u).host))];

/** Exact host or a subdomain of one (play.hastearcade.com). */
export const isGameHost = (host: string) => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return GAME_HOSTS.some((g) => h === g || h.endsWith(`.${g}`));
};
