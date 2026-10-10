/** Fail visibly if a retained pay-as-you-go override would receive a Token Plan key. */
function tokenPlanEndpoint(raw: string, envName: string): string {
  const url = new URL(raw);
  if (url.hostname === 'api.xiaomimimo.com') {
    throw new Error(
      `${envName} cannot use the Xiaomi pay-as-you-go endpoint with Token Plan credentials`,
    );
  }
  return raw.replace(/\/+$/u, '');
}

/** Token Plan credentials and endpoints are separate from Xiaomi pay-as-you-go. */
export function xiaomiTokenPlanBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.XIAOMI_TOKEN_PLAN_BASE_URL?.trim();
  if (explicit) return tokenPlanEndpoint(explicit, 'XIAOMI_TOKEN_PLAN_BASE_URL');
  const region = env.XIAOMI_TOKEN_PLAN_REGION?.trim() || 'cn';
  if (region !== 'cn' && region !== 'sgp' && region !== 'ams') {
    throw new Error('XIAOMI_TOKEN_PLAN_REGION must be cn, sgp, or ams');
  }
  return `https://token-plan-${region}.xiaomimimo.com/v1`;
}

/** The operator vision probe uses Messages; product tasks use native pi Completions. */
export function xiaomiTokenPlanVisionBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.MIMO_VISION_BASE_URL?.trim();
  if (explicit) return tokenPlanEndpoint(explicit, 'MIMO_VISION_BASE_URL');
  const baseUrl = xiaomiTokenPlanBaseUrl(env);
  if (!baseUrl.endsWith('/v1')) {
    throw new Error('Set MIMO_VISION_BASE_URL for a Token Plan base URL without /v1');
  }
  return `${baseUrl.slice(0, -3)}/anthropic`;
}
