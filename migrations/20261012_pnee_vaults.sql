-- PNEE vaults (site/api/pnee.js): the public list behind bwalletx.com/backing, and PNEE sends waiting for their
-- recipient's wallet. Every row is read from the chain by the server (op=submit fetches the broadcast tx and checks
-- each script against the PNEE templates and this deployment's signer keys); nothing is taken on a client's word.
-- No private keys and no funds here.
-- Apply (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261012_pnee_vaults.sql
begin;

create table if not exists public.pnee_vaults (
  -- the vault's current output (txid_vout); updated as topUp / mint move it
  outpoint text primary key check (outpoint ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  -- the output the vault was opened at
  first_outpoint text not null check (first_outpoint ~ '^[0-9a-f]{64}_[0-9]{1,6}$'),
  owner text not null check (owner ~ '^0[23][0-9a-f]{64}$'),
  open_ts bigint not null,
  sats bigint not null check (sats >= 0),
  -- PNEEs minted against the vault (1 PNEE = 1 cent)
  debt bigint not null default 0 check (debt >= 0),
  -- the vault's last oracle round (unix seconds)
  last_ts bigint not null,
  status text not null default 'open' check (status in ('open', 'closed', 'liquidated')),
  end_txid text,
  updated_at timestamptz not null default now()
);
create index if not exists pnee_vaults_open on public.pnee_vaults (status, sats desc);
create index if not exists pnee_vaults_owner on public.pnee_vaults (owner);
alter table public.pnee_vaults enable row level security;

create table if not exists public.pnee_sends (
  txid text not null check (txid ~ '^[0-9a-f]{64}$'),
  vout int not null check (vout >= 0),
  -- the recipient's identity key; the token itself is held by a key derived from it (BRC-42, key_id)
  recipient text not null check (recipient ~ '^0[23][0-9a-f]{64}$'),
  sender text check (sender ~ '^0[23][0-9a-f]{64}$'),
  key_id text not null check (char_length(key_id) <= 80),
  holder text not null,
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  primary key (txid, vout)
);
create index if not exists pnee_sends_recipient on public.pnee_sends (recipient, created_at desc);
alter table public.pnee_sends enable row level security;

commit;
