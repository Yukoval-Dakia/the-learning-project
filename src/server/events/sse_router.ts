// In-memory pub/sub for SSE channels keyed by (business_table, business_id).
// The listen loop parses NOTIFY and fans out here. Only the app process
// subscribes; the worker does not consume its own notifications.

export type SSEPayload = {
  event_id: number;
  business_table: string;
  business_id: string;
};

export type SSEHandler = (payload: SSEPayload) => void;

const subscribers: Map<string, Set<SSEHandler>> = new Map();

function channelKey(businessTable: string, businessId: string): string {
  return `${businessTable}:${businessId}`;
}

export function subscribe(
  businessTable: string,
  businessId: string,
  handler: SSEHandler,
): () => void {
  const key = channelKey(businessTable, businessId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(handler);
  return () => unsubscribe(businessTable, businessId, handler);
}

export function unsubscribe(businessTable: string, businessId: string, handler: SSEHandler): void {
  const key = channelKey(businessTable, businessId);
  const set = subscribers.get(key);
  if (!set) return;
  set.delete(handler);
  if (set.size === 0) subscribers.delete(key);
}

export function broadcast(payload: SSEPayload): void {
  const key = channelKey(payload.business_table, payload.business_id);
  const set = subscribers.get(key);
  if (!set) return;
  for (const h of set) {
    try {
      h(payload);
    } catch (err) {
      // One failing subscriber must not skip the rest.
      console.error('[sse_router] handler error', err);
    }
  }
}
