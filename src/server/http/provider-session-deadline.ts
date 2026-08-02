/**
 * Keep synchronous API work below cloudflared's 100s idle window while leaving
 * cleanup/response headroom. Every central provider session started by one Hono
 * request consumes the same absolute budget; durable workers have no HTTP scope.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HTTP_PROVIDER_SESSION_BUDGET_MS } from '@/kernel/http';

export { HTTP_PROVIDER_SESSION_BUDGET_MS };

interface ProviderSessionDeadlineScope {
  deadlineAt: number;
}

const providerSessionDeadlineStorage = new AsyncLocalStorage<ProviderSessionDeadlineScope>();

function assertDeadline(deadlineAt: number): void {
  if (!Number.isFinite(deadlineAt)) {
    throw new RangeError('provider session deadline must be finite');
  }
}

/**
 * Run one HTTP request inside an absolute provider-session deadline. Nested
 * scopes may tighten their parent but can never widen it.
 */
export function runWithHttpProviderSessionDeadline<T>(deadlineAt: number, callback: () => T): T {
  assertDeadline(deadlineAt);
  const parentDeadlineAt = providerSessionDeadlineStorage.getStore()?.deadlineAt;
  const effectiveDeadlineAt =
    parentDeadlineAt === undefined ? deadlineAt : Math.min(parentDeadlineAt, deadlineAt);
  return providerSessionDeadlineStorage.run({ deadlineAt: effectiveDeadlineAt }, callback);
}

export function currentHttpProviderSessionDeadlineAt(): number | undefined {
  return providerSessionDeadlineStorage.getStore()?.deadlineAt;
}

/**
 * An explicit caller deadline is still useful for work that can outlive an HTTP
 * handler. While the request is active, the runner always honors the earlier
 * of that explicit value and the composition-root deadline.
 */
export function resolveProviderSessionDeadlineAt(explicitDeadlineAt?: number): number | undefined {
  if (explicitDeadlineAt !== undefined) assertDeadline(explicitDeadlineAt);
  const requestDeadlineAt = currentHttpProviderSessionDeadlineAt();
  if (requestDeadlineAt === undefined) return explicitDeadlineAt;
  if (explicitDeadlineAt === undefined) return requestDeadlineAt;
  return Math.min(requestDeadlineAt, explicitDeadlineAt);
}
