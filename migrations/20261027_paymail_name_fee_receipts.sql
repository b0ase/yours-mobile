-- Paid paymail name receipts (owner pricing, 27 Oct 2026). NOT RUN YET: the owner runs it BEFORE the site deploy
-- that ships the $1 extra-name fee (site/lib/paymail.js names-add). Until it runs, a paid extra name fails closed
-- (the receipt insert is refused, so the name is not added) and the CSV export errors.
--   * The first @bwalletx.com name per identity key is free; each extra name costs $1 in BSV.
--   * bwallet_paymail_name_fees (20261010_bwallet_paymail_anti_squat.sql) already holds one row per fee txid
--     (txid, identity_key, alias, satoshis, created_at). This adds what a receipt needs: the USD price, the
--     USD/BSV rate the server checked against, and the kind of name it paid for.
-- Old 1 cent rows keep usd/rate null and kind 'claim'.
begin;
alter table public.bwallet_paymail_name_fees add column if not exists usd numeric(12, 2);
alter table public.bwallet_paymail_name_fees add column if not exists rate numeric(18, 6);
alter table public.bwallet_paymail_name_fees add column if not exists kind text not null default 'claim';
alter table public.bwallet_paymail_name_fees drop constraint if exists bwallet_paymail_name_fees_kind_check;
alter table public.bwallet_paymail_name_fees add constraint bwallet_paymail_name_fees_kind_check
  check (kind in ('claim', 'extra'));
create index if not exists bwallet_paymail_name_fees_created on public.bwallet_paymail_name_fees (created_at);
commit;
notify pgrst, 'reload schema';
