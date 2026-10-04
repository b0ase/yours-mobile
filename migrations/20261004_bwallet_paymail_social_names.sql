-- bWalletX verified social names (owner, 4 Oct 2026): a wallet keeps its plain paymail name AND can
-- hold one verified X name (b0asex.x) and one Gmail name (theirname.gmail). One row per (key, kind)
-- instead of one row per key; payments keep working because they reference the alias.
--
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261004_bwallet_paymail_social_names.sql
begin;
alter table public.bwallet_paymail_aliases
  add column if not exists kind text not null default 'plain' check (kind in ('plain', 'x', 'gmail'));
update public.bwallet_paymail_aliases
  set kind = case when alias::text like '%.x' then 'x' when alias::text like '%.gmail' then 'gmail' else 'plain' end;
alter table public.bwallet_paymail_aliases drop constraint if exists bwallet_paymail_aliases_identity_key_key;
create unique index if not exists bwallet_paymail_aliases_key_kind on public.bwallet_paymail_aliases (identity_key, kind);
-- The alias check only allowed plain names, so b0asex.x could never be stored.
alter table public.bwallet_paymail_aliases drop constraint if exists bwallet_paymail_aliases_alias_check;
alter table public.bwallet_paymail_aliases add constraint bwallet_paymail_aliases_alias_check check (
  (kind = 'plain' and alias::text ~ '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$')
  or (kind = 'x' and alias::text ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?\.x$')
  or (kind = 'gmail' and alias::text ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?\.gmail$')
);
commit;
