// YUK-1007 — notes 拥有键的 consumer-effective 事实（真实 reader 调用）。
// 经 notes/public.ts 透出给组合根 facts seam。
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { readHubSyncMode } from './hub-sync-reconciliation';

export function notesConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    HUB_SYNC_MODE: { value: readHubSyncMode() },
  };
}
