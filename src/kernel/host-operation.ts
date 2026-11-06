/**
 * Thrown when a kernel port is used before its owning capability installed it at
 * startup. This is a wiring defect in the host, not a transient read failure, so
 * callers that degrade on errors must rethrow it rather than hide it.
 */
export class HostOperationNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostOperationNotInstalledError';
  }
}

/**
 * Kernel port slots are process-wide, not module-instance state. One process can
 * host a second copy of these modules — the built Start bundle (RW_FRONTDOOR=1)
 * and Vite SSR (RW_FRONTDOOR=dev) each evaluate their own module graph — so a
 * module-level slot installed by the API host reads as unset in the other graph.
 * Ports store the installed operation here instead; installation still runs once
 * at host startup in the API graph, and the installed function keeps that graph's
 * hydrated config and DB pool.
 */

type HostOperationRegistry = Map<string, unknown>;

const REGISTRY_KEY = '__loomHostOperations';

function sharedRegistry(): HostOperationRegistry {
  const host = globalThis as Record<string, unknown>;
  let registry = host[REGISTRY_KEY] as HostOperationRegistry | undefined;
  if (!registry) {
    registry = new Map();
    host[REGISTRY_KEY] = registry;
  }
  return registry;
}

export function installHostOperation<T>(key: string, operation: T): void {
  sharedRegistry().set(key, operation);
}

export function installedHostOperation<T>(key: string): T | undefined {
  return sharedRegistry().get(key) as T | undefined;
}
