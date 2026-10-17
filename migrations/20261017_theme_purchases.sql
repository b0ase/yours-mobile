-- Store theme purchases ($1 each: VexVoid, NPG, NPGX; owner 17 Oct 2026). NOT RUN YET: the owner runs it.
-- Written only by the paymail/site server with the service role (site/lib/themeBuys.js); every request is signed
-- by the wallet's identity key. RLS on with no policies: anon/authenticated can't read or write.
-- status: quoted (price given, not paid) → paid.
create table if not exists public.theme_purchases (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  pack_id text not null check (pack_id ~ '^[a-z0-9-]{1,40}$'),
  status text not null default 'quoted' check (status in ('quoted', 'paid')),
  quote_id text not null unique check (quote_id ~ '^[0-9a-f]{32}$'),
  quote_usd numeric not null,
  quote_sats bigint not null check (quote_sats > 0),
  quote_rate numeric not null,
  quote_address text not null,
  quote_memo_hex text not null,
  quote_expires_at timestamptz not null,
  txid text unique check (txid is null or txid ~ '^[0-9a-f]{64}$'),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists theme_purchases_owner_idx on public.theme_purchases (identity_key) where status = 'paid';
alter table public.theme_purchases enable row level security;
