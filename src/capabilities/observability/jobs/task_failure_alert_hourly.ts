// Records new task-failure alert episodes. Reads ai_task_runs only, no AI call;
// event ids are deterministic, so a retried or overlapping tick writes nothing new.

import type { Db } from '@/db/client';
import { recordTaskFailureAlerts } from '../server/task-failure-alerts';

export function buildTaskFailureAlertHourlyHandler(db: Db) {
  return async (): Promise<void> => {
    const { active, recorded } = await recordTaskFailureAlerts(db);
    if (recorded.length > 0) {
      console.warn('[task_failure_alert_hourly] new alerts: %s', recorded.join(', '));
    }
    console.log('[task_failure_alert_hourly] active=%d new=%d', active, recorded.length);
  };
}
