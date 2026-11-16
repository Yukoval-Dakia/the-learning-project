// YUK-1811 acceptance seed — NOT committed. Builds the same learner world as the
// YUK-1794 R2 comparison (goal「读完《史记·刺客列传》」+ old successes + 5 judged
// failures + dreaming_scan + 2 post-dreaming answers + answer_only/crisis events +
// real global brief regen), plus the B1.5-visible extras: a steering goal (window
// covers today) + a post-dreaming goal_scope_update, and admitted questions that
// actually serve in the due list so the new due-item detail lines have data.
//
// Fences copied from seed-dev-questions / seed-synthetic: SEED_SYNTHETIC_OK=1 +
// loopback dev DATABASE_URL. Deterministic ids (yuk1811:* / yuk1811_evt_*) make
// re-runs idempotent; every seeded event is backdated before T0 (printed at the
// end) so a later `created_at >= T0` sweep removes only run-generated rows.

import './load-env';

import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { MARKING_RULE_PROVENANCE, QUESTION_AVAILABILITY } from '@/core/schema/assessment/lifecycle';
import { CauseSchema } from '@/core/schema/cause';
import type { SteeringGoalDataT } from '@/core/schema/steering';
import { type Db, type Tx, db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  event,
  goal,
  knowledge,
  learning_session,
  material_fsrs_state,
  materialized_id_index,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { enqueueMemoryBriefRegen } from '@/kernel/memory-brief-regen';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { goalRowToSnapshot } from '@/kernel/records/goal-history';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
import { initialSchedulingState, upsertFsrsState } from '@/kernel/records/scheduling-state';
import { getStartedBoss } from '@/server/boss/client';
import { assertDevDatabase } from './seed-dev-questions';

type DbLike = Db | Tx;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const daysAgo = (d: number, now: Date) => new Date(now.getTime() - d * DAY);
const hoursAgo = (h: number, now: Date) => new Date(now.getTime() - h * HOUR);
const shanghaiDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(d);

const KC_ROOT = 'kc_yuk1811_root';
const KC = {
  cike: 'kc_yuk1811_cike',
  shici: 'kc_yuk1811_shici',
  jushi: 'kc_yuk1811_jushi',
} as const;

const NODE_SPECS: Array<{ id: string; name: string; parent: string | null }> = [
  { id: KC_ROOT, name: '史记（yuk1811 种子）', parent: null },
  { id: KC.cike, name: '刺客列传人物', parent: KC_ROOT },
  { id: KC.shici, name: '文言实词释义', parent: KC_ROOT },
  { id: KC.jushi, name: '文言特殊句式', parent: KC_ROOT },
];

const QUESTIONS = [
  {
    id: 'yuk1811:q:cike-membership',
    kind: 'choice' as const,
    kc: KC.cike,
    prompt_md: '下列哪位人物并未被司马迁写入《史记·刺客列传》？',
    choices_md: ['曹沫', '豫让', '李广', '聂政'],
    reference_md: 'C',
    difficulty: 2,
    dueDaysAgo: 3,
  },
  {
    id: 'yuk1811:q:jie-verb',
    kind: 'fill_blank' as const,
    kc: KC.shici,
    prompt_md: '「曹沫之盟也，执匕首劫齐桓公」一句中「劫」的意思是____。',
    reference_md: '胁迫',
    difficulty: 2,
    dueDaysAgo: 2,
  },
  {
    id: 'yuk1811:q:beidong',
    kind: 'choice' as const,
    kc: KC.jushi,
    prompt_md: '「父母宗族，皆为戮没」一句的句式属于下列哪一种？',
    choices_md: ['判断句', '被动句', '宾语前置', '省略句'],
    reference_md: 'B',
    difficulty: 2,
    dueDaysAgo: 1,
  },
];

const GOAL_MAIN = 'goal_yuk1811_shiji';
const GOAL_STEER = 'goal_yuk1811_steer';

const STEERING: SteeringGoalDataT = {
  learner_words: '这周先只复习史记刺客列传，其他内容先放一放',
  instruction_md: '本周集中复习《史记·刺客列传》，其余复习内容暂缓。',
  scope_text: '《史记·刺客列传》',
  scope_unresolved: [],
  excluded_subject_ids: [],
  excluded_knowledge_ids: [],
  metadata: {},
};

async function seedKnowledge(dbh: DbLike, now: Date): Promise<void> {
  const present = new Set(
    (
      await dbh
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(
          inArray(
            knowledge.id,
            NODE_SPECS.map((n) => n.id),
          ),
        )
    ).map((r) => r.id),
  );
  for (const spec of NODE_SPECS) {
    if (present.has(spec.id)) continue;
    await dbh.insert(knowledge).values({
      id: spec.id,
      name: spec.name,
      domain: spec.parent === null ? 'yuwen' : null,
      parent_id: spec.parent,
      approval_status: 'approved',
      proposed_by_ai: false,
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

async function seedGoals(dbh: DbLike, now: Date): Promise<void> {
  const present = new Set(
    (
      await dbh
        .select({ id: goal.id })
        .from(goal)
        .where(inArray(goal.id, [GOAL_MAIN, GOAL_STEER]))
    ).map((r) => r.id),
  );
  if (!present.has(GOAL_MAIN)) {
    await dbh.insert(goal).values({
      id: GOAL_MAIN,
      title: '读完《史记·刺客列传》',
      subject_id: 'yuwen',
      scope_knowledge_ids: [KC.cike, KC.shici, KC.jushi],
      scope_mode: 'explicit',
      sequence_hint: 0,
      status: 'active',
      source: 'user',
      created_at: daysAgo(30, now),
      updated_at: daysAgo(30, now),
      version: 0,
    });
  }
  if (!present.has(GOAL_STEER)) {
    await dbh.insert(goal).values({
      id: GOAL_STEER,
      title: '这周先只复习《史记·刺客列传》',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'explicit',
      sequence_hint: 1,
      status: 'active',
      source: 'learner_said',
      effective_from: shanghaiDay(daysAgo(1, now)),
      effective_until: shanghaiDay(new Date(now.getTime() + 5 * DAY)),
      steering: STEERING,
      created_at: hoursAgo(20, now),
      // 活行是 goal_scope_update 折后状态：version+1、updated_at=更新事件时间。
      updated_at: hoursAgo(6, now),
      version: 1,
    });
  }
  // 目标行必须有 genesis 锚（experimental:genesis 事件 + materialized_id_index），
  // 否则 canonical-projections 迁移按「eventful 无锚」拒启动。
  const anchored = new Set(
    (
      await dbh
        .select({ id: materialized_id_index.materialized_id })
        .from(materialized_id_index)
        .where(
          and(
            eq(materialized_id_index.subject_kind, 'goal'),
            inArray(materialized_id_index.materialized_id, [GOAL_MAIN, GOAL_STEER]),
          ),
        )
    ).map((r) => r.id),
  );
  for (const row of await dbh
    .select()
    .from(goal)
    .where(inArray(goal.id, [GOAL_MAIN, GOAL_STEER]))) {
    if (anchored.has(row.id)) continue;
    const genesisEventId = newId();
    await dbh.transaction(async (tx) => {
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: 'yuk1811-seed',
        action: 'experimental:genesis',
        subject_kind: 'goal',
        subject_id: row.id,
        outcome: 'success',
        // genesis 快照必须还原更新前状态（v0、updated_at=创建时间），
        // 否则 scope_update 折叠后与活行 drift。
        payload: {
          row: goalRowToSnapshot({ ...row, version: 0, updated_at: row.created_at }),
        },
        created_at: row.created_at,
        ingest_at: row.created_at,
      });
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'goal',
      });
    });
  }
}

async function seedQuestionsDue(dbh: DbLike, now: Date): Promise<void> {
  const present = new Set(
    (
      await dbh
        .select({ id: question.id })
        .from(question)
        .where(
          inArray(
            question.id,
            QUESTIONS.map((q) => q.id),
          ),
        )
    ).map((r) => r.id),
  );
  const fsrsPresent = new Set(
    (
      await dbh
        .select({ id: material_fsrs_state.subject_id })
        .from(material_fsrs_state)
        .where(
          inArray(
            material_fsrs_state.subject_id,
            QUESTIONS.map((q) => q.id),
          ),
        )
    ).map((r) => r.id),
  );
  for (const q of QUESTIONS) {
    if (!present.has(q.id)) {
      await dbh.transaction(async (tx) => {
        await acquireLearningStateWriteLock(tx);
        await tx.insert(question).values(
          withAnswerClass({
            id: q.id,
            kind: q.kind,
            prompt_md: q.prompt_md,
            reference_md: q.reference_md,
            choices_md: q.choices_md ?? null,
            knowledge_ids: [q.kc],
            difficulty: q.difficulty,
            source: 'manual',
            judge_kind_override: q.kind === 'fill_blank' ? 'exact' : null,
            draft_status: 'active',
            variant_depth: 0,
            figures: [],
            image_refs: [],
            structured: null,
            created_by: { by: 'user' },
            metadata: { yuk1811: true },
            created_at: daysAgo(28, now),
            updated_at: daysAgo(28, now),
            version: 0,
          }),
        );
        const published = await publishQuestionGroupFromRow(tx, {
          rootId: q.id,
          admission: {
            state: 'admitted',
            evidence: {
              marking_provenance: MARKING_RULE_PROVENANCE.MANUAL,
              verification: {
                structural_check_passed: true,
                independent_verification: {
                  passed: true,
                  verifier: 'human',
                  verified_at: now.toISOString(),
                },
                note: 'yuk1811 seed: fixed hand-checked answer key',
              },
              model_slice: null,
            },
          },
          availability: QUESTION_AVAILABILITY.GENERAL_POOL,
          claimPolicy: 'unbounded',
          actorRef: 'yuk1811-seed:question',
          now,
        });
        if (published.status !== 'published') {
          throw new Error(`yuk1811-seed: ${q.id} not published (${published.status})`);
        }
      });
    }
    if (!fsrsPresent.has(q.id)) {
      const initial = initialSchedulingState(q.id, now);
      await upsertFsrsState(dbh, {
        subject_kind: 'question',
        subject_id: q.id,
        state: initial.state,
        due_at: daysAgo(q.dueDaysAgo, now),
        last_review_event_id: null,
      });
    }
  }
}

interface AttemptSpec {
  id: string;
  qid: string;
  kc: string;
  outcome: 'success' | 'failure';
  at: Date;
  answer: string;
  policy?: 'answer_only';
}

async function writeAttempt(dbh: DbLike, spec: AttemptSpec): Promise<void> {
  await writeEvent(dbh, {
    id: spec.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: spec.qid,
    outcome: spec.outcome,
    payload: {
      ...(spec.policy ? { derivation_policy: spec.policy } : {}),
      answer_md: spec.answer,
      answer_image_refs: [],
      referenced_knowledge_ids: [spec.kc],
    },
    created_at: spec.at,
  });
}

async function writeJudge(
  dbh: DbLike,
  id: string,
  attemptId: string,
  kc: string,
  category: string,
  analysisMd: string,
  at: Date,
): Promise<void> {
  await writeEvent(dbh, {
    id,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    caused_by_event_id: attemptId,
    outcome: 'success',
    payload: {
      cause: CauseSchema.parse({
        primary_category: category,
        secondary_categories: [],
        analysis_md: analysisMd,
        confidence: 0.8,
      }),
      referenced_knowledge_ids: [kc],
    },
    created_at: at,
  });
}

async function seedEvents(dbh: DbLike, now: Date): Promise<void> {
  const existing = new Set(
    (
      await dbh
        .select({ id: event.id })
        .from(event)
        .where(inArray(event.id, ['yuk1811_evt_dream_scan']))
    ).map((r) => r.id),
  );
  if (existing.size > 0) return; // seeded once; re-runs are no-ops

  const [q1, q2, q3] = QUESTIONS;

  // 发言事件挂的会话行：eventAllowsDerivationSql 排除 session_id 无主的行，
  // 没有这条 conversation 会话，种子里的发言（含受限对照组）会整体被闸掉。
  await dbh.insert(learning_session).values({
    id: 'yuk1811_seed_conv',
    type: 'conversation',
    status: 'active',
    created_at: hoursAgo(10, now),
    started_at: hoursAgo(10, now),
  });

  // 3 旧成功作答（pre-dreaming）
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_ok1',
    qid: q1.id,
    kc: q1.kc,
    outcome: 'success',
    at: daysAgo(20, now),
    answer: 'C',
  });
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_ok2',
    qid: q2.id,
    kc: q2.kc,
    outcome: 'success',
    at: daysAgo(15, now),
    answer: '胁迫',
  });
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_ok3',
    qid: q3.id,
    kc: q3.kc,
    outcome: 'success',
    at: daysAgo(10, now),
    answer: 'B',
  });

  // 5 失败作答各带 judge 错因（pre-dreaming）：concept_confusion×3 + careless_mistake×2
  const fails: Array<{ qid: string; kc: string; days: number; cat: string; md: string }> = [
    {
      qid: q1.id,
      kc: q1.kc,
      days: 6.2,
      cat: 'concept_confusion',
      md: '把「刺客列传」与「游侠列传」的人物归属混淆，误选已在别传的人物。',
    },
    {
      qid: q2.id,
      kc: q2.kc,
      days: 5.6,
      cat: 'concept_confusion',
      md: '把「劫」理解为「抢劫」而非「胁迫」，古今词义边界混淆。',
    },
    {
      qid: q1.id,
      kc: q1.kc,
      days: 5.1,
      cat: 'careless_mistake',
      md: '题干问「未写入」却按「已写入」作答，漏看了否定词。',
    },
    {
      qid: q3.id,
      kc: q3.kc,
      days: 4.4,
      cat: 'concept_confusion',
      md: '把被动句的「为……所」结构误判成宾语前置。',
    },
    {
      qid: q2.id,
      kc: q2.kc,
      days: 4.0,
      cat: 'careless_mistake',
      md: '通假字「要」未认出，匆忙按本字义填了「要求」。',
    },
  ];
  for (let i = 0; i < fails.length; i++) {
    const f = fails[i];
    const attId = `yuk1811_evt_fail${i}`;
    const at = daysAgo(f.days, now);
    await writeAttempt(dbh, {
      id: attId,
      qid: f.qid,
      kc: f.kc,
      outcome: 'failure',
      at,
      answer: '错答',
    });
    await writeJudge(
      dbh,
      `yuk1811_evt_judge${i}`,
      attId,
      f.kc,
      f.cat,
      f.md,
      new Date(at.getTime() + 60_000),
    );
  }

  // Dreaming 固化（as_of 高水位）
  const dreamAt = daysAgo(2, now);
  await writeEvent(dbh, {
    id: 'yuk1811_evt_dream_scan',
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:dreaming_scan',
    subject_kind: 'system',
    subject_id: 'dreaming_scan',
    outcome: 'success',
    payload: { scanned_event_count: 13, proposals_written: 0, yuk1811: true },
    created_at: dreamAt,
  });

  // Dreaming 后 2 次新作答（1 对 1 错；错的不带 judge → 明细行照实「未归因」）
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_post_ok',
    qid: q3.id,
    kc: q3.kc,
    outcome: 'success',
    at: hoursAgo(20, now),
    answer: 'B',
  });
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_post_fail',
    qid: q1.id,
    kc: q1.kc,
    outcome: 'failure',
    at: hoursAgo(10, now),
    answer: '错答',
  });

  // 一条正常发言（post-dreaming）→ 发言计数对照组
  await writeEvent(dbh, {
    id: 'yuk1811_evt_ask_ok',
    session_id: 'yuk1811_seed_conv',
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: 'yuk1811_evt_ask_ok',
    outcome: null,
    payload: {
      surface: 'copilot',
      user_message: '史记这篇复习有什么建议',
      session_id: 'yuk1811_seed_conv',
    },
    created_at: hoursAgo(9, now),
  });

  // answer_only 作答（post-dreaming）—— 不能进新作答计数、不能进失败明细
  await writeAttempt(dbh, {
    id: 'yuk1811_evt_ao',
    qid: q2.id,
    kc: q2.kc,
    outcome: 'failure',
    at: hoursAgo(8, now),
    answer: '不会',
    policy: 'answer_only',
  });

  // crisis 发言（post-dreaming）—— 不能进发言计数、不能进任何明细
  await writeEvent(dbh, {
    id: 'yuk1811_evt_crisis',
    session_id: 'yuk1811_seed_conv',
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: 'yuk1811_evt_crisis',
    outcome: null,
    payload: {
      surface: 'copilot',
      user_message: '最近压力特别大有点撑不住',
      derivation_policy: 'crisis',
      session_id: 'yuk1811_seed_conv',
    },
    created_at: hoursAgo(7, now),
  });

  // Steering 事件（post-dreaming）→ Δ「目标调整 1 次」
  await writeEvent(dbh, {
    id: 'yuk1811_evt_steer',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:goal_scope_update',
    subject_kind: 'goal',
    subject_id: GOAL_STEER,
    outcome: 'success',
    payload: {
      effective_from: shanghaiDay(daysAgo(1, now)),
      effective_until: shanghaiDay(new Date(now.getTime() + 5 * DAY)),
      steering: STEERING,
    },
    created_at: hoursAgo(6, now),
  });
}

async function main(): Promise<void> {
  assertDevDatabase();
  const now = new Date();
  await seedKnowledge(db, now);
  await seedGoals(db, now);
  await seedQuestionsDue(db, now);
  await seedEvents(db, now);
  // 真实再生成 global brief：pg-boss 入队，dev worker 消费后写 memory_brief_note。
  const boss = await getStartedBoss();
  await enqueueMemoryBriefRegen(boss, 'global');
  console.log('[yuk1811-seed] done', {
    questions: QUESTIONS.length,
    brief_enqueued: 'global',
    seed_boundary_iso: now.toISOString(),
  });
  await boss.stop();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[yuk1811-seed] failed', err);
    process.exit(1);
  });
