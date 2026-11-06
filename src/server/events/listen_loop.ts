import postgres from 'postgres';
import {
  type SSELivePayload,
  type SSEPayload,
  broadcast,
  broadcastLive,
} from '@/kernel/job-event-stream';
import { JOB_LIVE_NOTIFY_CHANNEL } from '@/kernel/job-events';

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
  // Both LISTEN callbacks are fully guarded: a malformed live payload or a
  // throwing live subscriber is logged inside broadcastLive and cannot abort
  // the durable job_status callback on the same connection.
  // Live frames carry stream content inside the NOTIFY payload — never log the
  // raw payload here; identifiers are validated, content is only forwarded.
  await listenClient.listen(JOB_LIVE_NOTIFY_CHANNEL, (payloadStr) => {
    try {
      const data = JSON.parse(payloadStr) as SSELivePayload;
      if (
        typeof data.business_table === 'string' &&
        typeof data.business_id === 'string' &&
        typeof data.event_type === 'string' &&
        data.payload !== null &&
        typeof data.payload === 'object' &&
        !Array.isArray(data.payload)
      ) {
        broadcastLive(data);
      } else {
        console.warn('[listen_loop] live NOTIFY payload missing required fields');
      }
    } catch {
      console.error('[listen_loop] failed to parse live NOTIFY payload');
    }
  });
}

export async function stopListenLoop(): Promise<void> {
  if (listenClient) {
    await listenClient.end({ timeout: 1 });
    listenClient = null;
  }
}
