// YUK-594 (durable judge main path) — durable judge_run job-payload contract：
// **提交当下冻结**的判分输入（题面快照 + 作答指纹），以及消费侧的还原 helper。
//
// 为什么单独一个模块：submit 面（api/submit.ts，生产者）与 worker 面
// （jobs/judge_run.ts，消费者）必须共用同一份「冻结哪些字段」的定义，否则两边各写
// 一份必然漂移。放 server/ 层与既有的 judge-durable-config / judge-run-status 同向
// （api → server、jobs → server），不让 api 反向依赖 jobs。
//
// 依赖轻：只吃 db schema 的行类型 + zod + 既有的 sha256Canonical，无 db client。

import type { question } from '@/db/schema';
import { sha256Canonical } from '@/server/judge/judge-execution-provenance';
import { z } from 'zod';

type QuestionRow = typeof question.$inferSelect;

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
export const FrozenQuestionSnapshotSchema = z.object({
  kind: z.string(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  rubric_json: z.unknown(),
  choices_md: z.array(z.string()).nullable(),
  judge_kind_override: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
  difficulty: z.number(),
  metadata: z.unknown(),
  figures: z.array(z.unknown()),
  image_refs: z.array(z.string()),
  structured: z.unknown(),
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
 * QuestionRow 同构；zod 侧只能表到 unknown，故在这里一次性收窄并说明理由。
 */
export function applyFrozenQuestion(
  live: QuestionRow,
  frozen: FrozenQuestionSnapshot,
): QuestionRow {
  const { version: _v, updated_at: _u, ...frozenColumns } = frozen;
  return { ...live, ...frozenColumns } as QuestionRow;
}

/**
 * #5 — 作答身份指纹，服务端短窗 dedupe 的键（配合 question_id）。覆盖「同一次作答」
 * 的全部判分输入：作答文本 / 作答图片 / 作答的 sub-node / 是否自动判分 / 归属活动。
 * 复用既有的 `sha256Canonical`（判分 provenance 同一套稳定序列化），不另写哈希。
 *
 * 不含时间戳/随机量——重试必须命中同一指纹，这正是 dedupe 生效的前提。
 */
export function submitAnswerFingerprint(input: {
  questionId: string;
  responseMd: string | null | undefined;
  answerImageRefs: string[];
  partRef: string | null | undefined;
  autoRate: boolean;
  sessionId: string | null | undefined;
}): string {
  return sha256Canonical({
    question_id: input.questionId,
    response_md: input.responseMd ?? '',
    answer_image_refs: [...input.answerImageRefs].sort(),
    part_ref: input.partRef ?? null,
    auto_rate: input.autoRate,
    session_id: input.sessionId ?? null,
  });
}
