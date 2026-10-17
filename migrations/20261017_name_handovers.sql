-- Two-party name handovers (owner, 17 Oct 2026): a name moves only when its current owner signs a release and the
-- new owner signs to accept. No operator recovery, by design (docs/NAME-BINDINGS.md). The host stores the signatures
-- and can't make them.

-- A release waiting for the recipient's signature. One per name; a new release replaces it.
create table if not exists public.bwallet_name_handovers (
  alias citext primary key,
  from_key text not null check (from_key ~ '^0[23][0-9a-f]{64}$'),
  to_key text not null check (to_key ~ '^0[23][0-9a-f]{64}$'),
  seq integer not null check (seq > 0),
  release_sig text not null check (release_sig ~ '^[0-9a-f]{16,200}$'),
  release_ts bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_name_handovers_to_idx on public.bwallet_name_handovers (to_key);
alter table public.bwallet_name_handovers enable row level security;

-- The signed release that brought a name to its current key, served with the binding so any wallet can check it.
alter table public.bwallet_name_bindings
  add column if not exists from_key text check (from_key is null or from_key ~ '^0[23][0-9a-f]{64}$'),
  add column if not exists release_sig text,
  add column if not exists release_ts bigint;
