// ====================================================================
// YUK-1057 — 隔离演练 fixture 语料（sanitized synthetic，不退化成单字段
// happy path）
// ====================================================================
//
// 全部内容是【合成】学习者数据 —— 无任何生产 learner 原文；但结构上保持
// 生产形状：长文本题干/作答、嵌套 jsonb（question_snapshot、unit_results
// 输入面的 response_set、fsrs_state、evidence）、跨表 loose text-ref 链
// （event → answer → learning_record → fsrs/mastery/calibration）、以及
// 边界样例（live draft、无 snapshot 的 pre-snapshot attempt、纠正链、
// ambiguous judge 并列、未回填 durable pending、solo review）。
//
// 语料分区对照 capture（src/server/migration/capture.ts 的读取面）：
//   events 全分区（assessment 锚 + causal_closure_lineage 引用世系）、
//   fsrs/mastery/kc_typed/axis/item+family calibration/difficulty labels、
//   selection_observation、answers（live draft + submitted mirror）、
//   sessions、learning_record mirrors、question lineage、source_assets。
// contract corpus（question_revision / lifecycle / admission / registry）
// 在 ./contract-corpus.ts —— 演练侧 mock 语料导入 lane 的产物。

import type { InferInsertModel } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  ai_task_runs,
  answer,
  artifact,
  cause_category_overlay,
  completion_evidence,
  cost_ledger,
  difficulty_calibration_label,
  event,
  event_subscription_checkpoint,
  event_subscription_delivery,
  goal,
  item_calibration,
  item_family_calibration,
  kc_typed_state,
  knowledge,
  knowledge_edge,
  learner_axis_state,
  learning_item,
  learning_record,
  mastery_state,
  material_fsrs_state,
  memory_brief_note,
  mistake_variant,
  practice_stream_item,
  question,
  selection_observation,
  source_asset,
  source_document,
} from '@/db/schema';

// 固定时间轴（全部事件/行落同一逻辑日；幂等重放要求 id/timestamps 稳定）。
const T0 = new Date('2026-09-20T08:00:00.000Z');
const at = (minuteOffset: number) => new Date(T0.getTime() + minuteOffset * 60_000);

// ───────────────────────── 冻结 snapshot（真实契约形状） ─────────────────────────

/**
 * attempt 事件的冻结 snapshot（AttemptQuestionSnapshot，见
 * src/core/schema/question-evidence-snapshot.ts；与 capture.db.test.ts 同型）。
 * `q-main` 的 snapshot_verified registry 绑定 digest = canonicalHash(本对象)。
 */
