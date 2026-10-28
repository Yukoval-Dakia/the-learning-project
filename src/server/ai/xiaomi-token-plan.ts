import { endpointKeyOf } from '@/core/config/model-endpoint-allowlist';
import { TOKEN_PLAN_ENDPOINT_KEYS, tokenPlanEndpointOverride } from './model-catalog-overrides';

/**
 * Fail visibly if an explicit vision override would leak the Token Plan key:
 * the pay-as-you-go endpoint gets a dedicated message, and any host (or port)
 * other than the Token Plan regional endpoints is refused (YUK-1654).
 */
function tokenPlanEndpoint(raw: string, envName: string): string {
  const url = new URL(raw);
  if (url.hostname === 'api.xiaomimimo.com') {
    throw new Error(
      `${envName} cannot use the Xiaomi pay-as-you-go endpoint with Token Plan credentials`,
    );
  }
  const key = endpointKeyOf(raw);
  if (key === undefined || !TOKEN_PLAN_ENDPOINT_KEYS.has(key)) {
    throw new Error(
      `${envName} must point at a Token Plan regional endpoint (token-plan-cn/sgp/ams.xiaomimimo.com); the Token Plan key is not sent anywhere else`,
    );
  }
  return raw.replace(/\/+$/u, '');
}

/** The operator vision probe uses Messages; product tasks use native pi Completions. */
export function xiaomiTokenPlanVisionBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.MIMO_VISION_BASE_URL?.trim();
  if (explicit) return tokenPlanEndpoint(explicit, 'MIMO_VISION_BASE_URL');
  const baseUrl = tokenPlanEndpointOverride(env);
  if (!baseUrl.endsWith('/v1')) {
    throw new Error('Set MIMO_VISION_BASE_URL for a Token Plan base URL without /v1');
  }
  return `${baseUrl.slice(0, -3)}/anthropic`;
}
