// YUK-594 (durable judge main path) — durable judge_run job-payload contract：
// **提交当下冻结**的判分输入（题面快照），以及消费侧的还原 helper。
//
// 为什么单独一个模块：submit 面（api/submit.ts，生产者）与 worker 面
// （jobs/judge_run.ts，消费者）必须共用同一份「冻结哪些字段」的定义，否则两边各写
// 一份必然漂移。放 server/ 层与既有的 judge-durable-config / judge-run-status 同向
// （api → server、jobs → server），不让 api 反向依赖 jobs。
//
// 依赖轻：db schema 行类型 + zod + drizzle 算子；`Db` 只作参数类型传入，不 import db client
// 单例（保持本模块可被 api/ 与 jobs/ 双向复用而不牵入运行时连接）。

import type { Db } from '@/db/client';
import { event, type question } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

type QuestionRow = typeof question.$inferSelect;

/**
 * judge_run job 体。W2 由 submit 面投递；YUK-777 起 reconcile sweeper 也按同一形状重投。
 *
 * YUK-777 — 从 `jobs/judge_run.ts` 挪到这里（原地 re-export 保持既有 import 不变）：
 * 现在有三个生产者读它（submit 面、sweeper、pending-attempt 证据行的冻结 payload），而
 * `api/` 与 `server/` 都不该反向依赖 `jobs/`。此文件本就是「job payload 契约 + 冻结/还原
 * helper」的家，类型跟着契约走。
 */
export interface JudgeRunJobData {
  /**
   * run handle + job_events business_id。**W2 submit 面**：= 该次作答 attempt/outcome
   * event id（persistSubmit 以它做 eventId，见 opts.attemptEventId）。此「= attempt
   * event id」契约是 submit 面特化，不对全部面通用（advice 面无 event，W3 另定）。
   */
  run_id: string;
  /** 发起面（回填路由 + payload 分支判别）。W2 只有 'submit'。 */
  caller: 'submit';
  /** submit 面冻结输入（D5：profile 冻结进 payload，作答当下画像）。 */
  submit: {
    /** 冻结的 CreateAttemptBody（JSON）。worker 侧 CreateAttemptBodySchema 复校。 */
    body: unknown;
    question_id: string;
    /** D5 — enqueue 时冻结的 SubjectProfile（JSON）。worker 侧 SubjectProfileSchema 复校。 */
    subject_profile: unknown;
    /**
     * #2 (codex) — enqueue 时冻结的题面快照（判分 + 调度读的全部字段）。worker 侧
     * FrozenQuestionSnapshotSchema 复校后覆盖到现读行上，故提交后编辑题目不再让判分/
     * FSRS 打在与学习者所见不同的题面上。见下方 freezeQuestionForJudge。
     *
     * optional：本 PR 之前入队的在飞 job 没这个字段（且 flag 默认 OFF ⇒ 生产无此类
     * job）。缺失时退回「现读行」旧行为并记一条 warn，而不是把在飞 job 判死。
     */
    question_snapshot?: unknown;
    /** 作答时刻（ISO）——FSRS 调度锚定作答当下，非 worker 拾取时刻。 */
    submitted_at: string;
  };
}

/**
 * #2 (codex) — **题目数据冻结**。flag-on 时 submit 只把答案/画像冻进 payload，worker
 * 拾取时重读可变的 question 行；提交后有人编辑 prompt/reference/choices/knowledge/
 * difficulty，判分与调度就打在与学习者当时所见**不同**的题面上（判词错、FSRS 脏）。
 *
 * 为什么不用 version 锚：`question.version` 只在 structured 编辑路径自增
 * （practice/server/proposal-appliers.ts 的乐观写），纯 prompt_md / reference_md 编辑
 * 不动它——拿它当 staleness 锚会**漏检**恰好是本 finding 说的那类编辑。`updated_at`
 * 覆盖面更广但同样不是每条写路径的硬契约。故取**内容冻结**：把判分 + 调度真正读的
 * 字段整体冻进 payload，worker 按冻结值判分，与同步面（单次读行）语义一致。
 *
 * 也因此**不需要 stale 失败路径**：冻结值自足，题面漂移不再让一次合法作答报废
 * （version-mismatch-then-fail 会把学习者已提交的答案直接丢掉，更差）。version /
 * updated_at 仍冻一份，纯作可观测锚（worker 侧检出漂移记一条 warn）。
 */
