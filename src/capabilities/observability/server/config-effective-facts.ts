// Effective config values from the real reader. This imports the backup route, so it
// loads only in post-boot fact assembly or DB tests, never the unit read path.
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { maxBackupUploadBytes } from '../api/backup-import';

export function observabilityConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    BACKUP_IMPORT_MAX_BYTES: {
      value: maxBackupUploadBytes(),
      note: 'consumer 正规化：非数字/低于 1MB 地板 → 回退 1GB 默认（backup-import.ts OOM tripwire）',
    },
  };
}
