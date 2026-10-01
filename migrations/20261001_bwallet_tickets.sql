-- bWallet tickets registry: lets the Market's Tickets filter find tickets (BSV-21 access tokens)
-- minted in bWallet. The 1Sat indexer cannot filter BSV-21 tokens by MAP, so bit-sign keeps this
-- list. See docs/TICKETS.md for the endpoint contract (GET/POST /api/bitsign/tickets).
-- No keys or secrets are stored: public token ids and the text the minter typed.
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261001_bwallet_tickets.sql
begin;

create table if not exists public.bwallet_tickets (
  token_id text primary key check (token_id ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  ticker text not null check (ticker ~ '^[A-Z0-9_-]{1,32}$'),
  name text not null check (char_length(name) between 1 and 64),
  description text check (description is null or char_length(description) <= 1000),
  icon text check (icon is null or icon ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  event_date date,
  price_sats bigint check (price_sats is null or price_sats > 0),
  supply numeric(20, 0) check (supply is null or supply > 0),
  room_ticker text,
  -- bChat handle that registered it (the server checks this handle's wallet holds the token).
  created_by text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bwallet_tickets_listed_idx
  on public.bwallet_tickets (event_date, created_at desc) where not hidden;

alter table public.bwallet_tickets enable row level security;
-- Served only through bit-sign's API (service role); no direct anon access.

commit;
