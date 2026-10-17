-- Signed name bindings + public append-only name log (owner, 17 Oct 2026: be as public as possible about who can
-- change a name). NOT RUN YET: the owner runs it (or OKs it). docs/NAME-BINDINGS.md has the design.
--
-- bwallet_name_bindings: the owner's latest signature over "alias@domain -> identity_key, seq N".
-- bwallet_name_log: every change to who a name points to, append-only, hash-chained (entry_hash covers the previous
-- entry's hash), readable by anyone through the paymail server. A trigger logs ANY change to
-- bwallet_paymail_aliases.identity_key. actor: 'owner' = a binding the name's owner signed; 'server' = a change
-- the paymail server made for an owner-signed request (it runs as service_role); 'admin' = anything else, i.e. a
-- direct database edit by us.

create table if not exists public.bwallet_name_bindings (
  alias citext primary key,
  identity_key text not null check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  seq integer not null check (seq > 0),
  signature text not null check (signature ~ '^[0-9a-f]{16,200}$'),
  signed_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.bwallet_name_bindings enable row level security;

create table if not exists public.bwallet_name_log (
  id bigint generated always as identity primary key,
  alias citext not null,
  identity_key text,
  prev_identity_key text,
  action text not null check (action in ('bind', 'claim', 'move', 'release')),
  actor text not null check (actor in ('owner', 'server', 'admin')),
  seq integer,
  signature text,
  note text,
  prev_hash text not null,
  entry_hash text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists bwallet_name_log_alias_idx on public.bwallet_name_log (alias, id desc);
alter table public.bwallet_name_log enable row level security;

-- Hash chain: entry_hash = sha256(prev_hash | alias | identity_key | prev_identity_key | action | actor | seq |
-- signature | note | created_at). Computed here so every writer (server or psql) chains the same way.
create or replace function public.bwallet_name_log_chain() returns trigger language plpgsql as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(hashtext('bwallet_name_log'));
  select entry_hash into prev from public.bwallet_name_log order by id desc limit 1;
  new.prev_hash := coalesce(prev, repeat('0', 64));
  new.created_at := coalesce(new.created_at, now());
  new.entry_hash := encode(sha256(convert_to(concat_ws('|', new.prev_hash, new.alias, coalesce(new.identity_key, ''),
    coalesce(new.prev_identity_key, ''), new.action, new.actor, coalesce(new.seq::text, ''), coalesce(new.signature, ''),
    coalesce(new.note, ''), to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex');
  return new;
end $$;
drop trigger if exists bwallet_name_log_chain on public.bwallet_name_log;
create trigger bwallet_name_log_chain before insert on public.bwallet_name_log
  for each row execute function public.bwallet_name_log_chain();

-- Append-only: no updates or deletes, by anyone.
create or replace function public.bwallet_name_log_frozen() returns trigger language plpgsql as $$
begin
  raise exception 'bwallet_name_log is append-only';
end $$;
drop trigger if exists bwallet_name_log_frozen on public.bwallet_name_log;
create trigger bwallet_name_log_frozen before update or delete on public.bwallet_name_log
  for each row execute function public.bwallet_name_log_frozen();

-- Every change to who a name points to is logged: 'server' when the paymail server made it (service_role, after
-- verifying the owner's signed request), 'admin' for anything else (a psql edit by us included).
create or replace function public.bwallet_alias_owner_log() returns trigger language plpgsql as $$
declare actor text := case when session_user = 'authenticator' and current_user = 'service_role' then 'server' else 'admin' end;
begin
  if tg_op = 'INSERT' then
    insert into public.bwallet_name_log (alias, identity_key, action, actor, note)
      values (new.alias, new.identity_key, 'claim', actor, nullif(current_setting('bwallet.name_note', true), ''));
  elsif tg_op = 'UPDATE' and new.identity_key is distinct from old.identity_key then
    insert into public.bwallet_name_log (alias, identity_key, prev_identity_key, action, actor, note)
      values (new.alias, new.identity_key, old.identity_key, 'move', actor, nullif(current_setting('bwallet.name_note', true), ''));
  elsif tg_op = 'DELETE' then
    insert into public.bwallet_name_log (alias, prev_identity_key, action, actor, note)
      values (old.alias, old.identity_key, 'release', actor, nullif(current_setting('bwallet.name_note', true), ''));
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists bwallet_alias_owner_log on public.bwallet_paymail_aliases;
create trigger bwallet_alias_owner_log after insert or update of identity_key or delete on public.bwallet_paymail_aliases
  for each row execute function public.bwallet_alias_owner_log();

-- Tonight's three admin changes (owner-requested, 17 Oct 2026), recorded as the log's first entries.
insert into public.bwallet_name_log (alias, identity_key, prev_identity_key, action, actor, note, created_at) values
  ('npg', '026607f69e27c84eb19bfbc430575c46abec2a587712eac91b3b3f58e7f262b59b', '036850f65a26506266d8de81374dcbb8a7c1114ad021a887713e40b1cb510b3b70', 'move', 'admin', 'Owner request: name was on the wrong one of the owner''s two wallets', '2026-10-17 05:40:00+00'),
  ('ninjapunkgirls', '026607f69e27c84eb19bfbc430575c46abec2a587712eac91b3b3f58e7f262b59b', '036850f65a26506266d8de81374dcbb8a7c1114ad021a887713e40b1cb510b3b70', 'move', 'admin', 'Owner request: name was on the wrong one of the owner''s two wallets', '2026-10-17 05:40:00+00'),
  ('npgx', '036850f65a26506266d8de81374dcbb8a7c1114ad021a887713e40b1cb510b3b70', null, 'claim', 'admin', 'Owner request: assigned to the owner''s NPGX wallet', '2026-10-17 05:45:00+00');
