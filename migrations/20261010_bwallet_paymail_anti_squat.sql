-- Paymail anti-squatting (owner, 10 Oct 2026).
--   * Forwards may start from a retired social name (richardwboase.gmail -> b0asey), not only a plain one.
--   * bwallet_paymail_name_events: every new plain name a wallet takes (first claim or rename), with a
--     hashed client IP. Drives "one change per 30 days per identity key" and "N new names per IP per day".
--   * bwallet_paymail_name_fees: txids already spent on the 1 cent name fee (each pays for one name).
begin;
alter table public.bwallet_paymail_forwards drop constraint if exists bwallet_paymail_forwards_from_alias_check;
alter table public.bwallet_paymail_forwards add constraint bwallet_paymail_forwards_from_alias_check
  check (from_alias::text ~ '^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$'
      or from_alias::text ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?\.(x|gmail)$');

create table if not exists public.bwallet_paymail_name_events (
  id bigserial primary key,
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  alias citext not null,
  kind text not null check (kind in ('claim', 'rename')),
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_paymail_name_events_key on public.bwallet_paymail_name_events (identity_key, created_at desc);
create index if not exists bwallet_paymail_name_events_ip on public.bwallet_paymail_name_events (ip_hash, created_at desc);

create table if not exists public.bwallet_paymail_name_fees (
  txid text primary key check (txid ~ '^[0-9a-f]{64}$'),
  identity_key text not null,
  alias citext not null,
  satoshis bigint not null,
  created_at timestamptz not null default now()
);

alter table public.bwallet_paymail_name_events enable row level security;
alter table public.bwallet_paymail_name_fees enable row level security;
revoke all on public.bwallet_paymail_name_events, public.bwallet_paymail_name_fees from anon, authenticated;
grant select, insert, update, delete on public.bwallet_paymail_name_events, public.bwallet_paymail_name_fees to service_role;
grant usage, select on sequence public.bwallet_paymail_name_events_id_seq to service_role;
commit;
notify pgrst, 'reload schema';
