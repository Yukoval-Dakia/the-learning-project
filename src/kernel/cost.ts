// Shared AI-cost numeric helpers; pure, used by the proposal writer and AI provenance.

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export function costUsdToMicroUsd(costUsd: number | null | undefined): number | null {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  const microUsd = costUsd * 1_000_000;
  if (!Number.isFinite(microUsd)) return null;
  const roundedMicroUsd = Math.round(microUsd);
  return Number.isSafeInteger(roundedMicroUsd) &&
    roundedMicroUsd >= 0 &&
    roundedMicroUsd <= POSTGRES_INTEGER_MAX
    ? roundedMicroUsd
    : null;
}

export function sumAllKnownCostUsd(costs: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const cost of costs) {
    if (cost == null || !Number.isFinite(cost)) return null;
    total += cost;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}
