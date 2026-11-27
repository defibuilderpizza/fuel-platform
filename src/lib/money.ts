// Money is integer micro-USD everywhere (1 micro = $0.000001 = 1 USDC base unit).

export const MICRO_PER_USD = 1_000_000;

export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO_PER_USD);
}

export function microToUsd(micro: number | string | null | undefined): number {
  return Number(micro ?? 0) / MICRO_PER_USD;
}

/** Fuel's markup on provider cost, in basis points (spec: 5–10%). Default 10%. */
export function markupBps(): number {
  const v = Number(process.env.FUEL_MARKUP_BPS ?? 1000);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

/** Provider cost in micro-USD for a token count at a USD-per-1M-tokens rate. 1 token at $X/1M = X micro. */
export function tokenCostMicro(tokens: number, usdPerMTok: number): number {
  return Math.ceil(Math.max(0, tokens) * Math.max(0, usdPerMTok));
}

export function withMarkup(costMicro: number): number {
  return Math.ceil(costMicro * (1 + markupBps() / 10_000));
}
