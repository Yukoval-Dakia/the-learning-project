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
  // Load all factories in parallel — the loaders are independent (dynamic imports with no shared
  // state), so awaiting them serially only adds startup latency (YUK-751 review). Each load is
  // wrapped so a dynamic-import / loader throw names the offending subscription instead of surfacing
  // a bare import error.
  const factories = await Promise.all(
    declarations.map(async (declaration) => {
      const identity = `${declaration.id}@v${declaration.version}`;
      let factory: Awaited<ReturnType<typeof declaration.load>>;
      try {
        factory = await declaration.load();
      } catch (cause) {
        throw new Error(`event subscription '${identity}' loader failed`, { cause });
      }
      if (typeof factory !== 'function') {
        throw new TypeError(
          `event subscription '${identity}' loader returned a non-function factory`,
        );
      }
      return { declaration, identity, factory };
    }),
  );
  // Instantiate handlers + build the loaded list in the (sorted) declaration order.
  for (const { declaration, identity, factory } of factories) {
    let handler: ReturnType<typeof factory>;
    try {
      handler = factory(dependency);
    } catch (cause) {
      throw new Error(`event subscription '${identity}' factory failed`, { cause });
    }
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
