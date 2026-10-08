-- bPhone (docs/BPHONE-PLAN.md): charge to receive calls. Per wallet identity: the public rate card
-- and listing (what a call costs, title, hours, bookings on/off) and the bookings between two
-- identities. Written only through the paymail server with a signature by the identity key
-- (site/lib/paymail.js bphone-*). The server never sees a private key and never holds funds:
-- call payments go wallet to wallet through paymail.
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261008_bwallet_bphone.sql
begin;

create table if not exists public.bwallet_bphone_profiles (
  identity_key text primary key check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  -- {v:1, rate: {amount, per, asset} | null, listing: {listed, title, about, category, hours, timezone, booking}}
  profile jsonb not null default '{}'::jsonb,
  -- Copied out of profile.listing for the directory query.
  listed boolean not null default false,
  category text not null default 'other',
  updated_at timestamptz not null default now()
);
create index if not exists bwallet_bphone_profiles_directory on public.bwallet_bphone_profiles (listed, category, updated_at desc);
alter table public.bwallet_bphone_profiles enable row level security;

create table if not exists public.bwallet_bphone_bookings (
  id text primary key check (id ~ '^[0-9a-f]{32}$'),
  callee_key text not null check (callee_key ~ '^0[23][0-9a-f]{64}$'),
  caller_key text not null check (caller_key ~ '^0[23][0-9a-f]{64}$'),
  caller_label text not null default '',
  callee_label text not null default '',
  at timestamptz not null,
  minutes int not null check (minutes between 5 and 240),
  note text not null default '' check (char_length(note) <= 280),
  status text not null default 'requested' check (status in ('requested','confirmed','declined','cancelled')),
  -- The callee's rate card when the booking was made (what the caller agreed to), or null.
  rate jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bwallet_bphone_bookings_callee on public.bwallet_bphone_bookings (callee_key, at);
create index if not exists bwallet_bphone_bookings_caller on public.bwallet_bphone_bookings (caller_key, at);
alter table public.bwallet_bphone_bookings enable row level security;

commit;
