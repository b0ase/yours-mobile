-- Sign in with bWalletX (docs/SIGN-IN-WITH-BWALLETX.md, site/lib/auth.js).
-- One row per /authorize request: pending → approved (wallet signed) → issued (code handed to the browser,
-- only its sha256 is kept) → used (/token burned it). Or pending → denied. Rows expire after 10 minutes.
begin;
create table if not exists public.bwallet_auth_requests (
  id text primary key check (id ~ '^[0-9a-f]{32}$'),
  client_id text not null,
  redirect_uri text not null,
  scope text not null,
  state text,
  nonce text,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  poll_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'issued', 'used', 'denied')),
  identity_key text check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  paymail text,
  bitsign_level int,
  code_hash text unique,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  expires_at timestamptz not null
);
create index if not exists bwallet_auth_requests_expires on public.bwallet_auth_requests (expires_at);
alter table public.bwallet_auth_requests enable row level security;
revoke all on public.bwallet_auth_requests from anon, authenticated;
grant select, insert, update, delete on public.bwallet_auth_requests to service_role;
commit;
notify pgrst, 'reload schema';
-- Housekeeping (optional, e.g. daily): delete from public.bwallet_auth_requests where expires_at < now() - interval '1 day';
