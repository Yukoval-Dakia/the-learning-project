import type { Db } from '@/db/client';
import { enqueueWorksheetRender } from '../queue-runtime';
import {
  type CreateWorksheetExportRequest,
  type CreateWorksheetExportResult,
  WorksheetIdempotencyRaceError,
  createWorksheetExport,
} from './export-store';

export async function submitWorksheetExport(
  db: Db,
  request: CreateWorksheetExportRequest,
): Promise<CreateWorksheetExportResult> {
  let out: CreateWorksheetExportResult;
  try {
    out = await createWorksheetExport(db, request);
  } catch (error) {
    if (error instanceof WorksheetIdempotencyRaceError) {
      // 并发同 key 抢插：占位行已回滚，重读一次收敛到重放/冲突。
      out = await createWorksheetExport(db, request);
    } else {
      throw error;
    }
  }
  if (out.status === 'created' || out.status === 'replayed') {
    // 服务端渲染 job：导出提交后入队（重放也再入队——job 幂等，
    // 同图同 digest 走 existing，这也是失败渲染的显式重试入口）。
    // 入队失败不让已提交的导出 500：同一 idempotency_key 重 POST 会重放并再入队。
    try {
      await enqueueWorksheetRender(out.state.export_token);
    } catch (enqueueError) {
      console.warn(
        `[worksheet-exports] render enqueue failed for '${out.state.export_token}'`,
        enqueueError,
      );
    }
  }
  return out;
}
