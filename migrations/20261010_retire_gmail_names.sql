-- One-off: retire legacy .gmail paymail names (they publish the owner's email address). Owner, 10 Oct 2026.
-- A .gmail name whose wallet also has a plain name becomes a 90-day forward to that plain name, then is
-- released. Wallets with ONLY a .gmail name keep it; the app asks them to choose a name, and the server
-- converts it the same way when they do (site/lib/paymail.js register). .x names are untouched.
-- Needs 20261010_bwallet_paymail_anti_squat.sql first (forwards accept .gmail from_alias).

-- 1) Dry run: what would change.
select g.alias as gmail_alias, p.alias as plain_alias, left(g.identity_key, 12) as key,
       (select count(*) from public.bwallet_paymail_payments x where x.alias = g.alias) as payments
from public.bwallet_paymail_aliases g
join public.bwallet_paymail_aliases p on p.identity_key = g.identity_key and p.kind = 'plain'
where g.kind = 'gmail';
select count(*) as gmail_only_left
from public.bwallet_paymail_aliases g
where g.kind = 'gmail'
  and not exists (select 1 from public.bwallet_paymail_aliases p where p.identity_key = g.identity_key and p.kind = 'plain');

-- 2) Convert (in a transaction, with a backup copy of the rows touched).
begin;
create table if not exists public.bwallet_paymail_aliases_gmail_backup_20261010 as
  select * from public.bwallet_paymail_aliases where false;
insert into public.bwallet_paymail_aliases_gmail_backup_20261010
  select g.* from public.bwallet_paymail_aliases g
  where g.kind = 'gmail'
    and exists (select 1 from public.bwallet_paymail_aliases p where p.identity_key = g.identity_key and p.kind = 'plain');
revoke all on public.bwallet_paymail_aliases_gmail_backup_20261010 from anon, authenticated;

create temp table conv on commit drop as
  select g.alias as gmail_alias, (select p.alias from public.bwallet_paymail_aliases p
          where p.identity_key = g.identity_key and p.kind = 'plain' order by p.created_at limit 1) as plain_alias,
         g.identity_key
  from public.bwallet_paymail_aliases g
  where g.kind = 'gmail'
    and exists (select 1 from public.bwallet_paymail_aliases p where p.identity_key = g.identity_key and p.kind = 'plain');

insert into public.bwallet_paymail_forwards (from_alias, to_alias, identity_key, expires_at)
  select gmail_alias, plain_alias, identity_key, now() + interval '90 days' from conv
  on conflict (from_alias) do update set to_alias = excluded.to_alias, identity_key = excluded.identity_key,
    expires_at = excluded.expires_at;
-- Payment records follow the wallet's plain name (FK alias), so the alias row can go.
update public.bwallet_paymail_payments x set alias = c.plain_alias from conv c where x.alias = c.gmail_alias;
delete from public.bwallet_paymail_aliases a using conv c where a.alias = c.gmail_alias;
select count(*) as converted from conv;
commit;