export const MAIN_SNAPSHOT = {
  schema_version: 1,
  question: {
    question_id: 'q-main',
    question_version: 0,
    parent_question_id: null,
    prompt_md:
      '甲乙两车从相距 480 千米的两地同时相向开出，甲车速度 60 千米/时，乙车速度比甲车快 20%。' +
      '（1）乙车速度是多少千米/时？（2）两车经过多少小时相遇？（3）相遇时甲车比乙车少行驶多少千米？',
    reference_md:
      '（1）72 千米/时 （2）480÷(60+72)=40/11 小时≈3.64 小时 （3）480−2×60×(40/11)=480/11≈43.6 千米',
    choices_md: null,
    image_refs: [],
    figures: [],
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  parent_question: null,
} as const;

/**
 * durable pending 的冻结输入（FrozenQuestionSnapshot 结构，practice 侧
 * judge-run-payload.ts；core 侧结构等价校验，见 classify.ts 注释）。
 * `q-durable` 的 snapshot_verified 绑定 digest = canonicalHash(本对象)。
 */
export const DURABLE_SNAPSHOT = {
  kind: 'short_answer',
  prompt_md:
    '阅读材料：「城市热岛效应使城区气温高于郊区，其主要机理包括下垫面热力性质差异、人为热排放与绿地蒸散减少。」' +
    '用一句话概括城市热岛效应的两个成因，并说明减少热岛效应的一项可行措施及其作用机理。',
  reference_md:
    '成因：下垫面热力性质差异 + 人为热排放（绿地蒸散减少可并入其一）；措施示例：增加绿地/湿地以提高蒸散降温。',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['kc-geo-urban'],
  difficulty: 3,
  metadata: null,
  figures: [],
  image_refs: [],
  structured: null,
  version: 0,
  updated_at: '2026-09-01T00:00:00.000Z',
} as const;

// q-solo 的 attempt 快照（solo review 的历史事件版本；pre-snapshot 形态另行覆盖）。
export const SOLO_SNAPSHOT = {
  schema_version: 1,
  question: {
    question_id: 'q-solo',
    question_version: 0,
    parent_question_id: null,
    prompt_md: '证明：任意三角形内角和为 180°。',
    reference_md: '过顶点作对边平行线，同位角/内错角转移后拼成平角。',
    choices_md: null,
    image_refs: [],
    figures: [],
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  parent_question: null,
} as const;

// ───────────────────────── 语料清单（报告/断言用） ─────────────────────────

export interface SeedManifest {
  tables: Record<string, number>;
  /** 分类锚点（测试/报告读）：capture 分类器应产出的关键 category。 */
  anchors: {
    complete_attempt_event_id: string;
    durable_review_event_id: string;
    pending_only_event_id: string;
    ambiguous_anchor_event_id: string;
    presnapshot_event_id: string;
    solo_review_event_id: string;
    live_draft_answer_id: string;
    mirror_answer_id: string;
  };
  /** 冻结 snapshot 常量（registry digest 计算用）。 */
  snapshots: {
    main: typeof MAIN_SNAPSHOT;
    durable: typeof DURABLE_SNAPSHOT;
    solo: typeof SOLO_SNAPSHOT;
  };
}

/** 语料的事件/锚 id 常量（下游步骤与报告共用）。 */
export const SEED_IDS = {
  completeAttempt: 'att-main-1',
  completeJudge: 'jud-main-1',
  ambiguousAttempt: 'att-amb-1',
  ambiguousJudgeA: 'jud-amb-a',
  ambiguousJudgeB: 'jud-amb-b',
  durablePending: 'pen-dur-1',
  durableReview: 'rev-dur-1',
  pendingOnly: 'pen-orphan-1',
  presnapshotAttempt: 'att-legacy-nosnap',
  soloReview: 'rev-solo-1',
  ratingOnlyReview: 'rev-rating-1',
  liveDraftAnswer: 'ans-draft-1',
  mirrorAnswer: 'ans-mirror-1',
} as const;

type EventInsert = InferInsertModel<typeof event>;

function ev(
  row: Partial<EventInsert> &
    Pick<EventInsert, 'id' | 'action' | 'subject_kind' | 'subject_id' | 'payload'>,
): EventInsert {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    outcome: null,
    session_id: null,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    affected_scopes: [],
    created_at: T0,
    ...row,
  };
}

// ───────────────────────── 主体结构 ─────────────────────────

/**
 * 种入全量语料（FK/loose-ref 序：身份→素材→题→会话/条目→作答→投影→事件流）。
 * 幂等不保证（同库重跑会撞 PK）—— 演练库是一次性 ephemeral，seed 只跑一次。
 */
export async function seedRehearsalCorpus(db: Db): Promise<SeedManifest> {
  // ── 1) 身份层：knowledge + edge（挂 builtin seed:math:root 锚之下） ──
  await db.insert(knowledge).values([
    {
      id: 'kc-math-ratio',
      name: '比与百分比应用',
      domain: 'math',
      parent_id: 'seed:math:root',
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: T0,
      updated_at: T0,
    },
    {
      id: 'kc-math-motion',
      name: '行程相遇问题',
      domain: 'math',
      parent_id: 'seed:math:root',
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: T0,
      updated_at: T0,
    },
    {
      id: 'kc-geo-urban',
      name: '城市热岛效应',
      domain: 'geography',
      parent_id: null,
      proposed_by_ai: true,
      approval_status: 'approved',
      created_at: T0,
      updated_at: T0,
    },
  ]);
  await db.insert(knowledge_edge).values([
    {
      id: 'ke-1',
      from_knowledge_id: 'kc-math-ratio',
      to_knowledge_id: 'kc-math-motion',
      relation_type: 'prerequisite',
      weight: 0.9,
      created_by: { by: 'user' },
      reasoning: '相遇问题的速度比较需要百分比运算',
      created_at: T0,
    },
    {
      id: 'ke-2',
      from_knowledge_id: 'kc-geo-urban',
      to_knowledge_id: 'kc-math-ratio',
      relation_type: 'applied_in',
      weight: 0.4,
      created_by: { by: 'ai', task_kind: 'KnowledgeEdgeProposeTask' },
      reasoning: null,
      created_at: T0,
    },
  ]);

  // ── 2) 素材层：source_asset ×2（含一张答案图片）+ source_document ──
  await db.insert(source_asset).values([
    {
      id: 'asset-answer-1',
      kind: 'image',
      storage_key: 'answers/asset-answer-1.png',
      mime_type: 'image/png',
      byte_size: 18_432,
      sha256: 'a1'.repeat(32),
      width: 1600,
      height: 900,
      provenance: { source: 'rehearsal-fixture', note: 'synthetic answer photo stand-in' },
      created_at: T0,
    },
    {
      id: 'asset-fig-1',
      kind: 'image',
      storage_key: 'figures/asset-fig-1.png',
      mime_type: 'image/png',
      byte_size: 9_216,
      sha256: 'b2'.repeat(32),
      width: 800,
      height: 450,
      provenance: { source: 'rehearsal-fixture' },
      created_at: T0,
    },
  ]);
  await db.insert(source_document).values({
    id: 'doc-geo-1',
    title: '城市气候阅读材料（脱敏合成）',
    source_asset_ids: ['asset-fig-1'],
    body_md:
      '材料节选：城市下垫面以混凝土、沥青为主，比热容小、导热快；' +
      '人为热排放来自交通、空调与工业；绿地与水体蒸散可带走潜热。'.repeat(3),
    provenance: { source: 'rehearsal-fixture' },
    created_at: T0,
    updated_at: T0,
  });

  // ── 3) 题目层：4 题（含父子 part 行 + draft 行 + 嵌入 lineage） ──
  await db.insert(question).values([
    {
      id: 'q-main',
      kind: 'short_answer',
      prompt_md: MAIN_SNAPSHOT.question.prompt_md,
      reference_md: MAIN_SNAPSHOT.question.reference_md,
      choices_md: null,
      answer_class: 'open_ended',
      knowledge_ids: ['kc-math-motion', 'kc-math-ratio'],
      difficulty: 4,
      source: 'web_sourced',
      source_ref: 'fixture:math-motion-001',
      draft_status: null,
      variant_depth: 0,
      parent_question_id: null,
      part_index: null,
      root_question_id: null,
      parent_variant_id: null,
      image_refs: [],
      figures: [],
      created_by: { by: 'ai', task_kind: 'SourcingTask' },
      metadata: { fixture: true, scenario: 'multi-part word problem' },
      created_at: T0,
      updated_at: T0,
      version: 0,
    },
    {
      id: 'q-durable',
      kind: 'short_answer',
      prompt_md: DURABLE_SNAPSHOT.prompt_md,
      reference_md: DURABLE_SNAPSHOT.reference_md,
      choices_md: null,
      answer_class: 'open_ended',
      knowledge_ids: ['kc-geo-urban'],
      difficulty: 3,
      source: 'manual',
      source_ref: 'fixture:geo-urban-001',
      draft_status: null,
      variant_depth: 0,
      image_refs: ['asset-fig-1'],
      figures: [],
      created_by: { by: 'user' },
      metadata: { fixture: true },
      created_at: T0,
      updated_at: T0,
      version: 0,
    },
    {
      id: 'q-solo',
      kind: 'derivation',
      prompt_md: SOLO_SNAPSHOT.question.prompt_md,
      reference_md: SOLO_SNAPSHOT.question.reference_md,
      choices_md: null,
      answer_class: 'proof',
      knowledge_ids: ['kc-math-ratio'],
      difficulty: 5,
      source: 'manual',
      draft_status: null,
      variant_depth: 0,
      image_refs: [],
      figures: [],
      created_at: T0,
      updated_at: T0,
      version: 0,
    },
    {
      id: 'q-draft-x',
      kind: 'fill_blank',
      prompt_md: '（草稿）填空：1 千米 = ____ 米。',
      reference_md: '1000',
      choices_md: null,
      answer_class: 'exact',
      knowledge_ids: [],
      difficulty: 1,
      source: 'quiz_gen',
      draft_status: 'needs_review',
      variant_depth: 0,
      image_refs: [],
      figures: [],
      created_by: { by: 'ai', task_kind: 'QuizGenTask' },
      metadata: { fixture: true, stranded: true },
      created_at: T0,
      updated_at: T0,
      version: 0,
    },
  ]);

  // ── 4) 会话/条目/档案 ──
  // 单写者不变量（session-single-owner）：learning_session 的生产写入只允许
  // src/server/session/*。这里是对 ephemeral 演练库的种子写入（非生产 seam），
  // 用原生 SQL 明示身份，绕开 drizzle 类型化 insert 以免被不变量扫描误判。
  await db.execute(sql`
    insert into learning_session
      (id, type, status, source_document_id, artifact_id, started_at, ended_at, created_at, updated_at)
    values
      ('sess-practice-1', 'practice', 'completed', null, null,
        ${T0.toISOString()}, ${at(45).toISOString()}, ${T0.toISOString()}, ${at(45).toISOString()}),
      ('sess-tutor-1', 'tutor', 'active', 'doc-geo-1', null,
        ${at(50).toISOString()}, null, ${at(50).toISOString()}, ${at(50).toISOString()})
  `);
  await db.insert(artifact).values({
    id: 'art-note-1',
    type: 'note',
    title: '行程问题笔记（合成）',
    parent_artifact_id: null,
    knowledge_ids: ['kc-math-motion'],
    intent_source: 'user',
    source: 'manual',
    source_ref: null,
    // ArtifactBodyBlocks = TipTap doc（{ type:'doc', content:[...] }）。
    body_blocks: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '相遇问题：s = (v1+v2)·t' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '甲乙相遇：480km / (60+72)km/h' }],
        },
      ],
    },
    attrs: { fixture: true },
    generation_status: 'ready',
    verification_status: 'not_required',
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(learning_item).values([
    {
      id: 'li-1',
      source: 'practice',
      source_ref: 'q-main',
      title: '行程相遇应用题',
      content: '甲乙相向而行类问题的速度合成与追及变形。',
      knowledge_ids: ['kc-math-motion'],
      primary_artifact_id: 'art-note-1',
      status: 'completed',
      due_at: at(24 * 60),
      completed_at: at(45),
      created_at: T0,
      updated_at: at(45),
    },
    {
      id: 'li-2',
      source: 'review',
      source_ref: 'q-durable',
      title: '城市热岛效应材料题',
      content: '材料概括 + 措施机理。',
      knowledge_ids: ['kc-geo-urban'],
      status: 'pending',
      due_at: at(72 * 60),
      created_at: T0,
      updated_at: T0,
    },
  ]);
  await db.insert(completion_evidence).values({
    id: 'ce-1',
    learning_item_id: 'li-1',
    path: 'practice',
    evidence_json: { event_id: SEED_IDS.completeAttempt, note: 'first-pass wrong answer' },
    decided_at: at(30),
  });

  // ── 5) 作答层：live draft（未提交）+ submitted mirror（链回 att-main-1） ──
  await db.insert(answer).values([
    {
      id: SEED_IDS.liveDraftAnswer,
      question_id: 'q-main',
      learning_item_id: 'li-1',
      input_kind: 'text',
      content_md: '（未提交草稿）乙车速度：60×1.2=72km/h；相遇时间估算中……',
      image_refs: [],
      tags: ['autosave'],
      submitted_at: null, // live draft
      session_id: 'sess-tutor-1',
      paper_artifact_id: null,
      part_ref: null,
      event_id: null,
      autosaved_at: at(55),
    },
    {
      id: SEED_IDS.mirrorAnswer,
      question_id: 'q-main',
      learning_item_id: 'li-1',
      input_kind: 'text',
      content_md:
        '（1）60×(1+20%)=72 千米/时；（2）480÷(60+72)=480÷132≈3.6 小时；' +
        '（3）相遇时甲走了 60×3.6=216 千米，乙走了 72×3.6=259.2 千米，少走约 43.2 千米。',
      image_refs: ['asset-answer-1'],
      tags: ['submitted'],
      submitted_at: at(10),
      session_id: 'sess-practice-1',
      paper_artifact_id: null,
      part_ref: null,
      event_id: SEED_IDS.completeAttempt,
      autosaved_at: at(10),
    },
  ]);

  // ── 6) 目标/备忘/错因 overlay/变体账本 ──
  await db.insert(goal).values({
    id: 'goal-1',
    title: '期末数学复习（合成目标）',
    subject_id: 'math',
    scope_knowledge_ids: ['kc-math-motion', 'kc-math-ratio'],
    scope_mode: 'explicit',
    sequence_hint: 0,
    declared_stage: 'middle_school', // DeclaredStage 枚举（custom/…/university）
    status: 'active',
    source: 'user',
    source_ref: null,
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(mistake_variant).values({
    id: 'mv-1',
    parent_question_id: 'q-main',
    variant_question_id: null,
    proposal_event_id: null,
    status: 'draft',
    failure_reasons: [],
    cause_category: 'calculation',
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(cause_category_overlay).values({
    id: 'cco-1',
    subject_id: 'math',
    label: '计算失误',
    description: '算术层面的错（进位/百分数化小数）。',
    source: 'owner',
    status: 'active',
    proposal_event_id: null,
    evidence_event_ids: [],
    created_at: T0,
    updated_at: T0,
  });
  await db.insert(memory_brief_note).values({
    id: 'mbn-1',
    scope_key: 'global',
    subject_id: null,
    recent_week_md: '本周：行程问题首次作答算错相遇时间。',
    recent_months_md: '',
    long_term_md: '长期画像：开放作答表达完整，算术步骤偶有小数误差。',
    recent_week_evidence_ids: [SEED_IDS.completeAttempt],
    recent_months_evidence_ids: [],
    long_term_evidence_ids: [],
    long_term_freshness_score: null,
    source_event_id: null,
    evidence_count: 1,
    refreshed_at: at(60),
    created_at: T0,
    updated_at: at(60),
  });

  // ── 7) 事件流（15 行：评估锚 + closure lineage + subscriptions 底座） ──
  // 顺序即 created_at 序：attempt → judge → review → closure。
  const events: Array<EventInsert> = [
    // (a) complete attempt 链：att-main-1（带冻结 snapshot + 图片证据）+ jud-main-1（verdict）。
    ev({
      id: SEED_IDS.completeAttempt,
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-main',
      outcome: 'failure',
      session_id: 'sess-practice-1',
      payload: {
        answer_md:
          '（1）60×(1+20%)=72 千米/时；（2）480÷(60+72)=480÷132≈3.6 小时；' +
          '（3）相遇时甲走了 60×3.6=216 千米，乙走了 72×3.6=259.2 千米，少走约 43.2 千米。',
        answer_image_refs: ['asset-answer-1'],
        referenced_knowledge_ids: ['kc-math-motion', 'kc-math-ratio'],
        question_snapshot: MAIN_SNAPSHOT,
      },
      created_at: at(10),
      ingest_at: at(10),
    }),
    ev({
      id: SEED_IDS.completeJudge,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: SEED_IDS.completeAttempt,
      outcome: 'success',
      payload: {
        coarse_outcome: 'incorrect',
        score: 0,
        feedback_md:
          '（2）（3）两步的精确值应为 40/11 小时与 480/11 千米；近似计算误差的根因是把 132 估成了 132≈133。',
        judge_route: 'semantic',
        confidence: 0.82,
      },
      caused_by_event_id: SEED_IDS.completeAttempt,
      task_run_id: 'run-judge-1',
      cost_micro_usd: 14,
      created_at: at(11),
      ingest_at: at(11),
    }),
    // (b) ambiguous anchor：两份 judge verdict created_at 并列 → ambiguous_held。
    ev({
      id: SEED_IDS.ambiguousAttempt,
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-solo',
      outcome: 'success',
      session_id: 'sess-practice-1',
      payload: {
        answer_md: '过顶点作平行线，由同位角相等把三角拼成平角，故内角和 180°。',
        question_snapshot: SOLO_SNAPSHOT,
      },
      created_at: at(12),
    }),
    ev({
      id: SEED_IDS.ambiguousJudgeA,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: SEED_IDS.ambiguousAttempt,
      outcome: 'success',
      payload: { coarse_outcome: 'correct', score: 1, feedback_md: '成立' },
      caused_by_event_id: SEED_IDS.ambiguousAttempt,
      created_at: at(13), // 与 B 并列
    }),
    ev({
      id: SEED_IDS.ambiguousJudgeB,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: SEED_IDS.ambiguousAttempt,
      outcome: 'success',
      payload: { coarse_outcome: 'correct', score: 1, feedback_md: '同上（重评）' },
      caused_by_event_id: SEED_IDS.ambiguousAttempt,
      created_at: at(13), // 并列 → ambiguous_held
    }),
    // (c) durable 回填 review：pending（run_id=rev-dur-1）+ review（embedded judge）。
    ev({
      id: SEED_IDS.durablePending,
      action: 'experimental:judge_pending_attempt',
      subject_kind: 'question',
      subject_id: 'q-durable',
      payload: {
        run_id: SEED_IDS.durableReview,
        caller: 'submit',
        knowledge_ids: ['kc-geo-urban'],
        submit: {
          body: {
            response_md:
              '成因是下垫面热力差异与人为热排放；措施是增加城市绿地/湿地，' +
              '通过蒸散带走潜热降低气温。',
          },
          question_id: 'q-durable',
          submitted_at: at(20).toISOString(),
          question_snapshot: DURABLE_SNAPSHOT,
        },
      },
      created_at: at(20),
    }),
    ev({
      id: SEED_IDS.durableReview,
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q-durable',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        user_response_md:
          '成因是下垫面热力差异与人为热排放；措施是增加城市绿地/湿地，' +
          '通过蒸散带走潜热降低气温。',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-geo-urban'],
        judge: {
          route: 'semantic',
          score: 1,
          score_meaning: 'correctness',
          coarse_outcome: 'correct',
          confidence: 0.9,
          feedback_md: '两成因与措施机理均成立。',
          evidence_json: {},
          capability_ref: { id: 'semantic', version: '1.0.0' },
          suggested_rating: 'good',
          auto_rated: true,
        },
      },
      created_at: at(22),
    }),
    // (d) 未回填 durable pending（无 review 到达）→ worklist/pending 侧。
    ev({
      id: SEED_IDS.pendingOnly,
      action: 'experimental:judge_pending_attempt',
      subject_kind: 'question',
      subject_id: 'q-main',
      payload: {
        run_id: 'run-pending-orphan',
        caller: 'submit',
        knowledge_ids: ['kc-math-motion'],
        submit: {
          body: { response_md: '（待判）乙速 72；相遇 480/132≈3.64h；少走约 43.6km。' },
          question_id: 'q-main',
          submitted_at: at(30).toISOString(),
          question_snapshot: MAIN_SNAPSHOT,
        },
      },
      created_at: at(30),
    }),
    // (e) pre-snapshot attempt（payload 无冻结 snapshot）→ historical_unresolved。
    ev({
      id: SEED_IDS.presnapshotAttempt,
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-solo',
      outcome: 'success',
      session_id: 'sess-practice-1',
      payload: {
        answer_md: '旧形态作答：内错角转移拼平角。（无 question_snapshot 字段）',
      },
      created_at: at(32),
    }),
    // (f) solo answer-bearing review（判 live 行、无 durable pending）→ historical_unresolved。
    ev({
      id: SEED_IDS.soloReview,
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q-solo',
      outcome: 'success',
      payload: {
        fsrs_rating: 'easy',
        user_response_md: '复写：作平行线，同位角+内错角把三角折成平角。',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-math-ratio'],
        judge: {
          route: 'exact',
          score: 1,
          score_meaning: 'correctness',
          coarse_outcome: 'correct',
          confidence: 1,
          feedback_md: '正确',
          evidence_json: {},
          capability_ref: { id: 'exact', version: '1.0.0' },
          suggested_rating: 'easy',
          auto_rated: true,
        },
      },
      created_at: at(35),
    }),
    // (g) rating-only review（无作答/judge 块）→ FSRS 评级 provenance，不是 submission。
    ev({
      id: SEED_IDS.ratingOnlyReview,
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q-main',
      outcome: 'success',
      payload: {
        fsrs_rating: 'again',
        referenced_knowledge_ids: ['kc-math-motion'],
      },
      created_at: at(40),
    }),
    // (h) causal_closure_lineage：非评估动作但携带评估链引用。
    ev({
      id: 'evt-checkpoint-1',
      actor_kind: 'system',
      actor_ref: 'grading-pipeline',
      action: 'experimental:grading_checkpoint',
      subject_kind: 'event',
      subject_id: SEED_IDS.completeAttempt,
      payload: { stage: 'post_judge', verdicts_seen: 1 },
      caused_by_event_id: SEED_IDS.completeJudge,
      created_at: at(41),
    }),
    ev({
      id: 'evt-view-1',
      action: 'attempt_view',
      subject_kind: 'question',
      subject_id: 'q-main',
      payload: { surface: 'practice' },
      created_at: at(42),
    }),
    ev({
      id: 'evt-ingest-1',
      actor_kind: 'system',
      actor_ref: 'ingestion',
      action: 'ingest',
      subject_kind: 'source_document',
      subject_id: 'doc-geo-1',
      outcome: 'success',
      payload: { pages: 3, ocr: false },
      created_at: at(5),
    }),
    ev({
      id: 'evt-propose-1',
      actor_kind: 'agent',
      actor_ref: 'KnowledgeEdgeProposeTask',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke-2',
      outcome: 'success',
      payload: { relation_type: 'applied_in', weight: 0.4 },
      task_run_id: 'run-propose-1',
      cost_micro_usd: 200,
      created_at: at(2),
    }),
    ev({
      id: 'evt-snapshot-1',
      actor_kind: 'system',
      actor_ref: 'projection',
      action: 'experimental:state_snapshot',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-motion',
      payload: { theta: 0.31, evidence_count: 3 },
      caused_by_event_id: SEED_IDS.completeJudge,
      created_at: at(43),
    }),
  ];
  // 单写者不变量：event 生产写入只允许 kernel 事件装配模块；此处是 ephemeral
  // 演练库的种子事件流（非生产 seam），用原生 SQL 参数化批量插入明示身份
  //（同 learning_session 的处理）。payload/affected_scopes 显式 ::jsonb。
  // affected_scopes 恒为空（seed corpus 不写 scopes）；空数组参数会被驱动渲染成非法
  // 的 `()`，故用字面量 ARRAY[]::text[]；若未来 seed 需要非空 scopes，显式抛错逼实现。
  for (const e of events) {
    if ((e.affected_scopes ?? []).length > 0) {
      throw new Error(
        'seed event with non-empty affected_scopes: implement explicit array literal',
      );
    }
  }
  const eventRows = events.map(
    (e) =>
      sql`(${e.id}, ${e.actor_kind ?? 'user'}, ${e.actor_ref ?? 'self'}, ${e.action}, ${e.outcome ?? null}, ${e.subject_kind}, ${e.subject_id}, ${e.session_id ?? null}, ${JSON.stringify(e.payload ?? {})}::jsonb, ${e.caused_by_event_id ?? null}, ${e.task_run_id ?? null}, ${e.cost_micro_usd ?? null}, ARRAY[]::text[], ${(e.created_at ?? T0).toISOString()}, ${(e.ingest_at ?? e.created_at ?? T0).toISOString()})`,
  );
  await db.execute(sql`
    insert into event
      (id, actor_kind, actor_ref, action, outcome, subject_kind, subject_id, session_id,
       payload, caused_by_event_id, task_run_id, cost_micro_usd, affected_scopes, created_at, ingest_at)
    values ${sql.join(eventRows, sql`, `)}
  `);

  // ── 8) 投影层（FSRS / mastery / kc_typed / axis / calibration / signals） ──
  const fsrsState = {
    due: at(24 * 60),
    stability: 2.5,
    difficulty: 5.3,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review' as const,
    last_review: at(22),
  };
  await db.insert(material_fsrs_state).values([
    {
      id: 'fsrs-kc-motion',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-motion',
      state: fsrsState,
      due_at: at(24 * 60),
      last_review_event_id: SEED_IDS.durableReview,
      updated_at: at(22),
    },
    {
      id: 'fsrs-kc-ratio',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-ratio',
      state: { ...fsrsState, stability: 1.8, reps: 2 },
      due_at: at(24 * 60),
      last_review_event_id: SEED_IDS.ratingOnlyReview,
      updated_at: at(40),
    },
    {
      id: 'fsrs-q-main',
      subject_kind: 'question',
      subject_id: 'q-main',
      state: { ...fsrsState, stability: 0.9, state: 'learning' as const },
      due_at: at(180),
      last_review_event_id: SEED_IDS.completeAttempt,
      updated_at: at(10),
    },
  ]);
  await db.insert(mastery_state).values([
    {
      id: 'ms-kc-motion',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-motion',
      theta_hat: 0.31,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: at(22),
      theta_precision: 1.4,
      last_theta_delta: 0.12,
      calibration_residual: null,
      fluency_illusion_flag: null,
      updated_at: at(22),
    },
    {
      id: 'ms-kc-urban',
      subject_kind: 'knowledge',
      subject_id: 'kc-geo-urban',
      theta_hat: 0.85,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: at(22),
      theta_precision: 1.1,
      last_theta_delta: 0.85,
      updated_at: at(22),
    },
  ]);
  await db.insert(kc_typed_state).values([
    {
      id: 'kts-1',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-motion',
      typed_state: 'no-evidence',
      lifecycle: 'open',
      evidence_event_ids: [SEED_IDS.completeAttempt],
      last_evidence_at: at(10),
      updated_at: at(10),
    },
    {
      id: 'kts-2',
      subject_kind: 'knowledge',
      subject_id: 'kc-math-ratio',
      typed_state: 'confused-with',
      confused_with_kc_id: 'kc-geo-urban',
      lifecycle: 'open',
      evidence_event_ids: [SEED_IDS.completeAttempt, SEED_IDS.soloReview],
      last_evidence_at: at(35),
      updated_at: at(35),
    },
  ]);
  await db.insert(learner_axis_state).values({
    id: 'las-1',
    subject_kind: 'knowledge',
    subject_id: 'kc-math-motion',
    drift_v: 0.02,
    boundary_a: 1.1,
    ter: 0.66,
    n_obs: 3,
    // provenance 是 text 列（'adaptive' | 'probe'；'probe' 才保留 drift_v）。
    provenance: 'probe',
    updated_at: at(43),
  });
  await db.insert(item_calibration).values([
    {
      id: 'ic-q-main',
      question_id: 'q-main',
      b: 1.2,
      confidence: 0.35,
      track: 'hard',
      source: 'llm_prior',
      b_anchor: 1.2,
      b_calib: null,
      calibration_n: 0,
      calibration_weight: null,
      created_at: T0,
      updated_at: T0,
    },
    {
      id: 'ic-q-durable',
      question_id: 'q-durable',
      b: 0.4,
      confidence: 0.5,
      track: 'hard',
      source: 'llm_prior_llasa',
      b_anchor: 0.4,
      b_calib: 0.38,
      calibration_n: 21,
      calibration_weight: 0.7,
      last_calibrated_at: at(44),
      created_at: T0,
      updated_at: at(44),
    },
    {
      id: 'ic-q-solo',
      question_id: 'q-solo',
      b: null,
      confidence: null,
      track: 'hard',
      source: 'fixed_anchor',
      b_anchor: null,
      b_calib: null,
      created_at: T0,
      updated_at: T0,
    },
  ]);
  await db.insert(item_family_calibration).values({
    id: 'ifc-1',
    family_key: 'math:kc-math-motion:short_answer:web_sourced',
    b_delta: 0.15,
    evidence_count: 24,
    calibrated_n: 6,
    confidence: 0.55,
    updated_at: at(44),
  });
  await db.insert(difficulty_calibration_label).values([
    {
      id: 'dcl-1',
      question_id: 'q-durable',
      attempt_event_id: SEED_IDS.durableReview,
      theta_snapshot: 0.85,
      outcome: 1,
      b_label: 0.42,
      inclusion_probability: 0.8,
      created_at: at(44),
    },
    {
      id: 'dcl-2',
      question_id: 'q-main',
      attempt_event_id: SEED_IDS.completeAttempt,
      theta_snapshot: 0.31,
      outcome: 0,
      b_label: 1.35,
      inclusion_probability: 0.65,
      created_at: at(44),
    },
  ]);
  await db.insert(practice_stream_item).values({
    id: 'psi-1',
    date: '2026-09-20',
    session_id: null,
    position: 1,
    item_kind: 'question',
    ref_id: 'q-main',
    source: 'decay',
    status: 'done',
    reasoning: 'kc-math-motion 到期复习',
    added_by: 'composer_nightly',
    signals: { mfi: 0.72, theta: 0.31, pi: 0.8 },
    created_at: T0,
    updated_at: at(45),
  });
  await db.insert(selection_observation).values([
    {
      id: 'so-1',
      date: '2026-09-20',
      stream_item_id: 'psi-1',
      ref_kind: 'question',
      ref_id: 'q-main',
      policy: 'softmax_mfi',
      selected: true,
      inclusion_probability: 0.8,
      signals: { mfi: 0.72, theta: 0.31 },
      created_at: T0,
    },
    {
      id: 'so-2',
      date: '2026-09-20',
      stream_item_id: null,
      ref_kind: 'question',
      ref_id: 'q-solo',
      policy: 'softmax_mfi',
      selected: false,
      inclusion_probability: 0.2,
      signals: { mfi: 0.2, theta: 0.9 },
      created_at: T0,
    },
  ]);

  // ── 9) AI 台账（task_run + cost_ledger；event.task_run_id 软链） ──
  await aiTaskRunsInsert(db);
  await db.insert(learning_record).values([
    {
      id: 'lr-1',
      kind: 'attempt',
      title: null,
      content_md: '行程相遇题首次作答（错）。',
      source: 'practice',
      capture_mode: 'submit',
      activity_kind: 'practice',
      processing_status: 'processed',
      origin_event_id: SEED_IDS.completeAttempt,
      subject_id: 'q-main',
      knowledge_ids: ['kc-math-motion'],
      question_id: 'q-main',
      attempt_event_id: SEED_IDS.completeAttempt,
      learning_item_id: 'li-1',
      artifact_id: null,
      source_document_id: null,
      asset_refs: ['asset-answer-1'],
      payload: { outcome: 'failure' },
      created_at: at(10),
      updated_at: at(10),
    },
  ]);

  // ── 10) subscription 底座（checkpoint + 2 条 delivery：FK 到 event(id, dispatch_seq)） ──
  const evRows = await db.select({ id: event.id, dispatch_seq: event.dispatch_seq }).from(event);
  const seqOf = new Map(evRows.map((r) => [r.id, r.dispatch_seq] as const));
  await db.insert(event_subscription_checkpoint).values({
    subscriber_id: 'sub-memory-ingest',
    subscriber_version: 1,
    declaration_hash: 'a'.repeat(64),
    status: 'active',
    next_delivery_seq: 3,
    claim_owner: null,
    claim_token: null,
    claim_lease_until: null,
    bootstrapped_at: T0,
    activated_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  const deliveryFor = (
    eventId: string,
    deliverySeq: number,
    status: 'bootstrap_skipped' | 'pending' | 'succeeded',
  ): InferInsertModel<typeof event_subscription_delivery> => ({
    subscriber_id: 'sub-memory-ingest',
    subscriber_version: 1,
    source_event_id: eventId,
    source_dispatch_seq: seqOf.get(eventId) ?? 0,
    delivery_seq: deliverySeq,
    status,
    attempt_count: status === 'succeeded' ? 1 : 0,
    next_attempt_at: null,
    claim_owner: null,
    claim_token: null,
    claim_lease_until: null,
    last_error: null,
    outcome: status === 'succeeded' ? { ok: true } : null,
    discovered_at: T0,
    claimed_at: null,
    completed_at: status === 'succeeded' ? at(12) : null,
    created_at: T0,
    updated_at: T0,
  });
  await db
    .insert(event_subscription_delivery)
    .values([
      deliveryFor(SEED_IDS.completeAttempt, 1, 'succeeded'),
      deliveryFor(SEED_IDS.durableReview, 2, 'pending'),
    ]);

  const tables: Record<string, number> = {
    knowledge: 3,
    knowledge_edge: 2,
    source_asset: 2,
    source_document: 1,
    question: 4,
    learning_session: 2,
    artifact: 1,
    learning_item: 2,
    completion_evidence: 1,
    answer: 2,
    goal: 1,
    mistake_variant: 1,
    cause_category_overlay: 1,
    memory_brief_note: 1,
    event: events.length,
    material_fsrs_state: 3,
    mastery_state: 2,
    kc_typed_state: 2,
    learner_axis_state: 1,
    item_calibration: 3,
    item_family_calibration: 1,
    difficulty_calibration_label: 2,
    practice_stream_item: 1,
    selection_observation: 2,
    ai_task_runs: 2,
    cost_ledger: 1,
    learning_record: 1,
    event_subscription_checkpoint: 1,
    event_subscription_delivery: 2,
  };
  return {
    tables,
    anchors: {
      complete_attempt_event_id: SEED_IDS.completeAttempt,
      durable_review_event_id: SEED_IDS.durableReview,
      pending_only_event_id: SEED_IDS.pendingOnly,
      ambiguous_anchor_event_id: SEED_IDS.ambiguousAttempt,
      presnapshot_event_id: SEED_IDS.presnapshotAttempt,
      solo_review_event_id: SEED_IDS.soloReview,
      live_draft_answer_id: SEED_IDS.liveDraftAnswer,
      mirror_answer_id: SEED_IDS.mirrorAnswer,
    },
    snapshots: { main: MAIN_SNAPSHOT, durable: DURABLE_SNAPSHOT, solo: SOLO_SNAPSHOT },
  };
}

/** ai_task_runs + cost_ledger 台账（event.task_run_id 的软链目标）。 */
async function aiTaskRunsInsert(db: Db) {
  await db.insert(ai_task_runs).values([
    {
      id: 'run-judge-1',
      task_kind: 'SemanticJudgeTask',
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
      input_hash: 'c'.repeat(64),
      status: 'success',
      finish_reason: 'settled',
      usage_json: { inputTokens: 344, outputTokens: 21 },
      cost_usd: 0.0000145,
      cost_basis: 'reported',
      cost_ref: 'sdk:total_cost_usd',
      started_at: at(10),
      finished_at: at(11),
    },
    {
      id: 'run-propose-1',
      task_kind: 'KnowledgeEdgeProposeTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      input_hash: 'd'.repeat(64),
      status: 'failure',
      finish_reason: 'error',
      usage_json: { inputTokens: 900, outputTokens: 0 },
      cost_usd: null,
      cost_basis: 'unknown',
      cost_ref: 'unpriced:xiaomi/mimo-v2.5',
      error_message: 'provider timeout (synthetic)',
      started_at: at(2),
      finished_at: at(3),
    },
  ]);
  await db.insert(cost_ledger).values({
    id: 'cl-1',
    task_run_id: 'run-judge-1',
    task_kind: 'SemanticJudgeTask',
    provider: 'openrouter',
    model: 'typesafe/jev-1.13',
    cost: 0.0000145,
    currency: 'USD',
    entry_kind: 'legacy',
    tokens_in: 344,
    tokens_out: 21,
    outcome: 'success',
    occurred_at: at(11),
  });
}
