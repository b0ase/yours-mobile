-- Branded wallet deposits (bwalletx.com/themes/custom/orderform). NOT RUN YET: the owner runs it.
-- Written only by the paymail/site server with the service role (site/lib/themeDeposits.js); every request is
-- signed by the payer's identity key. RLS on with no policies: anon/authenticated can't read or write.
-- status: quoted (price given, not paid yet) → paid → in_talks → building → done, or refunded (by hand).
-- Uses public.bwallet_ops_events from 20261016_theme_orders.sql for the "deposit paid" notice.
create table if not exists public.theme_deposits (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  tier text not null check (tier in ('branded', 'native')),
  brand text not null,
  contact text not null,
  links jsonb not null default '[]'::jsonb,
  logo text,
  colours jsonb not null default '[]'::jsonb,
  note text,
  status text not null default 'quoted'
    check (status in ('quoted', 'paid', 'in_talks', 'building', 'done', 'refunded')),
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
create index if not exists theme_deposits_identity_idx on public.theme_deposits (identity_key, created_at desc);
create index if not exists theme_deposits_paid_idx on public.theme_deposits (paid_at desc) where status <> 'quoted';
alter table public.theme_deposits enable row level security;
