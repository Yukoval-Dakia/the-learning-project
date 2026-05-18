// 浏览器侧 AI 调用入口。
// 普通 single-shot task 走 /api/ai/<task>；tool-calling task 必须走各自领域
// route，由服务端注入 MCP server / allowed tools。浏览器代码绝不直接拿 API key。

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

export interface RunTaskOptions {
  signal?: AbortSignal;
  /** Called with text chunks as they stream in. Phase 1 most callers ignore this. */
  onChunk?: (chunk: string) => void;
}

/**
 * Run a single-shot AI task through the generic route. Returns:
 * - For single-shot tasks (`needsToolCall: false` in registry): parsed JSON.
 *
 * Tool-calling tasks are intentionally rejected by the generic route; call their
 * domain route instead (for example `/api/knowledge/review`).
 */
export async function runTask<TInput, TOutput = unknown>(
  taskKind: string,
  input: TInput,
  options: RunTaskOptions = {},
): Promise<TOutput | string> {
  const res = await fetch(`/api/ai/${taskKind}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ input }),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Task ${taskKind} failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as TOutput;
  }

  // Stream mode: read chunks, optionally pipe to onChunk callback, then return full text
  const reader = res.body?.getReader();
  if (!reader) return '' as unknown as TOutput;
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    options.onChunk?.(chunk);
  }
  // Flush any bytes buffered for an incomplete multibyte sequence at the boundary.
  const tail = decoder.decode();
  if (tail) {
    full += tail;
    options.onChunk?.(tail);
  }
  return full;
}
