// 速率护栏：单位时间内 AI auto-apply 失控时，把同一 patch 转人工审批，不静默改
// artifact。warn 只发观测 event，仍 apply；trip 退回人审，但不阻塞用户采纳。
// 计数从 event log 派生（不新建表），且只数 AI mutator，人工 accept 不计入。
// 不触 θ̂ / p(L) / FSRS。

import { and, eq, gte, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { NOTE_REFINE_AUTOAPPLY_ACTOR } from './note-refine-apply';

type DbLike = Db | Tx;

// 1h 窗口；warn=8、max=20 约为正常 2–3/h 的 3–5 倍。
export const REFINE_RATE_WINDOW_MS = 3_600_000;
export const REFINE_AUTOAPPLY_WARN = 8;
export const REFINE_AUTOAPPLY_MAX = 20;

export type AutoApplyBreakerStatus = 'ok' | 'warned' | 'tripped';

export interface CheckAutoApplyBreakerInput {
  /** AI auto-applies already in the window, excluding this one. */
  recentCount: number;
  /** At or above this count the status is warned (still applies). */
  warn?: number;
  /** At or above this count the patch goes to human review. */
  max?: number;
}

/**
 * recentCount < warn → ok; warn ≤ recentCount < max → warned;
 * recentCount ≥ max → tripped.
 */
export function checkAutoApplyBreaker(input: CheckAutoApplyBreakerInput): {
  status: AutoApplyBreakerStatus;
} {
  const warn = input.warn ?? REFINE_AUTOAPPLY_WARN;
  const max = input.max ?? REFINE_AUTOAPPLY_MAX;
  const count = input.recentCount;
  if (count >= max) return { status: 'tripped' };
  if (count >= warn) return { status: 'warned' };
  return { status: 'ok' };
}

export interface CountRecentAutoAppliesInput {
  /** Window end, usually the refine's now. */
  now: Date;
  windowMs?: number;
  /** Defaults to the AI mutator actor; human accepts must stay excluded. */
  actorRef?: string;
}

/** Count apply events in the window for one actor. */
export async function countRecentAutoApplies(
  db: DbLike,
  input: CountRecentAutoAppliesInput,
): Promise<number> {
  const windowMs = input.windowMs ?? REFINE_RATE_WINDOW_MS;
  const actorRef = input.actorRef ?? NOTE_REFINE_AUTOAPPLY_ACTOR;
  const windowStart = new Date(input.now.getTime() - windowMs);
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:note_refine_apply'),
        eq(event.actor_ref, actorRef),
        gte(event.created_at, windowStart),
      ),
    );
  return rows[0]?.value ?? 0;
}
