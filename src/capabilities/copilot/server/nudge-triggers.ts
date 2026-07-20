// YUK-577 — copilot 主动开口触发线：确定性判定器（零 LLM）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.1 / §3.2 / §3.3.
//
// evaluateNudgeTrigger 是**纯 db-in / decision-out**——只读，不写。写 nudge event + 23505
// 幂等收口由 handler（copilot_nudge_evaluate.ts）做（读/写分离，测试面干净）。触发判定全程
// 确定性（事件模式匹配 + 计数查询），绝不调 LLM——「我注意到 X」的语义观察留给点击后的
// CopilotTask 首 turn（UI 阶段）。
//
// cut-1 只实现 ingestion_complete kind。streak（kc_wrong_streak）是 cut-2 fast-follow，
// 纯 additive 挂进本 evaluate 的 kind 分支。

import type { NudgePayloadT } from '@/core/schema/event/nudge-events';
import type { Db } from '@/db/client';
import { event, learning_session, question_block, source_document } from '@/db/schema';
import { getCorrectionStatuses } from '@/server/events/corrections';
import { type AnyColumn, type SQL, and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NudgeConfig } from './nudge-config';

export const NUDGE_ACTION = 'experimental:copilot_nudge';
export const NUDGE_DISMISSED_ACTION = 'experimental:copilot_nudge_dismissed';
export const NUDGE_OPENED_ACTION = 'experimental:copilot_nudge_opened';

// 静默窗读模型 backstop（§3.2 / Q7）：这些 kind 在「正答题/正练习中」由 GET /nudges 延迟呈现
// （练习结束后自然重现）。cut-1 的 ingestion_complete **非** interrupt-sensitive（录入完成时用户
// 通常不在答题）——恒呈现。此集合为 cut-2 streak（练习中触发）预留，读模型 backstop 随 cut-1
// 建好可测（should#4）。
export const INTERRUPT_SENSITIVE_KINDS: ReadonlySet<string> = new Set(['kc_wrong_streak']);

/** boss.send payload —— 只带定位 id，判定事实由 handler 从 event 表回读（evidence-first §3.1）。 */
export type NudgeEvaluateInput =
  | { kind: 'ingestion_complete'; session_id: string }
  | { kind: 'attempt_failure'; attempt_event_id: string };

export type NudgeDecisionReason =
  | 'no_extract_event' // ingestion 完成事件缺失（post-commit 后不应发生，防御）
  | 'no_blocks' // 提取 0 片段——不为空材料开口
  | 'already_nudged' // 同一触发源已发过 nudge（perf 层；unique index 是正确性保证）
  | 'attempt_not_found'
  | 'not_failure'
  | 'no_knowledge'
  | 'streak_below_threshold'
  | 'kc_cooldown'
  | 'daily_cap' // 当日可见 nudge 达上限（best-effort 软上限，非硬保证——TOCTOU §3.2）
  | 'dismiss_fused'; // owner 当日 dismiss 过同 kind → 该 kind 当日不再发（A3「同场景」）

/** fire=true 时交给 handler 写入的 nudge event（envelope 承重字段 + typed payload）。 */
export interface NudgeToWrite {
  subject_kind: 'learning_session' | 'knowledge';
  subject_id: string;
  caused_by_event_id: string;
  payload: NudgePayloadT;
}

export type NudgeDecision =
  | { fire: false; reason: NudgeDecisionReason }
  | { fire: true; event: NudgeToWrite };

/** Asia/Shanghai（固定 UTC+8，无 DST）当日谓词：col 的 Shanghai 日 === now 的 Shanghai 日。 */
function sameShanghaiDay(col: AnyColumn | SQL, now: Date): SQL {
  return sql`(${col} AT TIME ZONE 'Asia/Shanghai')::date = (${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`;
}

/** 当前是否有 open practice session（per-type open 态白名单）——写进 payload 供读模型静默窗 backstop（§3.2）。 */
export async function isInActivePracticeSession(db: Db): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(learning_session)
    .where(
      sql`(${learning_session.type} = 'tutor' AND ${learning_session.status} = 'active')
        OR (${learning_session.type} = 'review' AND ${learning_session.status} = 'started')
        OR (${learning_session.type} = 'placement' AND ${learning_session.status} = 'started')`,
    )
    .limit(1);
  return rows.length > 0;
}

function isUnsupportedAttemptPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as {
    unsupported_judge?: unknown;
    judge?: { coarse_outcome?: unknown };
  };
  return value.unsupported_judge === true || value.judge?.coarse_outcome === 'unsupported';
}

function getKnowledgeIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = payload as {
    fsrs_subject_kind?: unknown;
    fsrs_subject_ids?: unknown;
    referenced_knowledge_ids?: unknown;
  };
  const source =
    value.fsrs_subject_kind === 'knowledge' && Array.isArray(value.fsrs_subject_ids)
      ? value.fsrs_subject_ids
      : value.fsrs_subject_ids !== undefined
        ? []
        : Array.isArray(value.referenced_knowledge_ids)
          ? value.referenced_knowledge_ids
          : [];
  return Array.from(
    new Set(source.filter((id): id is string => typeof id === 'string' && id.length > 0).sort()),
  );
}

/**
 */
async function evaluateWrongStreak(
  db: Db,
  input: Extract<NudgeEvaluateInput, { kind: 'attempt_failure' }>,
  config: NudgeConfig,
  now: Date,
): Promise<NudgeDecision> {
  const triggerRows = await db
    .select({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      payload: event.payload,
      createdAt: event.created_at,
    })
    .from(event)
    .where(eq(event.id, input.attempt_event_id))
    .limit(1);
  const trigger = triggerRows[0];
  if (!trigger || (trigger.action !== 'attempt' && trigger.action !== 'review')) {
    return { fire: false, reason: 'attempt_not_found' };
  }
  if (trigger.outcome !== 'failure' || isUnsupportedAttemptPayload(trigger.payload)) {
    return { fire: false, reason: 'not_failure' };
  }

  const knowledgeIds = getKnowledgeIds(trigger.payload);
  if (knowledgeIds.length === 0) return { fire: false, reason: 'no_knowledge' };

  const candidates: Array<{ kcId: string; streak: number; tailEventIds: string[] }> = [];
  for (const kcId of knowledgeIds) {
    const rows = await db
      .select({ id: event.id, outcome: event.outcome, payload: event.payload })
      .from(event)
      .where(
        and(
          inArray(event.action, ['attempt', 'review']),
          eq(event.subject_kind, 'question'),
          or(
            sql`(${event.payload} ? 'fsrs_subject_ids' AND ${event.payload}->'fsrs_subject_ids' @> ${JSON.stringify([kcId])}::jsonb)`,
            sql`(NOT (${event.payload} ? 'fsrs_subject_ids') AND ${event.payload} @> ${JSON.stringify({ referenced_knowledge_ids: [kcId] })}::jsonb)`,
          ),
          sql`(${event.created_at}, ${event.id}) <= (${trigger.createdAt.toISOString()}::timestamptz, ${trigger.id})`,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id));

    const attemptIds = rows.map((row) => row.id);
    const judges =
      attemptIds.length === 0
        ? []
        : await db
            .select({ id: event.id, subjectId: event.subject_id })
            .from(event)
            .where(
              and(
                eq(event.action, 'judge'),
                eq(event.subject_kind, 'event'),
                inArray(event.subject_id, attemptIds),
              ),
            );
    const judgeIds = judges.map((judge) => judge.id);
    const correctionStatuses = await getCorrectionStatuses(db, judgeIds);
    const appealedJudgeIds =
      judgeIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ subjectId: event.subject_id })
                .from(event)
                .where(
                  and(
                    eq(event.action, 'experimental:appeal_request'),
                    eq(event.subject_kind, 'event'),
                    inArray(event.subject_id, judgeIds),
                  ),
                )
            ).map((row) => row.subjectId),
          );
    const contestedAttemptIds = new Set(
      judges
        .filter((judge) => {
          const correction = correctionStatuses.get(judge.id);
          return (
            appealedJudgeIds.has(judge.id) ||
            (correction !== undefined && correction.state !== 'active')
          );
        })
        .map((judge) => judge.subjectId),
    );

    const triggerIsContested = contestedAttemptIds.has(trigger.id);
    if (triggerIsContested) return { fire: false, reason: 'not_failure' };

    const tailEventIds: string[] = [];
    for (const row of rows) {
      if (row.outcome !== 'failure') break;
      if (isUnsupportedAttemptPayload(row.payload) || contestedAttemptIds.has(row.id)) continue;
      tailEventIds.push(row.id);
    }
    candidates.push({ kcId, streak: tailEventIds.length, tailEventIds });
  }

  candidates.sort((a, b) => b.streak - a.streak || a.kcId.localeCompare(b.kcId));
  const winner = candidates[0];
  if (!winner || winner.streak < config.streakN) {
    return { fire: false, reason: 'streak_below_threshold' };
  }

  const duplicateRows = await db
    .select({ one: sql<number>`1` })
    .from(event)
    .where(and(eq(event.action, NUDGE_ACTION), eq(event.caused_by_event_id, trigger.id)))
    .limit(1);
  if (duplicateRows.length > 0) return { fire: false, reason: 'already_nudged' };

  const shadow = !config.enabled;
  const cooldownRows = await db
    .select({ one: sql<number>`1` })
    .from(event)
    .where(
      and(
        eq(event.action, NUDGE_ACTION),
        eq(event.subject_kind, 'knowledge'),
        eq(event.subject_id, winner.kcId),
        sql`${event.payload}->>'kind' = 'kc_wrong_streak'`,
        sql`${event.created_at} >= ${now.toISOString()}::timestamptz - (${config.kcCooldownHours} * interval '1 hour')`,
      ),
    )
    .limit(1);
  if (cooldownRows.length > 0) return { fire: false, reason: 'kc_cooldown' };

  if (!shadow) {
    const capRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(event)
      .where(
        and(
          eq(event.action, NUDGE_ACTION),
          sql`${event.payload}->>'shadow' = 'false'`,
          sameShanghaiDay(event.created_at, now),
        ),
      );
    if (Number(capRows[0]?.n ?? 0) >= config.dailyMax) return { fire: false, reason: 'daily_cap' };

    const dismissed = alias(event, 'streak_dismissed');
    const nudge = alias(event, 'streak_nudge');
    const fusedRows = await db
      .select({ one: sql<number>`1` })
      .from(dismissed)
      .innerJoin(nudge, eq(nudge.id, dismissed.caused_by_event_id))
      .where(
        and(
          eq(dismissed.action, NUDGE_DISMISSED_ACTION),
          eq(nudge.subject_kind, 'knowledge'),
          eq(nudge.subject_id, winner.kcId),
          sql`${nudge.payload}->>'kind' = 'kc_wrong_streak'`,
          sql`${dismissed.created_at} >= ${now.toISOString()}::timestamptz - (${config.kcCooldownHours} * interval '1 hour')`,
        ),
      )
      .limit(1);
    if (fusedRows.length > 0) return { fire: false, reason: 'dismiss_fused' };
  }

  const inActiveSession = await isInActivePracticeSession(db);
  return {
    fire: true,
    event: {
      subject_kind: 'knowledge',
      subject_id: winner.kcId,
      caused_by_event_id: trigger.id,
      payload: {
        kind: 'kc_wrong_streak',
        headline: `这个知识点已经连续答错 ${winner.streak} 次，要不要换个角度看看？`,
        expires_at: new Date(now.getTime() + config.expiresHours * 3_600_000).toISOString(),
        shadow,
        in_active_session: inActiveSession,
        evidence: {
          kc_id: winner.kcId,
          streak_n: winner.streak,
          tail_event_ids: winner.tailEventIds,
        },
      },
    },
  };
}

