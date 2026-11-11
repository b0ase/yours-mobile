-- NOT RUN. Hold kurt@bwalletx.com for Kurt Wuckert Jr's X account (owner, 11 Nov 2026). Run AFTER
-- migrations/20261111_paymail_x_holds.sql and after the paymail server with site/lib/xHolds.js is deployed.
--
-- ⚠ ORDER MATTERS. Deploy, run the migration, run THIS, and check the x-hold read below says "held" BEFORE the claim
-- link (bchatx.com/claim/name/kurt) or its share card goes to anyone. Until the hold exists, `kurt` is an ordinary
-- 4-letter name: anyone who pays the $10 short-name fee can register it, and the hold never takes a name back.
--
-- X numeric user id 304746564 = @kurtwuckertjr (also the x_user_id on bChatX's syndicated_x_accounts row and in his
-- X banner URL). The @name below is for the claim page's words only; the id decides.
--
-- Either run this SQL (ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" < scripts/x-hold-kurt.sql)
-- or make the same hold through the admin op, which applies every rule (free, not reserved, not forwarding):
--
--   curl -sS -X POST https://pay.bwallet.space/api/paymail/x-hold-put \
--     -H 'Content-Type: application/json' -H "x-admin-secret: $PAYMAIL_ADMIN_SECRET" \
--     -d '{"alias":"kurt","x_user_id":"304746564","x_handle":"kurtwuckertjr","days":90,"note":"Held for Kurt Wuckert Jr (owner, 11 Nov 2026)"}'
--
-- Check it (public, no secret): curl -sS 'https://pay.bwallet.space/api/paymail/x-hold?alias=kurt'
--   → {"alias":"kurt","status":"held","xHandle":"kurtwuckertjr","expiresAt":"…"}
begin;

-- Refuse if somebody registered kurt in the meantime (the hold never takes a name away).
do $$
begin
  if exists (select 1 from public.bwallet_paymail_aliases where alias = 'kurt') then
    raise exception 'kurt is already registered: no hold made';
  end if;
  if exists (select 1 from public.bwallet_paymail_forwards where from_alias = 'kurt' and (expires_at is null or expires_at > now())) then
    raise exception 'kurt is still forwarding for its old owner: no hold made';
  end if;
end $$;

insert into public.bwallet_paymail_x_holds (alias, x_user_id, x_handle, note, expires_at)
values ('kurt', '304746564', 'kurtwuckertjr', 'Held for Kurt Wuckert Jr (owner, 11 Nov 2026)', now() + interval '90 days')
on conflict (alias) do nothing;

commit;
