import type {
  EventSubscriptionDecl,
  EventSubscriptionHandler,
  EventSubscriptionHandlerFactory,
} from '@/kernel/manifest';

export type EventSubscriptionFactoryDependency = Parameters<EventSubscriptionHandlerFactory>[0];

export type LoadedEventSubscriptionIdentity = Readonly<
  Pick<EventSubscriptionDecl, 'id' | 'version'>
>;

export interface LoadedEventSubscription extends LoadedEventSubscriptionIdentity {
  readonly actions: readonly string[];
  // Hash of THIS subscription's own declaration only (id, version, actions). The per-subscriber
  // checkpoint is fenced on this value, so adding/removing/editing an UNRELATED subscription never
  // invalidates another subscriber's checkpoint (YUK-751 review Tb7Aj).
  readonly declarationHash: string;
  readonly handler: EventSubscriptionHandler;
}

export interface LoadedEventSubscriptionRegistry {
  readonly contractVersion: string;
  readonly subscriptions: readonly LoadedEventSubscription[];
  get(id: string, version: number): LoadedEventSubscription | undefined;
}
