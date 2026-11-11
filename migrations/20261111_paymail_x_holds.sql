-- Names held for an X account (owner, 11 Nov 2026: hold kurt@bwalletx.com for Kurt Wuckert Jr). NOT RUN YET: the
-- owner runs it. Additive and idempotent: safe to run twice. site/lib/xHolds.js, site/lib/paymail.js.
--
-- bwallet_paymail_x_holds: a plain paymail alias kept for ONE X account, named by X's numeric user id (never the
-- @name: @names change hands). While a hold is live, register / names-add refuse the alias to every wallet except
-- one that proves that X account: its identity key has a verified X link (bwallet_social_links, account =
-- sha256('x:' || x_user_id)), or the register request carries a fresh Continue with X ticket for that id. The
-- holder claims it free (no name fee).
--
--   x_handle     the @name when the hold was made, for the claim page's words only. Never used to decide anything.
--   expires_at   an unclaimed hold lapses here and the name follows the normal rules again. NULL = no end.
--   released_at  the owner let the hold go early.
--   claimed_*    the first wallet that took the name under the hold (set once, never overwritten).
--
-- Written only by the admin op (x-hold-put, PAYMAIL_ADMIN_SECRET) or by hand. bChatX (bit-sign) reads it so the
-- same name can't be taken as a $handle there either (src/lib/x-paymail-holds.ts).
begin;

create table if not exists public.bwallet_paymail_x_holds (
  alias citext primary key check (alias ~ '^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$'),
  x_user_id text not null check (x_user_id ~ '^[0-9]{1,25}$'),
  x_handle text not null default '' check (x_handle ~ '^[a-z0-9_]{0,15}$'),
  note text not null default '' check (char_length(note) <= 200),
  expires_at timestamptz,
  released_at timestamptz,
  claimed_at timestamptz,
  claimed_key text check (claimed_key is null or claimed_key ~ '^0[23][0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
-- One live hold per X account would be a product rule, not a safety one; several names for one account are allowed.
create index if not exists bwallet_paymail_x_holds_x_user on public.bwallet_paymail_x_holds (x_user_id);

alter table public.bwallet_paymail_x_holds enable row level security;
revoke all on public.bwallet_paymail_x_holds from anon, authenticated;

commit;
notify pgrst, 'reload schema';
