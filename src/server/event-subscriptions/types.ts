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
  readonly handler: EventSubscriptionHandler;
}

export interface LoadedEventSubscriptionRegistry {
  readonly contractVersion: string;
  readonly declarationHash: string;
  readonly subscriptions: readonly LoadedEventSubscription[];
  get(id: string, version: number): LoadedEventSubscription | undefined;
}
