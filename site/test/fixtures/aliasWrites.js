// In-memory versions of the paymail store's name writes, with the production semantics (b-Aware #F-237):
//  - insertAlias: a plain INSERT; the alias is the primary key, so a taken name resolves null (never a merge);
//  - updateOwnAlias: PATCH ... alias=eq.X & identity_key=eq.K (0 rows → null); identity_key is never patched;
//  - renameAlias(from, to, key): 'ok' | 'taken' (to exists) | 'gone' (from is not key's); payments follow;
//  - holdForward(row): insert-if-absent (ignore-duplicates), true only when this call created it;
//  - repointOwnForward(from, key, to, { expiresAt, onlyIfTo }): only key's own forward (and only while → onlyIfTo);
//  - deleteOwnForward(from, key, { to, expiresAt }): only key's own forward (and only while it has exactly those);
//  - deleteForeignForwards(from, key): only OTHER keys' forwards from the name;
//  - deleteAlias(alias, key): 'gone' unless the row is key's; 'blocked' (nothing deleted) while another key's payment
//    records reference the name (the FK is ON DELETE RESTRICT); else key's own payments + the row; 'ok'.
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
  holdForward: async function (r) {
    const m = forwards || this.forwards;
    if (m.has(r.from_alias)) return false;
    m.set(r.from_alias, { ...r });
    return true;
  },
  repointOwnForward: async function (from, key, to, { expiresAt, onlyIfTo } = {}) {
    const fw = (forwards || this.forwards).get(from);
    if (!fw || fw.identity_key !== key || (onlyIfTo && fw.to_alias !== onlyIfTo)) return false;
    fw.to_alias = to;
    if (expiresAt) fw.expires_at = expiresAt;
    return true;
  },
  deleteOwnForward: async function (from, key, { to, expiresAt } = {}) {
    const m = forwards || this.forwards;
    const fw = m.get(from);
    if (fw && fw.identity_key === key && (!to || fw.to_alias === to) && (!expiresAt || fw.expires_at === expiresAt))
      m.delete(from);
  },
  deleteForeignForwards: async function (from, key) {
    const m = forwards || this.forwards;
    const fw = m.get(from);
    if (fw && fw.identity_key !== key) m.delete(from);
  },
  deleteAlias: async (alias, key) => {
    if (!key) throw new Error('deleteAlias needs the owner key');
    const r = aliases.get(alias);
    if (!r || r.identity_key !== key) return 'gone';
    if (pays && [...pays.values()].some((p) => p.alias === alias && p.identity_key !== key)) return 'blocked';
    if (pays) for (const [ref, p] of pays) if (p.alias === alias && p.identity_key === key) pays.delete(ref);
    aliases.delete(alias);
    return 'ok';
  },
});
