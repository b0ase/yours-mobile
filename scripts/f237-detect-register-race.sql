-- b-Aware #F-237: was the paymail register race (check-then-upsert) ever exploited? READ-ONLY. Not run by us.
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" < scripts/f237-detect-register-race.sql
-- Each query runs in its own READ ONLY transaction and is rolled back, so one that fails (a table or column that
-- isn't there yet) does not stop the others. Run WITHOUT -v ON_ERROR_STOP=1.

-- 1. Name log (needs migrations/20261017_name_bindings.sql: the bwallet_alias_owner_log trigger logs every
--    identity_key change as action 'move'). A racing upsert shows as a 'move' with NO owner 'bind' carrying a handover
--    for the same alias, from the same old key to the same new key, after it. Legitimate handovers write that bind
--    (handover-accept) straight after the move.
--    Known false positives:
--      - actor 'admin' rows are psql edits by us (the three on 17 Oct 2026 are known and owner-requested);
--      - a handover whose move succeeded but whose bind (putBinding / logName) then failed: a real, consented move
--        with no bind row. Check bwallet_name_handovers / bwallet_name_bindings (from_key, release_sig) for the alias.
--    actor 'server' rows that are neither are the suspects.
begin transaction read only;
select m.id,
       m.created_at,
       m.alias,
       m.actor,
       m.prev_identity_key as key_before,
       m.identity_key      as key_after,
       a.identity_key      as key_now,
       nb.from_key         as binding_from_key,
       m.note
  from public.bwallet_name_log m
  left join public.bwallet_paymail_aliases a on a.alias = m.alias
  left join public.bwallet_name_bindings nb on nb.alias = m.alias
 where m.action = 'move'
   and not exists (
         select 1
           from public.bwallet_name_log b
          where b.alias = m.alias
            and b.id > m.id
            and b.action = 'bind'
            and b.actor = 'owner'
            and b.identity_key = m.identity_key
            and b.prev_identity_key is not distinct from m.prev_identity_key
            and b.note like 'handover:%'
       )
 order by m.created_at;
rollback;

-- 2. Independent of the log trigger: two different wallets recorded a new-name event (claim / rename) for the SAME
--    alias within 10 minutes. Both racing requests answer 200 and both record an event, so a race leaves this pair
--    (plain names only; social names record no event). key_now shows who holds the name today. False positive: a
--    name released (unlink / delete) and claimed again by someone else within the 10 minutes.
begin transaction read only;
select e1.alias,
       e1.created_at   as first_at,
       e1.identity_key as first_key,
       e1.kind         as first_kind,
       e2.created_at   as second_at,
       e2.identity_key as second_key,
       e2.kind         as second_kind,
       a.identity_key  as key_now
  from public.bwallet_paymail_name_events e1
  join public.bwallet_paymail_name_events e2
    on e2.alias = e1.alias
   and e2.id > e1.id
   and e2.identity_key <> e1.identity_key
   and e2.created_at < e1.created_at + interval '10 minutes'
  left join public.bwallet_paymail_aliases a on a.alias = e1.alias
 order by e1.created_at;
rollback;

-- 3. Paid names the payer no longer holds under that alias, whatever happened next. status:
--      'other key'  - the alias is held by another key today (a race victim, or a lawful handover: check query 1);
--      'renamed'    - no row under that alias; the payer still has a forward from it (renamed / removed by the payer);
--      'gone'       - no row and no forward of the payer (released, or renamed > 90 days ago, or lost in a race and
--                     then renamed by whoever took it: check payer_names_now and query 2).
--    Each 'other key' / 'gone' row is a candidate refund or restore.
begin transaction read only;
select f.txid,
       f.created_at,
       f.alias,
       f.kind,
       f.usd,
       f.identity_key as paid_by,
       a.identity_key as key_now,
       case
         when a.alias is not null then 'other key'
         when fw.from_alias is not null then 'renamed'
         else 'gone'
       end as status,
       fw.to_alias as payer_forward_to,
       (select string_agg(p.alias::text, ', ' order by p.created_at)
          from public.bwallet_paymail_aliases p
         where p.identity_key = f.identity_key) as payer_names_now
  from public.bwallet_paymail_name_fees f
  left join public.bwallet_paymail_aliases a on a.alias = f.alias
  left join public.bwallet_paymail_forwards fw on fw.from_alias = f.alias and fw.identity_key = f.identity_key
 where a.identity_key is distinct from f.identity_key
 order by f.created_at;
rollback;
