-- User-added apps (Apps › Add app), per wallet identity, so a 12-word restore brings them back.
-- Written only through the paymail server with a signature by the identity key (site/lib/paymail.js apps-*).
create table if not exists public.bwallet_user_apps (
  identity_key text primary key check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  apps jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bwallet_user_apps enable row level security;
