-- bWallet testing waitlist (self-hosted Supabase on Hetzner).
-- Apply: ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261001_bwallet_waitlist.sql
begin;
create extension if not exists citext;
create table if not exists public.bwallet_waitlist (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique check (email = lower(email::text) and char_length(email::text) <= 254),
  platform text not null check (platform in ('ios','android','either')),
  created_at timestamptz not null default now(),
  source text,
  user_agent text
);
alter table public.bwallet_waitlist enable row level security;
revoke all on public.bwallet_waitlist from anon, authenticated;
grant select, insert, delete on public.bwallet_waitlist to service_role;
commit;
notify pgrst, 'reload schema';
