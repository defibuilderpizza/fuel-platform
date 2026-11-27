-- Sellers confirm they run the compute themselves or have the right to resell it. Recorded when
-- they apply (and on every update of the listing).
alter table public.sellers add column attested_at timestamptz;
