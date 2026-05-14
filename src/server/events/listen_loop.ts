import postgres from 'postgres';
import { broadcast, type SSEPayload } from './sse_router';

// 专用 postgres LISTEN 连接 —— max:1 避免 pg-boss / drizzle 主池被占。
// 这个连接整个 app process lifetime 维持，断了得重连（v0 不做自动重连，靠重启
// 进程；生产监控由 docker-compose restart 兜底）。

let listenClient: ReturnType<typeof postgres> | null = null;

export async function startListenLoop(): Promise<void> {
  if (listenClient) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for listen loop');
  }
  listenClient = postgres(url, { max: 1 });
  await listenClient.listen('job_status', (payloadStr) => {
    try {
      const data = JSON.parse(payloadStr) as SSEPayload;
      if (
        typeof data.event_id === 'number' &&
        typeof data.business_table === 'string' &&
        typeof data.business_id === 'string'
      ) {
        broadcast(data);
      } else {
        console.warn('[listen_loop] NOTIFY payload missing required fields', data);
      }
    } catch (err) {
      console.error('[listen_loop] failed to parse NOTIFY payload', err);
    }
  });
}

export async function stopListenLoop(): Promise<void> {
  if (listenClient) {
    await listenClient.end({ timeout: 1 });
    listenClient = null;
  }
}