/**
 * W4 #TtZ8l — the four jsonb columns are typed to their actual SHAPE, not `z.unknown()`.
 *
 * This schema is not decoration: the worker runs `FrozenQuestionSnapshotSchema.parse()` on
 * the deserialized payload, and the parsed result is overlaid onto a live row through a cast.
 * `z.unknown()` accepts literally anything, so a corrupted payload sailed through validation
 * and only blew up later inside the judge — where it was classified `judge_failed`
 * (RETRYABLE) and burned the whole redelivery budget re-failing on a permanent defect.
 * Typing the shape moves that failure to the validation boundary, where it is correctly
 * classified `invalid_payload` (non-retryable) and terminalizes immediately.
 *
 * Kept deliberately loose INSIDE each container (`z.record`/`z.array` of unknown rather than
 * the full RubricT / StructuredQuestionT / FigureRefT trees): the goal is to catch structural
 * corruption, not to re-litigate the domain schemas here — a second copy of those trees would
 * be exactly the double-write this file exists to avoid.
 */
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const FrozenQuestionSnapshotSchema = z.object({
  kind: z.string(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  rubric_json: JsonObjectSchema.nullable(),
  choices_md: z.array(z.string()).nullable(),
  judge_kind_override: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
  difficulty: z.number(),
  metadata: JsonObjectSchema.nullable(),
  figures: z.array(JsonObjectSchema),
  image_refs: z.array(z.string()),
  structured: JsonObjectSchema.nullable(),
  /** 可观测锚：作答当下的行代际（不做 staleness 判死，只用于 drift warn）。 */
  version: z.number(),
  /** 可观测锚：作答当下的 updated_at（ISO）。 */
  updated_at: z.string(),
});

export type FrozenQuestionSnapshot = z.infer<typeof FrozenQuestionSnapshotSchema>;

/**
 * 生产侧（submit 面）：从作答当下读到的 question 行摘出冻结子集。字段逐条显式列举
 * （非 spread）——加列时 TS 不会默默把新列带进 payload，要冻就得有意识地加一行。
 */
export function freezeQuestionForJudge(q: QuestionRow): FrozenQuestionSnapshot {
  return {
    kind: q.kind,
    prompt_md: q.prompt_md,
    reference_md: q.reference_md,
    rubric_json: q.rubric_json,
    choices_md: q.choices_md,
    judge_kind_override: q.judge_kind_override,
    knowledge_ids: q.knowledge_ids,
    difficulty: q.difficulty,
    metadata: q.metadata,
    figures: q.figures,
    image_refs: q.image_refs,
    structured: q.structured,
    version: q.version,
    updated_at: q.updated_at.toISOString(),
  };
}

/**
 * 消费侧（worker）：把冻结快照覆盖到**现读**的 question 行上。
 *
 * 为什么还要现读行：① 存在性检查（题被删 → 非重投失败）；② 快照不冻的列
 * （id / source / source_ref / draft_status / …）回填路径仍要用，且它们不参与判分。
 * 覆盖后 `q` 的判分 + 调度相关字段全部是作答当下的值。
 *
 * 单处 cast：快照就是这些列自己的 JSON 往返（jsonb / text / int，无 Date），形状与
 * QuestionRow 同构。schema 已把四个 jsonb 列收到「对象/数组」这一层（#TtZ8l），足以在
 * 边界拦住结构性损坏；但它刻意不复刻 RubricT / StructuredQuestionT / FigureRefT 的完整
 * 树（那会变成本文件要避免的双写），故最后这一步收窄仍需一次显式 cast。
 */
export function applyFrozenQuestion(
  live: QuestionRow,
  frozen: FrozenQuestionSnapshot,
): QuestionRow {
  const { version: _v, updated_at: _u, ...frozenColumns } = frozen;
  return { ...live, ...frozenColumns } as QuestionRow;
}

/**
 * W5 #Tunn3 / #Tunn2 — rebuild a terminal DONE payload from the **permanent domain log**.
 *
 * `job_events` is the progress stream, not the source of truth: it is pruned on a retention
 * window, and its terminal write can fail outright on the final delivery. The durable record
 * of a judged submit is the pair the backfill tx commits — the `review` event (id = run_id)
 * and the `judge` event chained to it — which live in the permanent event log. So both
 * recovery paths resolve the verdict from there:
 *
 *   - the worker's idempotency guard, when the backfill committed but DONE never landed;
 *   - the `/status` route, when the run has no job_events at all (pruned, or never written).
 *
 * Returns null when no attempt event exists for `runId` — i.e. this run genuinely never
 * persisted anything, which is a real "unknown run", not a recoverable one.
 *
 * `judge` events are ordered newest-first: an appeal-driven rejudge writes a NEW judge event
 * against the same review event and wins by newest (D6), so an unordered read could resurrect
 * a superseded verdict.
 */
export async function reconstructDoneFromDomainEvents(
  db: Db,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [attempt] = await db.select().from(event).where(eq(event.id, runId)).limit(1);
  if (!attempt) return null;
  const [judgeEvent] = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'judge'), eq(event.subject_id, runId)))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const judgePayload = (judgeEvent?.payload ?? {}) as Record<string, unknown>;
  const attemptPayload = (attempt.payload ?? {}) as Record<string, unknown>;
  // W5 #TuxJL — read from where `persistSubmit` ACTUALLY writes each field, not from a
  // shape that looked plausible. The judge event's payload carries `coarse_outcome` /
  // `score` / `feedback_md` / `capability_ref` / `judge_route`, but NOT `evidence_json`
  // — that lives on the REVIEW event's embedded `payload.judge` block. Reading it off the
  // judge event silently produced nothing, and because every field in the terminal schema
  // is optional the loss passed validation unnoticed. `payload.judge` is the richer of the
  // two, so it is preferred and the judge event backfills what it lacks.
  const embedded = (attemptPayload.judge ?? {}) as Record<string, unknown>;
  const pick = <T>(guard: (v: unknown) => boolean, ...candidates: unknown[]): T | undefined => {
    for (const c of candidates) if (guard(c)) return c as T;
    return undefined;
  };
  const isStr = (v: unknown) => typeof v === 'string';
  const isNum = (v: unknown) => typeof v === 'number';
  const present = (v: unknown) => v !== undefined && v !== null;

  const coarseOutcome = pick<string>(isStr, embedded.coarse_outcome, judgePayload.coarse_outcome);
  const score = pick<number>(present, embedded.score, judgePayload.score);
  const confidence = pick<number>(isNum, embedded.confidence, judgePayload.confidence);
  const feedbackMd = pick<string>(isStr, embedded.feedback_md, judgePayload.feedback_md);
  const evidenceJson = pick<unknown>(present, embedded.evidence_json);
  const capabilityRef = pick<unknown>(
    present,
    embedded.capability_ref,
    judgePayload.capability_ref,
  );
  const route = pick<string>(isStr, embedded.route, judgePayload.judge_route);
  // YUK-777 D3 (#TuxJL) — `score_meaning` IS reconstructable now: `persistSubmit` writes it
  // into the review event's embedded `payload.judge` block, next to the `score` it qualifies.
  // Still `pick`ed rather than assumed: an attempt persisted before that write landed has no
  // such key, and omitting the field for those rows is the honest answer (the terminal schema
  // marks it optional). Inventing a default would silently mislabel a real historical score.
  const scoreMeaning = pick<string>(isStr, embedded.score_meaning, judgePayload.score_meaning);

  return {
    attempt_event_id: runId,
    judge_event_id: judgeEvent?.id ?? null,
    already_persisted: true,
    ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
    ...(typeof attemptPayload.fsrs_rating === 'string'
      ? { final_rating: attemptPayload.fsrs_rating }
      : {}),
    ...(coarseOutcome !== undefined ? { coarse_outcome: coarseOutcome } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(scoreMeaning !== undefined ? { score_meaning: scoreMeaning } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(feedbackMd !== undefined ? { feedback_md: feedbackMd } : {}),
    ...(evidenceJson !== undefined ? { evidence_json: evidenceJson } : {}),
    ...(capabilityRef !== undefined ? { capability_ref: capabilityRef } : {}),
    ...(route !== undefined ? { route } : {}),
  };
}

// W4 #TtWiC — `submitAnswerFingerprint` lived here as the key for a short-window
// (question_id, answer_hash) enqueue dedupe. It is GONE, not merely unused: content-derived
// request identity cannot distinguish a client retry from a genuine re-answer, and PfSolo
// explicitly supports re-answering the same question (PfSolo.tsx), so the dedupe swallowed
// real repeat attempts — no new immutable attempt row, no FSRS advance — while also ignoring
// persistence-relevant fields (referenced_knowledge_ids / stream_item_id / latency_ms) that
// make two same-text submits semantically different. Trading correctness of normal use for
// cost savings on an abnormal path is the wrong trade. Idempotency returns as a client-
// supplied Idempotency-Key in W3 (YUK-777).
