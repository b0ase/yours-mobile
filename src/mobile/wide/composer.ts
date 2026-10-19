/** Routes whose page carries its own bottom composer (bChat rooms + DMs, bMail, Ask b): the floating Ask b bar stays off them. */
export const OWN_COMPOSER = ['/m/ask-b', '/m/chat', '/m/bmail'];

export const hasOwnComposer = (pathname: string) =>
  OWN_COMPOSER.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Settings › New deep links: the add-account pages (Settings hub's New pill). */
export const ADD_ACCOUNT_QUERIES = ['create-account', 'restore-account'];

/**
 * Add account (create / restore) is a setup form like onboarding, which has no floating bar either: over its list the
 * bar covered the last options (release check, 19 Oct 2026).
 */
export const isAddAccountFlow = (selected: string | null | undefined, query: string | null | undefined) =>
  selected === 'settings' && !!query && ADD_ACCOUNT_QUERIES.includes(query);
