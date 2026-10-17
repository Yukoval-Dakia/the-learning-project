// YUK-1523（P5）— 作答卷导出的 route handler。薄层：HTTP 整形 + zod 解析 +
// 域状态 → ApiError 映射；业务全在 capabilities/practice/server/worksheet/
// （发放编排 = 既有 issueAssessment；区域图校验/存档在 region-map-validate +
// export-store）。

import type { ZodType } from 'zod';
import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import {
  NoGradeableQuestionsError,
  WorksheetIdempotencyRaceError,
  archiveWorksheetRegionMap,
  createWorksheetExport,
  readWorksheetExport,
  readWorksheetPage,
} from '../server/worksheet/export-store';
import {
  WorksheetExportCreateBodySchema,
  WorksheetPageParamsSchema,
  WorksheetRegionMapArchiveBody,
  WorksheetTokenParamsSchema,
} from './worksheet-contracts';

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  return parsed.data;
}

function parseParams<T>(params: Record<string, string>, schema: ZodType<T>): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  return parsed.data;
}

// ---------- POST /api/worksheet-exports — 创建导出（= 逐题发放） ----------

export async function createWorksheetExportRoute(req: Request): Promise<Response> {
  try {
    const body = await parseBody(req, WorksheetExportCreateBodySchema);
    let out: Awaited<ReturnType<typeof createWorksheetExport>>;
    try {
      out = await createWorksheetExport(db, body);
    } catch (error) {
      if (error instanceof WorksheetIdempotencyRaceError) {
        // 并发同 key 抢插：占位行已回滚，重读一次收敛到重放/冲突。
        out = await createWorksheetExport(db, body);
      } else {
        throw error;
      }
    }
    switch (out.status) {
      case 'created':
      case 'replayed':
        return resourceResponse(out.state, {
          outcome: out.status === 'created' ? 'created' : 'existing',
          location: `/api/worksheet-exports/${encodeURIComponent(out.state.export_token)}`,
        });
      case 'idempotency_conflict':
        throw new ApiError(
          'idempotency_conflict',
          `idempotency_key '${body.idempotency_key}' already used by a different worksheet export request`,
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected worksheet export status', 500);
    }
  } catch (err) {
    if (err instanceof NoGradeableQuestionsError) {
      // 全部题被服务门拒绝：不建导出，typed 拒绝清单随响应返回。
      return Response.json(
        {
          error: 'no_gradeable_questions',
          message: 'every requested question was refused by the serving gate; nothing was exported',
          details: { refused: err.refused },
        },
        { status: 422 },
      );
    }
    return errorResponse(err);
  }
}

// ---------- GET /api/worksheet-exports/[token] — 状态读面（渲染器恢复） ----------

export async function getWorksheetExportRoute(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { token } = parseParams(params, WorksheetTokenParamsSchema);
    const state = await readWorksheetExport(db, token);
    if (state == null) {
      throw new ApiError('not_found', `worksheet export '${token}' not found`, 404);
    }
    return Response.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/worksheet-exports/[token]/region-map — 区域图存档 ----------

export async function archiveWorksheetRegionMapRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { token } = parseParams(params, WorksheetTokenParamsSchema);
    const body = await parseBody(req, WorksheetRegionMapArchiveBody);
    const out = await archiveWorksheetRegionMap(db, token, body);
    switch (out.status) {
      case 'archived':
      case 'existing':
        return resourceResponse(out.archive, {
          outcome: out.status === 'archived' ? 'created' : 'existing',
          location: `/api/worksheet-exports/${encodeURIComponent(token)}`,
        });
      case 'not_found':
        throw new ApiError('not_found', `worksheet export '${token}' not found`, 404);
      case 'invalid_map':
        throw new ApiError(
          'invalid_region_map',
          `region map does not match the frozen issuance: ${out.issues
            .map((issue) => `${issue.code}(${issue.detail})`)
            .join('; ')}`,
          422,
          undefined,
          { issues: out.issues },
        );
      default:
        throw new ApiError('internal_error', 'unexpected region map archive status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- GET /api/worksheet-exports/[token]/pages/[page] — P6 读面 ----------

export async function getWorksheetPageRoute(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const parsed = parseParams(params, WorksheetPageParamsSchema);
    // R1 P2-3：页号必须是严格的十进制正整数（拒绝 "1.5"/"01"/"1e2"/"+1"）——
    // parseInt 会截断小数点前的字符，不能作形状门。
    if (!/^[1-9]\d*$/.test(parsed.page)) {
      throw new ApiError(
        'page_invalid',
        `page '${parsed.page}' is not a positive integer page number`,
        404,
      );
    }
    const page = Number.parseInt(parsed.page, 10);
    const out = await readWorksheetPage(db, parsed.token, page);
    switch (out.status) {
      case 'ok':
        return Response.json(out.page);
      case 'not_found':
        throw new ApiError('not_found', `worksheet export '${parsed.token}' not found`, 404);
      case 'not_archived':
        throw new ApiError(
          'region_map_not_archived',
          `worksheet export '${parsed.token}' has no archived region map yet`,
          404,
        );
      case 'page_out_of_range':
        throw new ApiError(
          'page_out_of_range',
          `page ${page} outside 1..${out.page_count}`,
          404,
          undefined,
          { page_count: out.page_count },
        );
      default:
        throw new ApiError('internal_error', 'unexpected worksheet page status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
