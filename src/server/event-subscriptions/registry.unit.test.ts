import { describe, expect, it, vi } from 'vitest';

import type {
  CapabilityManifest,
  EventSubscriptionDecl,
  EventSubscriptionHandlerFactory,
} from '@/kernel/manifest';

import {
  EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION,
  loadEventSubscriptionRegistry,
} from './registry';

const actionA = 'experimental:event.a';
const actionB = 'Experimental: event.b ';

function declaration(
  id: string,
  version: number,
  actions: readonly string[],
  load: EventSubscriptionDecl['load'] = async () => () => async () => ({ status: 'succeeded' }),
): EventSubscriptionDecl {
  return { id, version, actions, load };
}

function capabilities(
  subscriptions: EventSubscriptionDecl[],
  eventActions: string[] = [actionA, actionB],
): CapabilityManifest[] {
  return [
    { name: 'events', description: 'event owner', events: { actions: eventActions } },
    {
      name: 'subscribers',
      description: 'subscriber owner',
      subscriptions: { handlers: subscriptions },
    },
  ];
}

async function hashFor(subscriptions: EventSubscriptionDecl[]): Promise<string> {
  const eventActions = [...new Set(subscriptions.flatMap(({ actions }) => actions))];
  return (await loadEventSubscriptionRegistry(capabilities(subscriptions, eventActions), {}))
    .declarationHash;
}

describe('loadEventSubscriptionRegistry', () => {
  it('does not invoke lazy loaders before registry load, then loads every handler successfully', async () => {
    const dependency = { marker: 'explicit dependency' };
    const handler = vi.fn(async () => ({ status: 'succeeded' as const }));
    const factory = vi.fn(() => handler);
    const load = vi.fn(async () => factory);
    const manifests = capabilities([declaration('subscriber.a', 1, [actionA], load)]);

    expect(load).not.toHaveBeenCalled();
    const registry = await loadEventSubscriptionRegistry(manifests, dependency);

    expect(load).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(dependency);
    expect(registry.get('subscriber.a', 1)?.handler).toBe(handler);
    expect(registry.contractVersion).toBe(EVENT_SUBSCRIPTION_REGISTRY_CONTRACT_VERSION);
  });

  it('produces the same hash and ordering across declaration and action ordering', async () => {
    const first = await loadEventSubscriptionRegistry(
      capabilities([
        declaration('subscriber.z', 2, [actionB, actionA]),
        declaration('subscriber.a', 1, [actionA]),
      ]),
      {},
    );
    const second = await loadEventSubscriptionRegistry(
      capabilities([
        declaration('subscriber.a', 1, [actionA]),
        declaration('subscriber.z', 2, [actionA, actionB]),
      ]),
      {},
    );

    expect(first.declarationHash).toBe(second.declarationHash);
    expect(first.subscriptions.map(({ id, version }) => [id, version])).toEqual([
      ['subscriber.a', 1],
      ['subscriber.z', 2],
    ]);
    expect(first.subscriptions.map(({ id, version }) => [id, version])).toEqual(
      second.subscriptions.map(({ id, version }) => [id, version]),
    );
  });

  it('changes the hash for subscriber identity, version, or an exact action change', async () => {
    const original = await hashFor([declaration('subscriber.a', 1, [actionA])]);

    expect(await hashFor([declaration('subscriber.b', 1, [actionA])])).not.toBe(original);
    expect(await hashFor([declaration('subscriber.a', 2, [actionA])])).not.toBe(original);
    expect(await hashFor([declaration('subscriber.a', 1, [actionA.toUpperCase()])])).not.toBe(
      original,
    );
    expect(await hashFor([declaration('subscriber.a', 1, [`${actionA} `])])).not.toBe(original);
  });

  it('propagates loader rejection without invoking later factories', async () => {
    const rejection = new Error('module failed to load');
    const factory = vi.fn();

    await expect(
      loadEventSubscriptionRegistry(
        capabilities([
          declaration('subscriber.a', 1, [actionA], async () => {
            throw rejection;
          }),
          declaration('subscriber.b', 1, [actionB], async () => factory),
        ]),
        {},
      ),
    ).rejects.toBe(rejection);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a non-function factory returned by a loader', async () => {
    const load = async () => ({}) as unknown as EventSubscriptionHandlerFactory;

    await expect(
      loadEventSubscriptionRegistry(
        capabilities([declaration('subscriber.a', 1, [actionA], load)]),
        {},
      ),
    ).rejects.toThrow(/subscriber\.a@v1.*non-function factory/);
  });

  it('rejects a non-function handler returned by a factory', async () => {
    const factory = (() => ({})) as unknown as EventSubscriptionHandlerFactory;

    await expect(
      loadEventSubscriptionRegistry(
        capabilities([declaration('subscriber.a', 1, [actionA], async () => factory)]),
        {},
      ),
    ).rejects.toThrow(/subscriber\.a@v1.*non-function handler/);
  });

  it('rejects invalid or duplicate manifests through the composition invariant before loading', async () => {
    const load = vi.fn(async () => () => async () => ({ status: 'succeeded' as const }));
    const duplicate = declaration('subscriber.same', 1, [actionA], load);

    await expect(
      loadEventSubscriptionRegistry(
        [
          ...capabilities([duplicate]),
          {
            name: 'other-subscribers',
            description: 'duplicate subscriber owner',
            subscriptions: { handlers: [duplicate] },
          },
        ],
        {},
      ),
    ).rejects.toThrow(/duplicate event subscription/);
    await expect(
      loadEventSubscriptionRegistry(
        capabilities([declaration('subscriber.invalid', 0, [actionA], load)]),
        {},
      ),
    ).rejects.toThrow(/invalid version/);
    expect(load).not.toHaveBeenCalled();
  });

  it('returns frozen data and performs exact identity lookup', async () => {
    const registry = await loadEventSubscriptionRegistry(
      capabilities([declaration('Subscriber.A ', 1, [actionA])]),
      {},
    );
    const loaded = registry.get('Subscriber.A ', 1);

    expect(loaded).toBe(registry.subscriptions[0]);
    expect(registry.get('subscriber.a ', 1)).toBeUndefined();
    expect(registry.get('Subscriber.A', 1)).toBeUndefined();
    expect(registry.get('Subscriber.A ', 2)).toBeUndefined();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.subscriptions)).toBe(true);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.actions)).toBe(true);
  });
});
