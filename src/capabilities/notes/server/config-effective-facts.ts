// Consumer-effective facts for config keys owned by Notes.
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { readHubSyncMode } from './hub-sync-reconciliation';

export function notesConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    HUB_SYNC_MODE: { value: readHubSyncMode() },
  };
}
