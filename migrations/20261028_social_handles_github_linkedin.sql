-- .github and .linkedin handles (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md). NOT RUN: the owner runs it.
-- Needs 20261004_bwallet_paymail_social_names.sql and 20261028_name_proofs.sql first.
--
-- Alias kinds gain 'github' (`login.github`, claimed with a GitHub sign-in for that login) and 'linkedin'
-- (`slug.linkedin`, the user's chosen slug, bound to the LinkedIn account's OIDC `sub` when claimed).
-- Proofs gain provider 'github': a public gist (id_token holds the gist evidence JSON, see lib/nameProof.js).
-- One .linkedin name per LinkedIn account: unique (provider, sub) for linkedin.

alter table public.bwallet_paymail_aliases drop constraint if exists bwallet_paymail_aliases_kind_check;
alter table public.bwallet_paymail_aliases add constraint bwallet_paymail_aliases_kind_check
  check (kind in ('plain', 'x', 'gmail', 'github', 'linkedin'));

alter table public.bwallet_name_proofs drop constraint if exists bwallet_name_proofs_provider_check;
alter table public.bwallet_name_proofs add constraint bwallet_name_proofs_provider_check
  check (provider in ('google', 'linkedin', 'apple', 'github'));
create unique index if not exists bwallet_name_proofs_linkedin_sub_uidx
  on public.bwallet_name_proofs (sub) where provider = 'linkedin';
