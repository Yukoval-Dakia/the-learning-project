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

export class HostOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostOperationConflictError';
  }
}

export type HostOperationInstallPhase = 'host' | 'worker';

/**
 * Kernel port slots are process-wide, not module-instance state. One process can
 * host a second copy of these modules — the built Start bundle (RW_FRONTDOOR=1)
 * and Vite SSR (RW_FRONTDOOR=dev) each evaluate their own module graph — so a
 * module-level slot installed by the API host reads as unset in the other graph.
 * Ports store the installed operation here instead; installation still runs once
 * at host startup in the API graph, and the installed function keeps that graph's
 * hydrated config and DB pool.
 */

interface HostOperationRegistration {
  phase: HostOperationInstallPhase | 'direct';
  operation: unknown;
}

type HostOperationRegistry = Map<string, unknown>;

interface HostOperationInstallation {
  status: 'installing' | 'ready' | 'failed';
  promise: Promise<void>;
}

type HostOperationInstallationRegistry = Map<string, HostOperationInstallation>;

const REGISTRY_KEY = '__loomHostOperations';
const INSTALLATION_REGISTRY_KEY = '__loomHostOperationInstallations';

function sharedRegistry(): HostOperationRegistry {
  const host = globalThis as Record<string, unknown>;
  let registry = host[REGISTRY_KEY] as HostOperationRegistry | undefined;
  if (!registry) {
    registry = new Map();
    host[REGISTRY_KEY] = registry;
  }
  if (registry instanceof Map) return registry;
  throw new HostOperationConflictError('host operation registry has an incompatible shape');
}

function sharedInstallationRegistry(): HostOperationInstallationRegistry {
  const host = globalThis as Record<string, unknown>;
  let registry = host[INSTALLATION_REGISTRY_KEY] as HostOperationInstallationRegistry | undefined;
  if (!registry) {
    registry = new Map();
    host[INSTALLATION_REGISTRY_KEY] = registry;
  }
  return registry;
}

function isRegistration(value: unknown): value is HostOperationRegistration {
  return typeof value === 'object' && value !== null && 'phase' in value && 'operation' in value;
}

function registeredOperation(value: unknown): unknown {
  return isRegistration(value) ? value.operation : value;
}

type AnyFunction = (...args: never[]) => unknown;

function sameFunction(left: AnyFunction, right: AnyFunction): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.name === right.name &&
      left.toString() === right.toString())
  );
}

function equivalentHostOperations(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === 'function' && typeof right === 'function') {
    return sameFunction(left as AnyFunction, right as AnyFunction);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equivalentHostOperations(value, right[index]))
    );
  }
  if (left instanceof Set && right instanceof Set) {
    return (
      left.size === right.size &&
      [...left].every((value) =>
        [...right].some((candidate) => equivalentHostOperations(value, candidate)),
      )
    );
  }
  if (left instanceof Map && right instanceof Map) {
    return (
      left.size === right.size &&
      [...left].every(([key, value]) => {
        const matchingKey = [...right.keys()].find((candidate) =>
          equivalentHostOperations(key, candidate),
        );
        return matchingKey !== undefined && equivalentHostOperations(value, right.get(matchingKey));
      })
    );
  }
  if (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null &&
    Object.getPrototypeOf(left) === Object.prototype &&
    Object.getPrototypeOf(right) === Object.prototype
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    const rightValues = right as Record<string, unknown>;
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          key in right &&
          equivalentHostOperations(left[key as keyof typeof left], rightValues[key]),
      )
    );
  }
  return false;
}

export function installHostOperation<T>(key: string, operation: T): void {
  const registry = sharedRegistry();
  const installed = registry.get(key);
  if (
    installed !== undefined &&
    !equivalentHostOperations(registeredOperation(installed), operation)
  ) {
    throw new HostOperationConflictError(
      `host operation "${key}" is already installed with a different operation`,
    );
  }
  registry.set(key, {
    phase: 'direct',
    operation,
  });
}

export function installedHostOperation<T>(key: string): T | undefined {
  return registeredOperation(sharedRegistry().get(key)) as T | undefined;
}

/**
 * Runs one owner's phase once. Concurrent callers share the attempt; a failed
 * attempt is not marked ready and remains retryable.
 */
export async function runHostOperationInstallation(
  owner: string,
  phase: HostOperationInstallPhase,
  install: () => Promise<void>,
): Promise<void> {
  const installations = sharedInstallationRegistry();
  const key = `${owner}:${phase}`;
  const existing = installations.get(key);
  if (existing?.status === 'ready') return;
  if (existing?.status === 'installing') return existing.promise;

  const before = [...sharedRegistry()];
  const promise = Promise.resolve().then(install);

  installations.set(key, { status: 'installing', promise });
  try {
    await promise;
    installations.set(key, { status: 'ready', promise });
  } catch (error) {
    const registry = sharedRegistry();
    registry.clear();
    for (const [entryKey, operation] of before) registry.set(entryKey, operation);
    installations.set(key, { status: 'failed', promise });
    throw error;
  }
}
