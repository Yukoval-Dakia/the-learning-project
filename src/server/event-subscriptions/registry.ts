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

interface SubscriptionDeclarationSnapshot {
  readonly id: string;
  readonly version: number;
  readonly actions: readonly string[];
  readonly load: EventSubscriptionDecl['load'];
}

function compareDeclarations(
  a: SubscriptionDeclarationSnapshot,
  b: SubscriptionDeclarationSnapshot,
): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.version - b.version;
}

function computeDeclarationHash(declarations: readonly SubscriptionDeclarationSnapshot[]): string {
  const canonical = {
    contractVersion: EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION,
    subscriptions: declarations.map(({ id, version, actions }) => ({ id, version, actions })),
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
    .map(
      ({ id, version, actions, load }): SubscriptionDeclarationSnapshot =>
        Object.freeze({
          id,
          version,
          actions: Object.freeze([...actions].sort()),
          load,
        }),
    )
    .sort(compareDeclarations);
  const declarationHash = computeDeclarationHash(declarations);

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
        actions: declaration.actions,
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
    declarationHash,
    subscriptions: Object.freeze(loaded),
    get(id: string, version: number) {
      return byIdentity.get(identityKey(id, version));
    },
  });
}
