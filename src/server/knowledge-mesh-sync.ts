import { enqueueHubAutoSync } from '@/server/boss/hub-auto-sync-enqueue';

export async function notifyKnowledgeMeshMutation(): Promise<void> {
  await enqueueHubAutoSync();
}
