-- NOT RUN. Hold kurt@, kurtwuckert@ and kurtwuckertjr@bwalletx.com for Kurt Wuckert Jr's X account (owner, 11 Nov
-- 2026; kurtwuckert / kurtwuckertjr added on the security re-review). Run AFTER
-- migrations/20261111_paymail_x_holds.sql and after the paymail server with site/lib/xHolds.js is deployed.
--
-- ⚠ ORDER MATTERS. Deploy, run the migration, run THIS, and check the x-hold reads below say "held" BEFORE the claim
-- link (bchatx.com/claim/name/kurt) or its share card goes to anyone. Until the holds exist, `kurt` is an ordinary
-- 4-letter name: anyone who pays the $10 short-name fee can register it, and a hold never takes a name back.
--
-- X numeric user id 304746564 = @kurtwuckertjr (also the x_user_id on bChatX's syndicated_x_accounts row and in his
-- X banner URL). The @name below is for the claim page's words only; the id decides. All three keep `near` on (the
-- default), so kurtt / kurtjr / kurt0 and the like are held for him too.
--
-- Either run this SQL (ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" < scripts/x-hold-kurt.sql)
-- or make the same holds through the admin op, which applies every rule (free, not reserved, not forwarding):
--
--   for a in kurt kurtwuckert kurtwuckertjr; do
--     curl -sS -X POST https://pay.bwallet.space/api/paymail/x-hold-put \
--       -H 'Content-Type: application/json' -H "x-admin-secret: $PAYMAIL_ADMIN_SECRET" \
--       -d "{\"alias\":\"$a\",\"x_user_id\":\"304746564\",\"x_handle\":\"kurtwuckertjr\",\"days\":90,\"near\":true,\"note\":\"Held for Kurt Wuckert Jr (owner, 11 Nov 2026)\"}"
--     echo
--   done
--
-- Check them (public, no secret):
--   for a in kurt kurtwuckert kurtwuckertjr; do curl -sS "https://pay.bwallet.space/api/paymail/x-hold?alias=$a"; echo; done
--   → {"alias":"kurt","status":"held","xHandle":"kurtwuckertjr","expiresAt":"…"} (and the same for the other two)
begin;

-- Refuse if somebody registered one of them in the meantime (a hold never takes a name away). All or nothing.
do $$
declare a text;
begin
  foreach a in array array['kurt', 'kurtwuckert', 'kurtwuckertjr'] loop
    if exists (select 1 from public.bwallet_paymail_aliases where alias = a) then
      raise exception '% is already registered: no holds made', a;
    end if;
    if exists (select 1 from public.bwallet_paymail_forwards where from_alias = a and (expires_at is null or expires_at > now())) then
      raise exception '% is still forwarding for its old owner: no holds made', a;
    end if;
  end loop;
end $$;

insert into public.bwallet_paymail_x_holds (alias, x_user_id, x_handle, note, near, expires_at)
values
  ('kurt',          '304746564', 'kurtwuckertjr', 'Held for Kurt Wuckert Jr (owner, 11 Nov 2026)', true, now() + interval '90 days'),
  ('kurtwuckert',   '304746564', 'kurtwuckertjr', 'Held for Kurt Wuckert Jr (owner, 11 Nov 2026)', true, now() + interval '90 days'),
  ('kurtwuckertjr', '304746564', 'kurtwuckertjr', 'Held for Kurt Wuckert Jr (owner, 11 Nov 2026)', true, now() + interval '90 days')
on conflict (alias) do nothing;

commit;
