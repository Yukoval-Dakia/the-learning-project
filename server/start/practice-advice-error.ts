import { ApiError } from '@/ui/lib/api';

/**
 * Normalize an error thrown across the Start server-fn boundary by the advice
 * preview so callers read `error.details.crisis_referral` at the same position
 * the HTTP error contract documents.
 *
 * apiFetch packs every error-body key outside {error,message} into
 * ApiError.details; the advice error contract nests its fields under `details`
 * again ({details: {crisis_referral}} lands as details.details.crisis_referral)
 * — flatten once. Same-process server-fn execution skips apiFetch and rethrows
 * the raw Response object — rebuild the equivalent ApiError from the JSON body.
 */
export async function rethrowStartAdviceError(error: unknown): Promise<never> {
  if (error instanceof ApiError) {
    const nested = error.details?.details;
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      throw new ApiError(
        error.message,
        error.status,
        error.code,
        nested as Record<string, unknown>,
      );
    }
    throw error;
  }
  if (error instanceof Response) {
    let body: Record<string, unknown>;
    try {
      body = (await error.clone().json()) as Record<string, unknown>;
    } catch {
      throw error;
    }
    const { error: code, message, ...rest } = body;
    const details =
      rest.details !== null && typeof rest.details === 'object' && !Array.isArray(rest.details)
        ? (rest.details as Record<string, unknown>)
        : rest;
    throw new ApiError(
      typeof message === 'string' ? message : `${error.status} ${error.statusText}`,
      error.status,
      typeof code === 'string' ? code : undefined,
      details,
    );
  }
  throw error;
}
