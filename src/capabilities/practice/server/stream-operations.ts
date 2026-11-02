// Typed practice-stream operations, independent of HTTP.
//
// api/stream.ts is only the Request/Response adapter; live consumers reuse this module
// through practice/public.ts. api/stream-contracts remains the validation authority, and
// error semantics stay identical.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { checkRateLimit } from '@/kernel/request-rate-limit';
import {
  PracticeStreamCalendarDateSchema,
  PracticeStreamQuerySchema,
  RecomposePracticeStreamBodySchema,
  UpdatePracticeStreamItemBodySchema,
} from '../api/stream-contracts';
//prod sampler 种子化——选题决策可重构（同 seed + 同输入 ⇒ 同选集）。
// seed 走 log-only（不进 DB 列，Q-d deferred）。两抽样事件（compose / rerank）各派生独立 seed。
import { buildSeededSelectionRng } from './selection-seed';
import {
  type StreamItemRow,
  type StreamView,
  advanceStreamItem,
  getStream,
  getStreamViewItem,
  recomposeStream,
  streamLocalDate,
} from './stream-store';

/** GET 流视图的 item 投影类型（stream-store `StreamView['items']` 元素）。 */
export type PracticeStreamViewItem = StreamView['items'][number];

/** PATCH 响应：持久行上覆写视图投影——`{ ...row, ...viewItem }` 的精确类型。 */
export interface PracticeStreamUpdatedItem {
  item: Omit<StreamItemRow, keyof PracticeStreamViewItem> & PracticeStreamViewItem;
}

/** POST recompose 响应：`{ added, ...view }`。 */
export interface PracticeStreamRecomposeResult extends StreamView {
  added: number;
}

/**
 * 'today' / 缺省 → 用户本地日（Asia/Shanghai，）。读路径与夜间预产 job 共用
 * `streamLocalDate`，故两者对「今天是哪天」恒一致（夜间预产的 date 键 = 用户首读
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

/**
 * 读当日流（GET /api/practice/stream）。`rawQuery` 为未校验 query record
 * （HTTP 侧即 `Object.fromEntries(url.searchParams)`）。
 */
export async function getPracticeStream(database: Db, rawQuery: unknown): Promise<StreamView> {
  const parsedQuery = PracticeStreamQuerySchema.safeParse(rawQuery);
  if (!parsedQuery.success) {
    throw new ApiError('validation_error', 'invalid query parameters', 400);
  }
  const date = resolveDate(parsedQuery.data.date ?? null);
  const knowledgeId = parsedQuery.data.kc;
  // 只有「今天」才 lazy compose——翻看历史日期不应凭空生出新流。
  const isToday = date === streamLocalDate();
  const composeInvocationId = newId();
  // compose 事件种子化（仅 isToday 才可能触发 compose；历史日期不 compose，不派生 seed）。
  return getStream(database, date, {
    composeIfEmpty: isToday,
    knowledgeId,
    materializeScoped: isToday,
    composeDeps: isToday
      ? {
          rng: buildSeededSelectionRng(date, 'compose', date),
          providerInvocation: {
            db: database,
            caller: 'api',
            deadlineAt: new Date(Date.now() + 65_000),
            operationAnchor: composeInvocationId,
          },
        }
      : undefined,
  });
}

/**
 * 手动重排当日流（POST /api/practice/stream/recompose）。`rawBody` 由调用方按
 * 「JSON parse 失败 ⇒ `{}`」语义读入（与 PATCH 的 `null` fallback 故意不同）。
 */
export async function recomposePracticeStream(
  database: Db,
  rawBody: unknown,
): Promise<PracticeStreamRecomposeResult> {
  const parsed = RecomposePracticeStreamBodySchema.safeParse(rawBody);
  if (!parsed.success) throw new ApiError('validation_error', 'invalid body', 400);
  const date = resolveDate(parsed.data.date ?? null);
  // manual recomposition can reach SelectionOrchestratorTask. Count
  // the request immediately before that work so a click/retry loop cannot turn
  // into an unbounded sequence of paid model calls.
  checkRateLimit();
  // （C9+C10③）：recompose 事件种子化（独立 eventKind，与 lazy compose / nightly 各派生
  // 独立 seed）。triggerId=newId **nonce**——recompose 是手动重排入口，**无自然稳定触发 id**
  // （同日可反复按），故不用 date 当 triggerId：那会让同日多次 recompose 共享同一 seed（每次抽同一
  // 签，违背「每按新抽」语义）。nonce 保留「每次 recompose 重新抽」语义；replay 凭日志记录的 seed
  // （非可从 (date, eventKind) 重导——这是 recompose 与 compose/compose-nightly 的语义分野：后两者
  // 用 date 当 triggerId 是因为**物化幂等**是真 feature（同日重跑 = 同选集，双重检查命中不 double-compose））。
  const recomposeInvocationId = newId();
  const added = await recomposeStream(database, date, {
    composeDeps: {
      rng: buildSeededSelectionRng(date, 'recompose', recomposeInvocationId),
      providerInvocation: {
        db: database,
        caller: 'api',
        deadlineAt: new Date(Date.now() + 65_000),
        operationAnchor: recomposeInvocationId,
      },
    },
  });
  const view = await getStream(database, date, { enforceBudget: true });
  return { added, ...view };
}

/**
 * 推进单个 stream item 状态（PATCH /api/practice/stream/items/[id]），回投影视图 item。
 */
export async function updatePracticeStreamItem(
  database: Db,
  itemId: string,
  rawBody: unknown,
): Promise<PracticeStreamUpdatedItem> {
  const parsed = UpdatePracticeStreamItemBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      'status must be one of pending|in_progress|done|skipped',
      400,
    );
  }
  // rerank 事件种子化（triggerId=被推进的 streamItemId——独立于 compose 事件的 seed）。
  // localDate=streamLocalDate 只做 seed **命名空间熵**（区隔不同日的 rerank seed 空间）；rerank
  // 实跑用的日期是 updated.date（被推进 slot 的归属日），非本地日——两者可在跨午夜作答时不同，但
  // seed 只需稳定可记录，命名空间熵用本地日无害。replay key = 日志记录的 seed + triggerId
  // （itemId 全局唯一；done 是终态、无重入 ⇒ 同一 itemId 的 rerank 抽签事件至多一次，seed 稳定可回放）。
  const row = await advanceStreamItem(database, itemId, parsed.data.status, {
    rng: buildSeededSelectionRng(streamLocalDate(), 'rerank', itemId),
  });
  if (!row) throw new ApiError('not_found', `stream item ${itemId} not found`, 404);
  const viewItem = await getStreamViewItem(database, row);
  return { item: { ...row, ...viewItem } };
}
