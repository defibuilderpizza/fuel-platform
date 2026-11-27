-- Faucet numbers as decided: $1 free trial; pay-later credit = 2% of ALL previous deposits.
-- The per-agent cap now applies to credit only and is optional (null = no cap); the $50 pot
-- still caps total exposure (trials granted + credit in use).

alter table public.faucet_config alter column max_per_agent_micro drop not null;
update public.faucet_config set trial_micro = 1000000, credit_share = 0.02, max_per_agent_micro = null where id = 1;

-- Everything a wallet has ever paid in (not faucet, not lane earnings).
create or replace function public.fuel_paid_in_total(p_wallet text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta_micro), 0)::bigint from ledger_entries
  where wallet = p_wallet and source in ('public_deposit', 'ring_topup') and delta_micro > 0
$$;

create or replace function public.fuel_credit_limit(p_wallet text) returns bigint
language sql stable security definer set search_path = public as $$
  select case when not c.enabled then 0 else greatest(0, least(
    c.max_per_agent_micro,                                   -- optional credit cap (null = none)
    floor(c.credit_share * fuel_paid_in_total(p_wallet))::bigint
  )) end
  from faucet_config c where c.id = 1
$$;

revoke all on function public.fuel_paid_in_total(text) from public, anon, authenticated;
revoke all on function public.fuel_credit_limit(text) from public, anon, authenticated;
