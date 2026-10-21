// 作答卷导出的 route handler。薄层：HTTP 整形 + zod 解析 + 域状态 → ApiError 映射；
// 业务全在 practice/server/worksheet/（发放编排 = 既有 issueAssessment；区域图
// 校验/存档在 region-map-validate + export-store）。

import type { ZodType } from 'zod';
import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { WORKSHEET_RENDER_QUEUE } from '@/server/boss/queue-names';
import {
  NoGradeableQuestionsError,
  RegionMapArchiveConflictError,
  WorksheetIdempotencyRaceError,
  archiveWorksheetRegionMap,
  createWorksheetExport,
  readWorksheetExport,
  readWorksheetPage,
} from '../server/worksheet/export-store';
import { readWorksheetExportPdf } from '../server/worksheet/pdf-store';
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

// ---------- POST /api/worksheet-exports ----------

export async function createWorksheetExportRoute(req: Request): Promise<Response> {
  let idempotencyKey = '';
  try {
    const body = await parseBody(req, WorksheetExportCreateBodySchema);
    idempotencyKey = body.idempotency_key;
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
        // 服务端渲染 job：导出提交后入队（重放也再入队——job 幂等，
        // 同图同 digest 走 existing，这也是失败渲染的显式重试入口）。
        // 入队失败不让已提交的导出 500：同一 idempotency_key 重 POST 会重放并再入队。
        try {
          const boss = await getStartedBoss();
          await boss.send(WORKSHEET_RENDER_QUEUE, { export_token: out.state.export_token });
        } catch (enqueueError) {
          console.warn(
            `[worksheet-exports] render enqueue failed for '${out.state.export_token}'`,
            enqueueError,
          );
        }
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
    // 重试后仍同 key 抢插（双重并发窗口）——如实 409 可重试，绝不 500。
    if (err instanceof WorksheetIdempotencyRaceError) {
      return errorResponse(
        new ApiError(
          'idempotency_race',
          `concurrent create with idempotency_key '${idempotencyKey || '?'}' — safe to retry`,
          409,
        ),
      );
    }
    return errorResponse(err);
  }
}

// ---------- GET /api/worksheet-exports/[token] ----------

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

// ---------- POST /api/worksheet-exports/[token]/region-map ----------

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
    // write-once 冲突在域层抛出（事务回滚，无孤儿页行）—— 必须在这里
    // 映成 409 响应 RETURN 出去；再 throw 会逸出或 500。
    if (err instanceof RegionMapArchiveConflictError) {
      return errorResponse(new ApiError('archive_conflict', String(err.message), 409));
    }
    return errorResponse(err);
  }
}

// ---------- GET /api/worksheet-exports/[token]/pdf ----------

export async function getWorksheetExportPdfRoute(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { token } = parseParams(params, WorksheetTokenParamsSchema);
    const out = await readWorksheetExportPdf(db, token);
    switch (out.status) {
      case 'ok':
        return new Response(new Uint8Array(out.pdf), {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(out.pdf.length),
            'Content-Disposition': `attachment; filename="worksheet-${out.short_code}.pdf"`,
            // 内容寻址产物不可变：digest 即 key，变了的渲染是另一个对象。
            ETag: `"${out.pdf_digest}"`,
            'Cache-Control': 'private, max-age=3600, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      case 'not_found':
        throw new ApiError('not_found', `worksheet export '${token}' not found`, 404);
      case 'not_rendered':
        throw new ApiError(
          'pdf_not_rendered',
          `worksheet export '${token}' has no archived PDF yet`,
          404,
        );
      case 'blob_missing':
        throw new ApiError(
          'pdf_blob_missing',
          `archived PDF bytes missing from blob storage (key '${out.blob_key}')`,
          404,
        );
      default:
        throw new ApiError('internal_error', 'unexpected worksheet pdf status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- GET /api/worksheet-exports/[token]/pages/[page] ----------

export async function getWorksheetPageRoute(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const parsed = parseParams(params, WorksheetPageParamsSchema);
    // 页号必须是严格的十进制正整数（拒绝 "1.5"/"01"/"1e2"/"+1"）——
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
