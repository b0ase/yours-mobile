/** Nothing to hand over, accept or report: render no card (a new wallet with no name showed an empty one). */
export const handoverIsEmpty = (plainNames: number, incoming: number, msg: string) =>
  plainNames === 0 && incoming === 0 && !msg;
