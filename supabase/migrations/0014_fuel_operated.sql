-- Fuel-operated capacity: GPUs Fuel itself rents or owns and lists as a seller.
-- Same tests and cheapest-first routing as every seller, labelled publicly, never in capacity
-- contracts (no bond, no premium from the credit reserve). The locked cost (e.g. a prepaid
-- 90-day rental) is what Fuel pays per hour until locked_until, and counts on the admin page
-- as compute cost already locked in.
alter table public.sellers
  add column operated_by_fuel boolean not null default false,
  add column locked_cost_hr   numeric check (locked_cost_hr is null or locked_cost_hr >= 0),  -- USD per hour, all GPUs on this endpoint
  add column locked_tps       numeric check (locked_tps is null or locked_tps > 0),           -- tokens/s it can serve (input + output)
  add column locked_until     timestamptz;
