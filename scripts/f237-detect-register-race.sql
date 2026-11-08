-- b-Aware #F-237: was the paymail register race (check-then-upsert) ever exploited? READ-ONLY. Not run by us.
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" < scripts/f237-detect-register-race.sql
-- The whole file runs in a READ ONLY transaction and is rolled back.
begin transaction read only;

-- 1. Name log (needs migrations/20261017_name_bindings.sql: the bwallet_alias_owner_log trigger logs every
--    identity_key change as action 'move'). A racing upsert shows as a 'move' with NO owner 'bind' carrying a handover
--    for the same alias, from the same old key to the same new key, after it. Legitimate handovers always write that
--    bind (handover-accept) straight after the move. actor 'admin' rows are psql edits by us (the three on 17 Oct 2026
--    are known and owner-requested); actor 'server' rows without a handover are the suspects.
select m.id,
       m.created_at,
       m.alias,
       m.actor,
       m.prev_identity_key as key_before,
       m.identity_key      as key_after,
       a.identity_key      as key_now,
       m.note
  from public.bwallet_name_log m
  left join public.bwallet_paymail_aliases a on a.alias = m.alias
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

-- 2. Independent of the log trigger: two different wallets recorded a new-name event (claim / rename) for the SAME
--    alias within 10 minutes. Both racing requests answer 200 and both record an event, so a race leaves this pair
--    (plain names only; social names record no event). key_now shows who holds the name today.
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

-- 3. Paid names now held by a key other than the one that paid for them (a victim's fee, or a lawful handover:
--    cross-check with query 1). Each row is a candidate refund / restore.
select f.txid,
       f.created_at,
       f.alias,
       f.kind,
       f.usd,
       f.identity_key as paid_by,
       a.identity_key as key_now
  from public.bwallet_paymail_name_fees f
  join public.bwallet_paymail_aliases a on a.alias = f.alias
 where a.identity_key <> f.identity_key
 order by f.created_at;

rollback;
