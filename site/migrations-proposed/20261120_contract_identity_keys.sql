-- PROPOSED, NOT RUN. Needs the owner's approval (final review of b-Aware row 352, F1).
-- The contracts catalogue (site/api/contracts.js sameBehaviour) finds a listing's possible originals by name and by
-- normalised source text, so an original stored before the form check (a source that isn't normalised) can be missed
-- by a renamed copy. This stores each row's identity keys (site/lib/contracts.js contractKeys, the same function the
-- wallet mirrors) and indexes them, so the lookup can become `identity_keys && array[...]` and find every original
-- whatever form its text was stored in.
--
-- Backfill: the keys need NFKC normalising, per-line trimming, sha256 and (for listings with no source) canonical
-- JSON, exactly as contractKeys computes them, so they are not recomputed in SQL. Print the statements with the
-- read-only script and review them before running:
--   cd site && SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/contractsUnnormalised.js --backfill-sql
-- Then the publish route must write identity_keys for every new row (a code change, after this has run).

begin;

alter table public.bwallet_contracts
  add column if not exists identity_keys text[] not null default '{}';

create index if not exists bwallet_contracts_identity_keys_gin
  on public.bwallet_contracts using gin (identity_keys);

-- Backfill statements from the script go here, one per row, e.g.:
-- update public.bwallet_contracts set identity_keys = array['src:<sha256>']::text[] where origin = '<txid>_0';

commit;
notify pgrst, 'reload schema';
