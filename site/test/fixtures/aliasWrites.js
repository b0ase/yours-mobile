// In-memory versions of the paymail store's name writes, with the production semantics (b-Aware #F-237):
//  - insertAlias: a plain INSERT; the alias is the primary key, so a taken name resolves null (never a merge);
//  - updateOwnAlias: PATCH ... alias=eq.X & identity_key=eq.K (0 rows → null); identity_key is never patched;
//  - renameAlias(from, to, key): 'ok' | 'taken' (to exists) | 'gone' (from is not key's); payments follow;
//  - deleteOwnForward(from, key): only key's own forward.
// `aliases` is the fake's Map; `pays` (optional) its payments Map; `forwards` (optional) a Map or a getter.
export const aliasWrites = (aliases, { pays, forwards } = {}) => ({
  insertAlias: async (r) => {
    if (aliases.has(r.alias)) return null;
    const row = { ...r };
    aliases.set(r.alias, row);
    return row;
  },
  updateOwnAlias: async (alias, key, patch) => {
    const r = aliases.get(alias);
    if (!r || r.identity_key !== key) return null;
    const { ord_address, display_name, avatar } = patch || {};
    Object.assign(r, { ord_address, display_name, avatar });
    return r;
  },
  renameAlias: async (from, to, key) => {
    if (!key) throw new Error('renameAlias needs the owner key');
    const r = aliases.get(from);
    if (!r || r.identity_key !== key) return 'gone';
    if (aliases.has(to)) return 'taken';
    aliases.delete(from);
    aliases.set(to, { ...r, alias: to });
    if (pays) for (const p of pays.values()) if (p.alias === from) p.alias = to;
    return 'ok';
  },
  deleteOwnForward: async function (from, key) {
    const m = typeof forwards === 'function' ? forwards() : forwards || this.forwards;
    const fw = m && m.get(from);
    if (fw && fw.identity_key === key) m.delete(from);
  },
});
