-- Paymail name forwards (owner, 9 Oct 2026).
--   * Rename: when a wallet renames its paymail name, the old name forwards to the new one for
--     90 days (expires_at), then is released for anyone to register.
--   * Extra name: expires_at null = a permanent second name that receives for the same wallet
--     (aliases are unique per (identity_key, kind), so a second plain name lives here).
-- Lookups (id, p2p destinations, profile, receive) follow one hop: from_alias -> to_alias.
begin;
create table if not exists public.bwallet_paymail_forwards (
  from_alias citext primary key check (from_alias::text ~ '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$'),
  to_alias citext not null,
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_paymail_forwards_key on public.bwallet_paymail_forwards (identity_key);
alter table public.bwallet_paymail_forwards enable row level security;
revoke all on public.bwallet_paymail_forwards from anon, authenticated;
grant select, insert, update, delete on public.bwallet_paymail_forwards to service_role;
commit;
notify pgrst, 'reload schema';
