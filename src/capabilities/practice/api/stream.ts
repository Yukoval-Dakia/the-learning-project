// M2 (YUK-316) — 练习流 API（handoff 契约：GET /api/practice/stream?date=today）。
// 当日为空时 lazy compose（首次打开练习面）；recompose 是手动重排入口
//（M4 夜链落地后 composer_nightly 接管日常生成，这两个入口保留为兜底/调试面）。

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

// YUK-558 (spec Q6-A / M2)：prod sampler 种子化——选题决策可重构（同 seed + 同输入 ⇒ 同选集）。
// seed 走 log-only（不进 DB 列，Q-d deferred）。两抽样事件（compose / rerank）各派生独立 seed。
import { buildSeededSelectionRng } from '../server/selection-seed';
import { estimateStreamItemMinutes } from '../server/stream-budget';
import {
  advanceStreamItem,
  getStream,
  recomposeStream,
  streamLocalDate,
} from '../server/stream-store';
import {
  PracticeStreamCalendarDateSchema,
  RecomposePracticeStreamBodySchema,
  UpdatePracticeStreamItemBodySchema,
} from './stream-contracts';

/**
 * 'today' / 缺省 → 用户本地日（Asia/Shanghai，FINDING 4）。读路径与夜间预产 job 共用
 * `streamLocalDate()`，故两者对「今天是哪天」恒一致（夜间预产的 date 键 = 用户首读
 * lazy-compose 的 date 键 → 幂等双重检查命中，不 double-compose）。
 */
function resolveDate(raw: string | null): string {
  if (raw && raw !== 'today') {
    const parsed = PracticeStreamCalendarDateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', `invalid date: ${raw}`, 400);
    }
    return parsed.data;
  }
  return streamLocalDate();
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const date = resolveDate(url.searchParams.get('date'));
    // 只有「今天」才 lazy compose——翻看历史日期不应凭空生出新流。
    const isToday = date === streamLocalDate();
    // YUK-558：compose 事件种子化（仅 isToday 才可能触发 compose；历史日期不 compose，不派生 seed）。
    const view = await getStream(db, date, {
      composeIfEmpty: isToday,
      composeDeps: isToday ? { rng: buildSeededSelectionRng(date, 'compose', date) } : undefined,
    });
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => ({}));
    const parsed = RecomposePracticeStreamBodySchema.safeParse(raw);
    if (!parsed.success) throw new ApiError('validation_error', 'invalid body', 400);
    const date = resolveDate(parsed.data.date ?? null);
    // YUK-558（C9+C10③）：recompose 事件种子化（独立 eventKind，与 lazy compose / nightly 各派生
    // 独立 seed）。triggerId=newId() **nonce**——recompose 是手动重排入口，**无自然稳定触发 id**
    // （同日可反复按），故不用 date 当 triggerId：那会让同日多次 recompose 共享同一 seed（每次抽同一
    // 签，违背「每按新抽」语义）。nonce 保留「每次 recompose 重新抽」语义；replay 凭日志记录的 seed
    // （非可从 (date, eventKind) 重导——这是 recompose 与 compose/compose-nightly 的语义分野：后两者
    // 用 date 当 triggerId 是因为**物化幂等**是真 feature（同日重跑 = 同选集，双重检查命中不 double-compose））。
    const added = await recomposeStream(db, date, {
      composeDeps: { rng: buildSeededSelectionRng(date, 'recompose', newId()) },
    });
    const view = await getStream(db, date, { enforceBudget: true });
    return Response.json({ added, ...view });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = UpdatePracticeStreamItemBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        'status must be one of pending|in_progress|done|skipped',
        400,
      );
    }
    // YUK-558：rerank 事件种子化（triggerId=被推进的 streamItemId——独立于 compose 事件的 seed）。
    // localDate=streamLocalDate() 只做 seed **命名空间熵**（区隔不同日的 rerank seed 空间）；rerank
    // 实跑用的日期是 updated.date（被推进 slot 的归属日），非本地日——两者可在跨午夜作答时不同，但
    // seed 只需稳定可记录，命名空间熵用本地日无害。replay key = 日志记录的 seed + triggerId
    // （itemId 全局唯一；done 是终态、无重入 ⇒ 同一 itemId 的 rerank 抽签事件至多一次，seed 稳定可回放）。
    const row = await advanceStreamItem(db, params.id, parsed.data.status, {
      rng: buildSeededSelectionRng(streamLocalDate(), 'rerank', params.id),
    });
    if (!row) throw new ApiError('not_found', `stream item ${params.id} not found`, 404);
    return Response.json({
      item: { ...row, estimated_minutes: estimateStreamItemMinutes(row.item_kind) },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
