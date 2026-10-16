-- "Get your own theme" orders (tier 1, $99 a year; bwalletx.com/themes/custom). NOT RUN YET: the owner runs it.
-- Written only by the paymail/site server with the service role (site/lib/themeOrders.js); every request is
-- signed by the wallet's identity key. RLS on with no policies: anon/authenticated can't read or write.
-- status: quoted (price given, not paid yet) → paid → building → review → live, or declined (refunded by hand).
create table if not exists public.theme_orders (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  name text,
  brand text,
  is_brand boolean not null default false,
  links jsonb not null default '[]'::jsonb,
  colours jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,
  note text,
  proof jsonb,
  -- A renewal row points at the slug it extends (same owner); it carries no form data.
  renews text,
  status text not null default 'quoted'
    check (status in ('quoted', 'paid', 'building', 'review', 'live', 'declined')),
  quote_id text not null unique check (quote_id ~ '^[0-9a-f]{32}$'),
  quote_usd numeric not null,
  quote_sats bigint not null check (quote_sats > 0),
  quote_rate numeric not null,
  quote_address text not null,
  quote_memo_hex text not null,
  quote_expires_at timestamptz not null,
  txid text unique check (txid is null or txid ~ '^[0-9a-f]{64}$'),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  -- When the edition's year runs out (set at payment; a renewal adds a year).
  expires_at timestamptz
);
create index if not exists theme_orders_identity_idx on public.theme_orders (identity_key, created_at desc);
create index if not exists theme_orders_slug_idx on public.theme_orders (slug) where status <> 'declined';
alter table public.theme_orders enable row level security;

-- The b ops feed: one row per event the owner should see (new paid theme order, renewal...).
create table if not exists public.bwallet_ops_events (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_ops_events_new_idx on public.bwallet_ops_events (created_at desc) where not seen;
alter table public.bwallet_ops_events enable row level security;

-- Logo / art uploads (PNG, JPG, SVG; 2 MB each). Private bucket, written by the service role only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('theme-orders', 'theme-orders', false, 2097152, array['image/png', 'image/jpeg', 'image/svg+xml'])
on conflict (id) do nothing;
