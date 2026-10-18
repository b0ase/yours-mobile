/** Routes whose page carries its own bottom composer (bChat rooms + DMs, bMail, Ask b): the floating Ask b bar stays off them. */
export const OWN_COMPOSER = ['/m/ask-b', '/m/chat', '/m/bmail'];

export const hasOwnComposer = (pathname: string) =>
  OWN_COMPOSER.some((p) => pathname === p || pathname.startsWith(`${p}/`));
