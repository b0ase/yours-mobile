/**
 * Every output in one of the wallet's own baskets, for a check that must see all of them. Reads page by page and
 * throws rather than return part of a basket.
 */
export const OUTPUTS_UNREADABLE = "The wallet couldn't read all of its coins";

const PAGE = 10_000;
const MAX_PAGES = 100;

type Page<R> = { outputs?: R[]; totalOutputs?: number };
type Args = { basket: string } & Record<string, unknown>;
type Read<R> = (args: Args & { limit: number; offset: number }, originator: string) => Promise<Page<R>>;
type Manager<R> = {
  underlying?: { listOutputs?: Read<R> };
  decryptListOutputsMetadata?: (page: Page<R>) => Promise<Page<R>>;
};

/**
 * `plain` is the manager's own listOutputs. A legacy 'p …' basket is read from the wallet under the manager instead:
 * the manager hands those names to a permission module, which refuses them even for the wallet itself.
 */
export const everyOutput = async <R>(manager: object, plain: Read<R>, args: Args, admin: string): Promise<R[]> => {
  const m = manager as Manager<R>;
  const fromWallet = args.basket.startsWith('p ') && typeof m.underlying?.listOutputs === 'function';
  const read: Read<R> = async (a, o) => {
    if (!fromWallet) return plain(a, o);
    const page = await m.underlying!.listOutputs!(a, o);
    return typeof m.decryptListOutputsMetadata === 'function' ? m.decryptListOutputsMetadata(page) : page;
  };
  const all: R[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await read({ ...args, limit: PAGE, offset: all.length }, admin);
    const rows = page?.outputs ?? [];
    all.push(...rows);
    const total = page?.totalOutputs;
    // More rows than the total: the listing is ignoring the offset, so these are repeats and others are missing.
    if (typeof total === 'number' && all.length > total) break;
    const more = typeof total === 'number' ? all.length < total : rows.length === PAGE;
    if (!more) return all;
    if (rows.length === 0) break;
  }
  throw new Error(OUTPUTS_UNREADABLE);
};
