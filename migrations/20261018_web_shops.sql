-- "Start your store" drafts (bwalletx.com/store). NOT RUN YET: the owner approves and runs it.
-- Written only by the paymail/site server with the service role (site/lib/webShops.js); every write is signed in the
-- browser by the wallet's identity key (BRC-43 [2,'bwalletx shop']). RLS on with no policies: anon/authenticated
-- can't read or write. One shop per identity key for now; the handle is the web address bwalletx.com/shop/<handle>.
-- status: draft (saved from the site, private) → review (b is checking it) → open (shown in the Store), or declined.
-- Nothing reads 'open' yet: the in-app Store still lists only our own shops (src/mobile/themeStore/shops.ts).
create table if not exists public.web_shops (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique check (identity_key ~ '^0[23][0-9a-f]{64}$'),
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  name text not null check (char_length(name) between 2 and 40),
  blurb text check (blurb is null or char_length(blurb) <= 280),
  -- { path, type, size } in the private web-shops bucket, or null.
  logo jsonb,
  banner jsonb,
  -- { accent: '#rrggbb', background: '#rrggbb' }
  colours jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'review', 'open', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists web_shops_status_idx on public.web_shops (status, updated_at desc);
alter table public.web_shops enable row level security;

-- Shop logos and banners (PNG, JPG, WebP; 2 MB max). Private bucket, written by the service role only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('web-shops', 'web-shops', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
