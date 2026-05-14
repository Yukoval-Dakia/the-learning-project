// In-memory pub/sub for SSE channels keyed by (business_table, business_id).
//
// Subscribers connect via SSE endpoint (Step 4 / Step 10 routes); the listen
// loop（listen_loop.ts）解析 NOTIFY 后调 broadcast 把事件 fan-out 给所有匹配订阅。
// 这是单进程 in-memory 实现 —— Sub 0c 范围内 worker 与 app 是独立进程，
// app 进程才需要这个 router；worker 不订阅自己发出的 NOTIFY。

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

export function unsubscribe(
  businessTable: string,
  businessId: string,
  handler: SSEHandler,
): void {
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
      // 一个 handler 抛错不能影响其它订阅者
      console.error('[sse_router] handler error', err);
    }
  }
}

/**
 * Test-only. Clears all subscribers; do not call in production code.
 */
export function _clearSubscribersForTests(): void {
  subscribers.clear();
}
