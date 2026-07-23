import { createHash } from 'node:crypto';

import type { CapabilityManifest, EventSubscriptionDecl } from '@/kernel/manifest';
import { validateComposition } from '@/kernel/manifest';

import type {
  EventSubscriptionFactoryDependency,
  LoadedEventSubscription,
  LoadedEventSubscriptionRegistry,
} from './types';

export const EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION = 'event-subscription-registry/v1';

function identityKey(id: string, version: number): string {
  return JSON.stringify([id, version]);
}

function compareDeclarations(a: EventSubscriptionDecl, b: EventSubscriptionDecl): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.version - b.version;
}

function computeDeclarationHash(declarations: readonly EventSubscriptionDecl[]): string {
  const canonical = {
    contractVersion: EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION,
    subscriptions: declarations.map(({ id, version, actions }) => ({
      id,
      version,
      actions: [...actions].sort(),
    })),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Validates the complete capability composition, then crosses the executable
 * boundary by loading and instantiating every declared subscription handler.
 */
export async function loadEventSubscriptionRegistry(
  capabilities: CapabilityManifest[],
  dependency: EventSubscriptionFactoryDependency,
): Promise<LoadedEventSubscriptionRegistry> {
  validateComposition(capabilities);

  const declarations = capabilities
    .flatMap((capability) => capability.subscriptions?.handlers ?? [])
    .sort(compareDeclarations);

  const loaded: LoadedEventSubscription[] = [];
  for (const declaration of declarations) {
    const identity = `${declaration.id}@v${declaration.version}`;
    const factory = await declaration.load();
    if (typeof factory !== 'function') {
      throw new TypeError(
        `event subscription '${identity}' loader returned a non-function factory`,
      );
    }

    const handler = factory(dependency);
    if (typeof handler !== 'function') {
      throw new TypeError(
        `event subscription '${identity}' factory returned a non-function handler`,
      );
    }

    loaded.push(
      Object.freeze({
        id: declaration.id,
        version: declaration.version,
        actions: Object.freeze([...declaration.actions].sort()),
        handler,
      }),
    );
  }

  const byIdentity = new Map(
    loaded.map((subscription) => [
      identityKey(subscription.id, subscription.version),
      subscription,
    ]),
  );

  return Object.freeze({
    contractVersion: EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION,
    declarationHash: computeDeclarationHash(declarations),
    subscriptions: Object.freeze(loaded),
    get(id: string, version: number) {
      return byIdentity.get(identityKey(id, version));
    },
  });
}
