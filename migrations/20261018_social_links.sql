-- Link your accounts (owner, 18 Oct 2026): public, wallet-signed links between a bWalletX identity key and an
-- X / Google / GitHub / LinkedIn account (site/lib/socialLinks.js). The provider proved the account (OAuth ticket)
-- and the wallet signed "bwallet-paymail|v1|link|account=…|handle=…|identityKey=…|provider=…|timestamp=…".
-- `account` = sha256(provider:providerAccountId): never an email address. `handle` = X @name / GitHub login only.
-- One account links to one wallet at a time (primary key); re-linking moves it, signed by the new wallet.
create table if not exists public.bwallet_social_links (
  provider text not null check (provider in ('x', 'google', 'github', 'linkedin')),
  account text not null check (account ~ '^[0-9a-f]{64}$'),
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  handle text not null default '' check (handle !~ '@'),
  signature text not null,
  signed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (provider, account)
);
create index if not exists bwallet_social_links_key on public.bwallet_social_links (identity_key);
alter table public.bwallet_social_links enable row level security;
