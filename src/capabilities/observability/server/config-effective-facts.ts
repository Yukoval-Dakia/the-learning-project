// YUK-1007 — observability 自有配置键的 consumer-effective 事实（真实 reader
// 调用）。与其它 capability 的 config-effective-facts 同构，经本 capability 的
// public 入口透出给组合根 facts seam（本文件 import backup-import → db/client，
// 只在 boot 后的 facts 装配 / DB 测试环境加载，绝不进 unit 读面测试链）。
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
