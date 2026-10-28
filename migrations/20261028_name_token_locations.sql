-- Name tokens (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md, main route). NOT RUN: the owner runs it.
--
-- name_token_origins: OUR record of each name token's mint outpoint (our own mint txids), so resolving a name never
-- depends on an outside indexer for the origin. Written when we (or the wallet, via the sponsor path) mint.
--
-- name_token_locations: a cache of lib/nameTokenHolder.js, which follows the token's spends on chain from the
-- origin. current_outpoint / owner_address are the last answer; hops is the path; checked_at says how old it is.
-- It is a cache only: the chain is the record, and any row can be rebuilt by following spends from the origin.

create table if not exists public.name_token_origins (
  name citext primary key,
  kind text not null check (kind in ('paymail', 'opns')),
  origin text not null unique check (origin ~ '^[0-9a-f]{64}_[0-9]+$'),
  minted_by text check (minted_by is null or minted_by ~ '^0[23][0-9a-f]{64}$'),
  binding_seq int,
  created_at timestamptz not null default now()
);
alter table public.name_token_origins enable row level security;

create table if not exists public.name_token_locations (
  name citext primary key references public.name_token_origins (name) on delete cascade,
  origin text not null,
  current_outpoint text check (current_outpoint is null or current_outpoint ~ '^[0-9a-f]{64}_[0-9]+$'),
  owner_address text,
  listed boolean not null default false,
  burned boolean not null default false,
  height int,
  hops jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);
alter table public.name_token_locations enable row level security;

-- The public name log records each free mint (action 'mint': note = {origin, ordAddress}).
alter table public.bwallet_name_log drop constraint if exists bwallet_name_log_action_check;
alter table public.bwallet_name_log add constraint bwallet_name_log_action_check
  check (action in ('bind', 'claim', 'move', 'release', 'prove', 'jwks', 'mint'));
