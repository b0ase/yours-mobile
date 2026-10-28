-- Provable names, build step 1 (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md). NOT RUN YET: the owner runs
-- it. Needs 20261017_name_bindings.sql first.
--
-- bwallet_name_proofs: one provider-signed proof per source-tagged name (`name.gmail`): the raw OpenID Connect ID token
-- Google returned when the owner signed in, whose nonce = sha256("bwalletx-name-proof|v1|" + identity_key). Any
-- wallet checks it against Google's published keys, so we can't move the name without a fresh Google-signed token.
-- Only the ID token is kept: never an access or refresh token. `sub` is the provider's stable account id; the paymail
-- server refuses a new proof from a different sub.
--
-- bwallet_name_log gets two more actions: 'prove' (a proof was stored; note = provider, sub, kid and the token) and
-- 'jwks' (a provider signing key seen for the first time; alias = 'jwks:<provider>', note = {provider, kid, jwk},
-- created_at = first seen). The log stays append-only and hash-chained, so old tokens stay checkable after rotation.

create table if not exists public.bwallet_name_proofs (
  alias citext primary key,
  provider text not null check (provider in ('google', 'linkedin', 'apple')),
  sub text not null check (length(sub) between 1 and 255),
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  id_token text not null check (length(id_token) between 20 and 8192),
  created_at timestamptz not null default now()
);
alter table public.bwallet_name_proofs enable row level security;

alter table public.bwallet_name_log drop constraint if exists bwallet_name_log_action_check;
alter table public.bwallet_name_log add constraint bwallet_name_log_action_check
  check (action in ('bind', 'claim', 'move', 'release', 'prove', 'jwks'));
create index if not exists bwallet_name_log_action_idx on public.bwallet_name_log (action, alias, id);
