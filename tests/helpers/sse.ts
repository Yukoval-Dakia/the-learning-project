/**
 * Read SSE events from a Response.body until `predicate` returns true or
 * timeout. Designed for tests that need to assert against a small number of
 * events (≤ 10s timeout).
 *
 * SSE wire format: each event = `id: <n>\ndata: <json>\n\n`。本 helper 只解析
 * `data:` 行，把 JSON 抽到 events 数组。
 */
export async function readSSEUntil(
  response: Response,
  predicate: (events: unknown[]) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const events: unknown[] = [];
  const timeoutMs = options.timeoutMs ?? 5000;

  if (!response.body) {
    throw new Error('readSSEUntil: response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const timer: NodeJS.Timeout = setTimeout(() => {
    void reader.cancel('readSSEUntil timeout');
  }, timeoutMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE blocks are separated by \n\n
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const block of parts) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const json = JSON.parse(dataLine.slice(5).trim());
          events.push(json);
        } catch {
          // ignore malformed
        }
      }

      if (predicate(events)) {
        await reader.cancel('readSSEUntil predicate matched');
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return events;
}
