// Shape checks for SQL migrations the owner runs by hand (b-Aware #F-237 re-review, 8 Nov 2026): a scripted edit once
// mangled 20261108_paymail_alias_key_guard.sql (a key check cut short, junk after the final notify). These read the
// files only; nothing touches a database.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'migrations');
const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
// SQL without `--` comment lines (none of these files put `--` inside a string).
const code = (sql) =>
  sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

describe('migrations/20261108_paymail_alias_key_guard.sql', () => {
  const sql = read('20261108_paymail_alias_key_guard.sql');
  const body = code(sql);

  test('one transaction, and nothing after the final notify', () => {
    expect(body.match(/^begin;$/gm)?.length).toBe(1);
    expect(body.match(/^commit;$/gm)?.length).toBe(1);
    expect(body.match(/notify pgrst/g)?.length).toBe(1);
    expect(sql.trimEnd().endsWith("commit;\nnotify pgrst, 'reload schema';")).toBe(true);
  });

  test('quotes and dollar quotes are balanced', () => {
    expect((body.match(/'/g) || []).length % 2).toBe(0);
    expect((body.match(/\$\$/g) || []).length % 2).toBe(0);
    expect((body.match(/\$\$/g) || []).length).toBe(4); // two functions, each `as $$ ... end $$;`
  });

  test('bwallet_move_alias checks both keys and refuses from = to, before it moves anything', () => {
    const fn = body.slice(body.indexOf('create or replace function public.bwallet_move_alias'));
    const fnBody = fn.slice(0, fn.indexOf('end $$;'));
    const update = fnBody.indexOf('update public.bwallet_paymail_aliases');
    expect(update).toBeGreaterThan(0);
    for (const check of [
      "if p_from !~ '^0[23][0-9a-f]{64}$' then",
      "if p_to !~ '^0[23][0-9a-f]{64}$' then",
      'if p_from = p_to then',
    ]) {
      const at = fnBody.indexOf(check);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(update);
      expect(fnBody.slice(at).split('\n')[1]).toMatch(/^\s*raise exception/);
    }
    expect(fnBody).toContain('p_from := lower(p_from);');
    expect(fnBody).toContain('p_to := lower(p_to);');
    expect(fnBody).toContain('where alias = p_alias::citext and identity_key = p_from;');
  });

  test('the guard trigger and the grants are there', () => {
    expect(body).toContain('create trigger bwallet_alias_key_guard before update on public.bwallet_paymail_aliases');
    expect(body).toContain("coalesce(current_setting('bwallet.allow_key_change', true), '') <> 'on'");
    expect(body).toContain('grant execute on function public.bwallet_move_alias(text, text, text) to service_role;');
    expect(body).toContain(
      'revoke all on function public.bwallet_move_alias(text, text, text) from public, anon, authenticated;',
    );
  });
});

describe('migrations/20261111_paymail_x_holds.sql', () => {
  const sql = read('20261111_paymail_x_holds.sql');
  const body = code(sql);

  test('one transaction, idempotent, RLS on, nothing for anon / authenticated', () => {
    expect(body.match(/^begin;$/gm)?.length).toBe(1);
    expect(body.match(/^commit;$/gm)?.length).toBe(1);
    expect(sql.trimEnd().endsWith("commit;\nnotify pgrst, 'reload schema';")).toBe(true);
    expect((body.match(/'/g) || []).length % 2).toBe(0);
    expect(body).toContain('create table if not exists public.bwallet_paymail_x_holds (');
    expect(body).toContain('alter table public.bwallet_paymail_x_holds enable row level security;');
    expect(body).toContain('revoke all on public.bwallet_paymail_x_holds from anon, authenticated;');
  });

  test('bound by the numeric X id; the @name is words only', () => {
    expect(body).toContain("x_user_id text not null check (x_user_id ~ '^[0-9]{1,25}$')");
    expect(body).toContain("x_handle text not null default '' check (x_handle ~ '^[a-z0-9_]{0,15}$')");
  });
});
