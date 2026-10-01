-- bWallet paymail (name@PAYMAIL_DOMAIN): alias registry + P2P payment inbox.
-- No private keys are stored: only identity PUBLIC keys, BRC-29 derivation prefixes/suffixes and received txs.
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261001_bwallet_paymail.sql
begin;
create extension if not exists citext;

create table if not exists public.bwallet_paymail_aliases (
  alias citext primary key
    check (alias::text ~ '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$'),
  identity_key text not null unique check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  ord_address text check (ord_address is null or ord_address ~ '^1[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  display_name text check (display_name is null or char_length(display_name) <= 64),
  avatar text check (avatar is null or char_length(avatar) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bwallet_paymail_payments (
  reference text primary key check (reference ~ '^[0-9a-f]{32}$'),
  alias citext not null references public.bwallet_paymail_aliases(alias) on delete restrict on update cascade,
  identity_key text not null,
  satoshis bigint not null check (satoshis > 0),
  -- [{script, satoshis, derivationPrefix, derivationSuffix, vout?}]
  outputs jsonb not null,
  status text not null default 'pending' check (status in ('pending','received','collected','expired')),
  txid text check (txid is null or txid ~ '^[0-9a-f]{64}$'),
  beef text,
  raw_tx text,
  sender_handle text,
  note text,
  created_at timestamptz not null default now(),
  received_at timestamptz,
  collected_at timestamptz
);
create index if not exists bwallet_paymail_payments_inbox on public.bwallet_paymail_payments (identity_key, status);
create index if not exists bwallet_paymail_payments_alias_created on public.bwallet_paymail_payments (alias, created_at);

alter table public.bwallet_paymail_aliases enable row level security;
alter table public.bwallet_paymail_payments enable row level security;
revoke all on public.bwallet_paymail_aliases from anon, authenticated;
revoke all on public.bwallet_paymail_payments from anon, authenticated;
grant select, insert, update, delete on public.bwallet_paymail_aliases to service_role;
grant select, insert, update, delete on public.bwallet_paymail_payments to service_role;
commit;
notify pgrst, 'reload schema';
