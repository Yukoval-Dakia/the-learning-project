import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）；handlers 自身实现在 Step 4-9 + 13 完成：
 *   - Step 4: echo (golden E2E)
 *   - Step 5: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9: tencent_ocr_extract (生产 OCR async job)
 *
 * 现阶段 stub —— 不注册任何 handler，仅作 import 与签名占位。
 */
export async function registerHandlers(_boss: PgBoss, _db: Db): Promise<void> {
  // Step 4+ 在此追加 boss.work('queue', handler) 与 boss.schedule(...) 调用
}
