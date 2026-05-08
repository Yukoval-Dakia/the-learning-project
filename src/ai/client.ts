// 浏览器侧 AI 调用入口。
// 所有调用都走 /api/ai/<task>，Cloudflare Workers 持有 ANTHROPIC_API_KEY。
// 浏览器代码绝不直接拿 API key。

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

export async function runTask<TInput, TOutput = unknown>(
  taskKind: string,
  input: TInput,
  signal?: AbortSignal,
): Promise<TOutput> {
  const res = await fetch(`/api/ai/${taskKind}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ input }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Task ${taskKind} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as TOutput;
}
