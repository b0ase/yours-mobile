import { GAMES } from '../games/gamesCatalog';

/**
 * Hosts whose payments History files under Games: every game in this build's bGames catalogue
 * (src/mobile/games/gamesCatalog.ts, which includes bGames itself). A store build's catalogue has no
 * real-money or TokenBlaster games, so their hosts are not listed there either.
 */
export const GAME_HOSTS: readonly string[] = [...new Set(GAMES.map((g) => new URL(g.url).host.replace(/^www\./, '')))];

/** Exact host or a subdomain of one (play.hastearcade.com). */
export const isGameHost = (host: string) => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return GAME_HOSTS.some((g) => h === g || h.endsWith(`.${g}`));
};