export async function evaluateNudgeTrigger(
  db: Db,
  input: NudgeEvaluateInput,
  config: NudgeConfig,
  now: Date = new Date(),
): Promise<NudgeDecision> {
  if (input.kind === 'attempt_failure') {
    return evaluateWrongStreak(db, input, config, now);
  }

  // 1. 触发源 = 该 session 的域 extract 事件（evidence-first 证据链 + unique 幂等键）。
  //    subject_id = source_document_id（docx-ingestion.ts:208 / applyExtractionResult），用于取标题。
  const extractRows = await db
    .select({ id: event.id, subjectId: event.subject_id })
    .from(event)
    .where(and(eq(event.session_id, input.session_id), eq(event.action, 'extract')))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const extractEvent = extractRows[0];
  if (!extractEvent) return { fire: false, reason: 'no_extract_event' };

  // 2. perf 层查重（unique index 是正确性保证，handler 捕 23505）。
  const dup = await db
    .select({ one: sql<number>`1` })
    .from(event)
    .where(and(eq(event.action, NUDGE_ACTION), eq(event.caused_by_event_id, extractEvent.id)))
    .limit(1);
  if (dup.length > 0) return { fire: false, reason: 'already_nudged' };

  // 3. flag-invariant 提取事实计数（should#3）：数 question_block 行，非「收进 N 题」。
  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, input.session_id));
  const blockCount = Number(countRows[0]?.n ?? 0);
  if (blockCount === 0) return { fire: false, reason: 'no_blocks' };

  const shadow = !config.enabled;

  // 4. surfacing 护栏——只在 enabled（写可见 nudge）时施加。shadow 期故意跳过 dailyMax /
  // dismiss-fuse，以便观测真实触发率（§3.7 澄清：soft-cap 只约束可见写入；COUNT 也只数
  // 非 shadow 行，所以把同一检查套到 shadow 期要么永不触发、要么压扁观测窗）。
  if (!shadow) {
    // 每日上限：只数当日**可见**（非 shadow）nudge（doc §3.2 表「非 shadow COUNT」）。
    const capRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(event)
      .where(
        and(
          eq(event.action, NUDGE_ACTION),
          sql`${event.payload}->>'shadow' = 'false'`,
          sameShanghaiDay(event.created_at, now),
        ),
      );
    if (Number(capRows[0]?.n ?? 0) >= config.dailyMax) return { fire: false, reason: 'daily_cap' };

    // dismiss 熔断（ingestion=kind-wide）：当日 dismiss 过 ingestion_complete nudge → 该 kind 当日不再发。
    const dismissed = alias(event, 'nudge_dismissed');
    const nudge = alias(event, 'nudge_src');
    const fusedRows = await db
      .select({ one: sql<number>`1` })
      .from(dismissed)
      .innerJoin(nudge, eq(nudge.id, dismissed.caused_by_event_id))
      .where(
        and(
          eq(dismissed.action, NUDGE_DISMISSED_ACTION),
          sameShanghaiDay(dismissed.created_at, now),
          sql`${nudge.payload}->>'kind' = 'ingestion_complete'`,
        ),
      )
      .limit(1);
    if (fusedRows.length > 0) return { fire: false, reason: 'dismiss_fused' };
  }

  // 5. 静默窗 backstop 观测位（§3.2 / Q7）——判定时算出，读模型消费。
  const inActiveSession = await isInActivePracticeSession(db);

  // 6. session 显示名 = source_document.title（可空；learning_session 无 name 列）。空则降级去《》。
  let title: string | null = null;
  if (extractEvent.subjectId) {
    const docRows = await db
      .select({ title: source_document.title })
      .from(source_document)
      .where(eq(source_document.id, extractEvent.subjectId))
      .limit(1);
    const t = docRows[0]?.title?.trim();
    title = t ? t : null;
  }

  const expiresAt = new Date(now.getTime() + config.expiresHours * 3_600_000).toISOString();
  const payload: NudgePayloadT = {
    kind: 'ingestion_complete',
    // flag-invariant 措辞：「提取到」断言 extraction 产出（永真，不随 auto-enroll flag 漂移）。绝不「收进 N 题」。
    headline: title
      ? `我处理完《${title}》，提取到 ${blockCount} 个题目片段`
      : `我处理完你上传的材料，提取到 ${blockCount} 个题目片段`,
    expires_at: expiresAt,
    shadow,
    in_active_session: inActiveSession,
    evidence: { session_id: input.session_id, block_count: blockCount, title },
  };

  return {
    fire: true,
    event: {
      subject_kind: 'learning_session',
      subject_id: input.session_id,
      caused_by_event_id: extractEvent.id,
      payload,
    },
  };
}
