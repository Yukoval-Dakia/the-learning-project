import postgres from 'postgres';
import { type SSEPayload, broadcast } from '@/kernel/job-event-stream';

// One dedicated LISTEN connection for the process lifetime. max:1 keeps it off
// the pg-boss and drizzle pools. There is no reconnect; a dropped connection
// needs a process restart.

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
