-- Handle NFTs (docs/HANDLE-NFTS.md): a bWalletX handle can be represented by a 1Sat ordinal.
-- Until nft_origin is set the row is the source of truth (unchanged behaviour). Once set, the paymail
-- server follows the NFT: the row's identity_key is moved to whoever the chain binding names.
--
-- Needs the "several names per wallet" columns (is_primary, PR #91 STEP A). It also drops the old
-- UNIQUE(identity_key, kind) index (PR #91 STEP B) if it is still there, because a received handle
-- joins a wallet that already has a plain name. The partial one-primary index from STEP A stays.
--
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261016_bwallet_handle_nfts.sql
begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bwallet_paymail_aliases' and column_name = 'is_primary'
  ) then
    raise exception 'Run the PR #91 STEP A migration (is_primary + one-primary index) first';
  end if;
end $$;

drop index if exists public.bwallet_paymail_aliases_key_kind;

alter table public.bwallet_paymail_aliases
  -- The inscription that represents this handle (txid_vout). Set once, never changed.
  add column if not exists nft_origin text
    check (nft_origin is null or nft_origin ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  -- The NFT's last verified location (txid_vout); the resolver compares the indexer's answer to it.
  add column if not exists nft_location text
    check (nft_location is null or nft_location ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  -- The NFT moved without a valid binding: the handle answers nothing until the holder self-claims.
  add column if not exists nft_unbound boolean not null default false,
  -- Operator freeze for a stolen-NFT dispute (set by hand, see the doc). The handle answers nothing.
  add column if not exists nft_frozen boolean not null default false,
  add column if not exists nft_minted_at timestamptz,
  add column if not exists nft_moved_at timestamptz;

create unique index if not exists bwallet_paymail_aliases_nft_origin
  on public.bwallet_paymail_aliases (nft_origin) where nft_origin is not null;

-- Audit trail: every ownership change the resolver applies (mint, transfer, unbind).
create table if not exists public.bwallet_handle_nft_events (
  id bigserial primary key,
  alias citext not null,
  kind text not null check (kind in ('mint', 'self', 'designated', 'unbound')),
  from_key text,
  to_key text,
  location text,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_handle_nft_events_alias on public.bwallet_handle_nft_events (alias, created_at);

alter table public.bwallet_handle_nft_events enable row level security;
revoke all on public.bwallet_handle_nft_events from anon, authenticated;
grant select, insert on public.bwallet_handle_nft_events to service_role;
grant usage, select on sequence public.bwallet_handle_nft_events_id_seq to service_role;
commit;
notify pgrst, 'reload schema';
