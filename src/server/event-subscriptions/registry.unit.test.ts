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

async function hashOf(
  subscriptions: EventSubscriptionDecl[],
  id: string,
  version: number,
): Promise<string> {
  const eventActions = [...new Set(subscriptions.flatMap(({ actions }) => actions))];
  const registry = await loadEventSubscriptionRegistry(
    capabilities(subscriptions, eventActions),
    {},
  );
  const subscription = registry.get(id, version);
  if (!subscription) throw new Error(`subscription ${id}@v${version} not loaded`);
  return subscription.declarationHash;
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

  it('produces the same per-subscription hash and ordering across declaration and action ordering', async () => {
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

    expect(first.get('subscriber.a', 1)?.declarationHash).toBe(
      second.get('subscriber.a', 1)?.declarationHash,
    );
    expect(first.get('subscriber.z', 2)?.declarationHash).toBe(
      second.get('subscriber.z', 2)?.declarationHash,
    );
    expect(first.subscriptions.map(({ id, version }) => [id, version])).toEqual([
      ['subscriber.a', 1],
      ['subscriber.z', 2],
    ]);
    expect(first.subscriptions.map(({ id, version }) => [id, version])).toEqual(
      second.subscriptions.map(({ id, version }) => [id, version]),
    );
  });

  it('changes the hash for subscriber identity, version, or an exact action change', async () => {
    const original = await hashOf([declaration('subscriber.a', 1, [actionA])], 'subscriber.a', 1);

    expect(await hashOf([declaration('subscriber.b', 1, [actionA])], 'subscriber.b', 1)).not.toBe(
      original,
    );
    expect(await hashOf([declaration('subscriber.a', 2, [actionA])], 'subscriber.a', 2)).not.toBe(
      original,
    );
    expect(
      await hashOf([declaration('subscriber.a', 1, [actionA.toUpperCase()])], 'subscriber.a', 1),
    ).not.toBe(original);
    expect(
      await hashOf([declaration('subscriber.a', 1, [`${actionA} `])], 'subscriber.a', 1),
    ).not.toBe(original);
  });

  it('scopes each subscription hash to its own declaration, independent of siblings (Tb7Aj)', async () => {
    // The regression the per-subscription hash guarantees: adding/removing/editing an UNRELATED
    // subscription must NOT change another subscriber's hash — otherwise every checkpoint claim
    // would brick on a hash mismatch whenever any subscription in the manifest set changed.
    const alone = await hashOf([declaration('subscriber.a', 1, [actionA])], 'subscriber.a', 1);
    const withSibling = await hashOf(
      [declaration('subscriber.a', 1, [actionA]), declaration('subscriber.b', 3, [actionB])],
      'subscriber.a',
      1,
    );
    const withDifferentSibling = await hashOf(
      [declaration('subscriber.a', 1, [actionA]), declaration('subscriber.c', 9, [actionA])],
      'subscriber.a',
      1,
    );

    expect(withSibling).toBe(alone);
    expect(withDifferentSibling).toBe(alone);
  });

  it('wraps a loader rejection with the subscription identity and does not invoke factories', async () => {
    const rejection = new Error('module failed to load');
    const factory = vi.fn();

    // YUK-751 review: a loader throw is wrapped with the subscription identity (original as `cause`)
    // so a dynamic-import failure names the culprit. Loaders run in parallel now, but the FACTORY
    // invocation (factory(dependency)) is still gated on all loads succeeding.
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
    ).rejects.toMatchObject({
      message: expect.stringMatching(/subscriber\.a@v1.*loader failed/),
      cause: rejection,
    });
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

  it('retains the validated declaration snapshot when a loader mutates a later declaration', async () => {
    const later = declaration('subscriber.b', 2, [actionB]);
    const first = declaration('subscriber.a', 1, [actionA], async () => {
      later.id = 'subscriber.a';
      later.version = 0;
      later.actions = ['', actionA];
      return () => async () => ({ status: 'succeeded' });
    });
    const expectedHashA = await hashOf(
      [declaration('subscriber.a', 1, [actionA])],
      'subscriber.a',
      1,
    );
    const expectedHashB = await hashOf(
      [declaration('subscriber.b', 2, [actionB])],
      'subscriber.b',
      2,
    );

    const registry = await loadEventSubscriptionRegistry(capabilities([first, later]), {});

    expect(registry.get('subscriber.a', 1)?.declarationHash).toBe(expectedHashA);
    expect(registry.get('subscriber.b', 2)?.declarationHash).toBe(expectedHashB);
    expect(
      registry.subscriptions.map(({ id, version, actions }) => ({ id, version, actions })),
    ).toEqual([
      { id: 'subscriber.a', version: 1, actions: [actionA] },
      { id: 'subscriber.b', version: 2, actions: [actionB] },
    ]);
    expect(registry.get('subscriber.a', 1)).toBe(registry.subscriptions[0]);
    expect(registry.get('subscriber.b', 2)).toBe(registry.subscriptions[1]);
    expect(registry.get('subscriber.a', 0)).toBeUndefined();
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
