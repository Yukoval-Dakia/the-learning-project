import { tokenPlanEndpointOverride } from './model-catalog-overrides';

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
  return tokenPlanEndpointOverride(env);
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
