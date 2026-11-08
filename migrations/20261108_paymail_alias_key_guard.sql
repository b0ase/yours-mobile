-- b-Aware #F-237 defence in depth: a name's identity_key changes ONLY through a signed handover.
-- NOT RUN YET. Owner review, then (owner, not automated):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261108_paymail_alias_key_guard.sql
--   (the file ends with notify pgrst, 'reload schema' so PostgREST sees bwallet_move_alias at once)
--
-- What it does
--   1. A BEFORE UPDATE trigger on bwallet_paymail_aliases refuses any change to identity_key unless the
--      transaction-local setting bwallet.allow_key_change = 'on'. That covers a plain PATCH and the UPDATE half of
--      INSERT ... ON CONFLICT DO UPDATE (the PostgREST merge-duplicates upsert that #F-237 abused). Renames, display
--      names, ord address, is_primary are unaffected; INSERT and DELETE are unaffected.
--   2. bwallet_move_alias(p_alias, p_from, p_to): the one way past the trigger. Moves a name only while it still
--      points at p_from (the releasing key), sets is_primary as moveAlias always did, and tags the name log entry
--      (bwallet_alias_owner_log trigger) with note 'handover'. service_role only. The paymail server calls it from
--      paymailStore.moveAlias (handover-accept); before this migration exists it falls back to the same guarded PATCH.
--
-- Order
--   Either order is safe for names. Applied BEFORE the site deploy of fix/sec-paymail-register-race, it closes the
--   race in production at once (the old server's racing upsert then fails with an error instead of re-pointing the
--   name), but two-party handovers (handover-accept) fail until that deploy, because the old server moves names with
--   a plain PATCH. Applied AFTER the deploy, nothing breaks.
--
-- Manual edits by us (psql) that really must re-point a name:
--   begin; set local bwallet.allow_key_change = 'on'; update public.bwallet_paymail_aliases set ... ; commit;
--   (the name log records them as actor 'admin', as before.) The runbook in migrations/20261024_company_offers.sql
--   (company alias provisioning) uses this form.
--
-- Assumes migration STEP A (is_primary) has run: paymailStore already reads is_primary in production.
-- Check after applying: there must be no other SECURITY DEFINER function or "exec SQL" RPC exposed to PostgREST that
-- could call set_config('bwallet.allow_key_change', ...) on a caller's behalf.
--
-- Rollback (the site keeps working: moveAlias falls back to its guarded PATCH when the RPC is gone):
--   begin;
--   drop trigger if exists bwallet_alias_key_guard on public.bwallet_paymail_aliases;
--   drop function if exists public.bwallet_alias_key_guard();
--   drop function if exists public.bwallet_move_alias(text, text, text);
--   commit;
--   notify pgrst, 'reload schema';
--
-- Written by hand (8 Nov 2026 re-review): an earlier copy was mangled by a scripted edit; site/test/migrations.test.js
-- now checks this file's shape (one transaction, both key checks, nothing after the final notify).
begin;

create or replace function public.bwallet_alias_key_guard() returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.identity_key is distinct from old.identity_key
     and coalesce(current_setting('bwallet.allow_key_change', true), '') <> 'on' then
    raise exception 'bwallet_paymail_aliases.identity_key changes only through bwallet_move_alias (signed handover)'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists bwallet_alias_key_guard on public.bwallet_paymail_aliases;
create trigger bwallet_alias_key_guard before update on public.bwallet_paymail_aliases
  for each row execute function public.bwallet_alias_key_guard();

create or replace function public.bwallet_move_alias(p_alias text, p_from text, p_to text) returns boolean
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  has_main boolean;
  n integer;
begin
  -- Keys are stored lower-case (the column check allows only lower-case hex); the server lower-cases them too, so
  -- normalise here the same way rather than refuse an upper-case hex key.
  p_from := lower(p_from);
  p_to := lower(p_to);
  if p_from !~ '^0[23][0-9a-f]{64}$' then
    raise exception 'bwallet_move_alias: bad from key' using errcode = '22023';
  end if;
  if p_to !~ '^0[23][0-9a-f]{64}$' then
    raise exception 'bwallet_move_alias: bad to key' using errcode = '22023';
  end if;
  if p_from = p_to then
    raise exception 'bwallet_move_alias: from and to are the same key' using errcode = '22023';
  end if;
  select exists (
    select 1 from public.bwallet_paymail_aliases
     where identity_key = p_to and kind = 'plain' and is_primary is true
  ) into has_main;
  perform set_config('bwallet.allow_key_change', 'on', true);
  perform set_config('bwallet.name_note', 'handover', true);
  update public.bwallet_paymail_aliases
     set identity_key = p_to, is_primary = not has_main, updated_at = now()
   where alias = p_alias::citext and identity_key = p_from;
  get diagnostics n = row_count;
  -- Transaction-local anyway; cleared at once so nothing later in the same transaction rides on it.
  perform set_config('bwallet.allow_key_change', '', true);
  perform set_config('bwallet.name_note', '', true);
  return n > 0;
end $$;

revoke all on function public.bwallet_move_alias(text, text, text) from public, anon, authenticated;
grant execute on function public.bwallet_move_alias(text, text, text) to service_role;
revoke all on function public.bwallet_alias_key_guard() from public, anon, authenticated;

commit;
notify pgrst, 'reload schema';
