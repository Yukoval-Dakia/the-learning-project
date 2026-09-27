// ====================================================================
// YUK-1057 — post-cutover 新写入 + roll-forward delta 导出/回放/对账
// ====================================================================
//
// rollback 边界（b）（grounding §16）：新写入之后若必须回退，没有无损
// image rollback —— 路径是【导出全部新写入 → 独立 target restore → 回放
// 导出 → 可证明的对账】。本模块是那条链路的实现：
//
//   simulatePostCutoverWrites(db)
//     走【真实 writer seam】（publishQuestionGroup → issueAssessment →
//     saveResponseDraft → saveSubmission + 手工 event）—— 不是裸 insert；
//     返回 PostWriteHandle（生成 id + 事件水位标）。
//   exportPostWriteDelta(db, mark)
//     把 post-mark 的新写入按 FK_ORDER 相关表导出（行级 canonical JSON）；
//     事件表按 dispatch_seq 水位切片（schema.ts 注释：不是完整性证明 —
//     这里仅作演练 delta 标记，真实 cutover 另有 checkpoint 捕获）。
//   replayPostWriteDelta(db, delta)
//     在 restore 出的独立 target 上按拓扑序回放（幂等 ON CONFLICT DO
//     NOTHING 不适用 —— 目标是 clean restore，直接 insert；冲突即 fail）。
//   reconcileDelta(db, delta)
//     逐行 canonicalHash 对账 + 计数断言。

import { eq, sql } from 'drizzle-orm';
import { issueAssessment, saveResponseDraft, saveSubmission } from '@/capabilities/practice/public';
import { canonicalHash, stableStringify } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import {
  assessment_identity_mapping,
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';

export interface PostWriteHandle {
  question_id: string;
  revision_id: string;
  group_id: string;
  issuance_id: string;
  submission_id: string;
  evaluation_group_id: string;
  /** post-writes 起点的 event.dispatch_seq 水位（delta 切片上界用）。 */
  event_watermark: number;
  writer_summary: Record<string, string>;
}

const PW_NOW = new Date('2026-09-26T10:00:00.000Z');

/** post-cutover 新写入（真实 seam；PW_* id 前缀标记 delta 归属）。 */
export async function simulatePostCutoverWrites(db: Db): Promise<PostWriteHandle> {
  const watermarkRows = await db.execute<{ m: number | null }>(
    sql`select max(dispatch_seq) as m from event`,
  );
  const watermark = Number(watermarkRows[0]?.m ?? 0);

  // 1) 新题发布（生产 publish 路径：normalize → contract → publishQuestionGroup）。
  await db.insert(question).values({
    id: 'q-live',
    kind: 'choice',
    prompt_md: '（演练 live 题）3/4 + 1/6 = ?',
    reference_md: '11/12',
    choices_md: ['11/12', '9/12', '7/6', '4/10'],
    knowledge_ids: ['kc-math-ratio'],
    difficulty: 2,
    source: 'manual',
    variant_depth: 0,
    image_refs: [],
    figures: [],
    // draft_status 显式声明：三态字段 NULL≡active，本写入即「发布 active 题」语义。
    // audit 要求 key 必须显式出现；显式 null 保留 NULL≡active 契约不交字符串。
    draft_status: null,
    created_at: PW_NOW,
    updated_at: PW_NOW,
    version: 0,
  });
  const [row] = await db.select().from(question).where(eq(question.id, 'q-live')).limit(1);
  const normalized = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
  const published = await publishQuestionGroup(db, {
    group_id: normalized.group_id,
    contract: {
      structure: normalized.structure,
      response_spec: normalized.response_spec,
      scoring_basis: normalized.scoring_basis,
      execution_plan: normalized.execution_plan,
      integrity_digest: normalized.integrity_digest,
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
    actorRef: 'rehearsal:postwrite',
    now: PW_NOW,
  });
  if (published.status !== 'published') {
    throw new Error(`post-write publish failed: ${published.status}`);
  }
  const revisionId = published.revision_id;
  const [rev] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  const slot = rev.response_spec.slots[0];
  if (slot.kind !== 'single_choice') {
    throw new Error(`post-write: expected single_choice slot, got ${slot.kind}`);
  }
  const correctOption = slot.options.find((o) => o.text === '11/12');
  if (!correctOption) throw new Error('post-write: correct option missing');

  // 2) 发题 → 草稿 → 提交（真实 seam；draft 随后被 submit 清掉 —— 事件/head 落库）。
  const issued = await issueAssessment(db, {
    group_id: 'q-live',
    issuance_id: 'pw-iss-1',
    actorRef: 'rehearsal:postwrite',
    now: PW_NOW,
  });
  if (issued.status !== 'issued') {
    throw new Error(`post-write issueAssessment failed: ${issued.status}`);
  }
  const responseSet = {
    entries: [
      {
        slot_id: slot.slot_id,
        kind: 'choice' as const,
        option_ids: [correctOption.option_id],
        self_confidence: 4,
      },
    ],
  };
  const draft = await saveResponseDraft(db, {
    issuance_id: 'pw-iss-1',
    response_set: responseSet,
    now: PW_NOW,
  });
  if (draft.status !== 'saved') throw new Error(`post-write draft failed: ${draft.status}`);
  const submitted = await saveSubmission(db, {
    issuance_id: 'pw-iss-1',
    evaluation_group_id: 'pw-eg-1',
    idempotency_key: 'pw-key-1',
    response_set: responseSet,
    submission_id: 'pw-sub-1',
    actorRef: 'rehearsal:postwrite',
    now: PW_NOW,
  });
  if (submitted.status !== 'saved') {
    throw new Error(`post-write saveSubmission failed: ${submitted.status}`);
  }

  // 3) 迁移面新写入：一条新 identity mapping（新合同内的显式断言映射）。
  await db.insert(assessment_identity_mapping).values({
    mapping_id: 'pw-map-1',
    source_kind: 'postwrite_direct',
    source_id: 'pw-src-1',
    source_locator: 'postwrite:pw-src-1',
    original_question_id: 'q-live',
    target_revision_id: revisionId,
    target_part_id: 'p1',
    target_slot_id: slot.slot_id,
    evidence: { rehearsal: true, note: 'post-cutover new write' },
    algorithm_version: 'yuk1057-rehearsal/1.0.0',
    status: 'mapped',
    is_current: true,
    created_at: PW_NOW,
  });

  return {
    question_id: 'q-live',
    revision_id: revisionId,
    group_id: 'q-live',
    issuance_id: 'pw-iss-1',
    submission_id: 'pw-sub-1',
    evaluation_group_id: 'pw-eg-1',
    event_watermark: watermark,
    writer_summary: {
      publish: 'published',
      issue: 'issued',
      draft: 'saved',
      submit: 'saved',
    },
  };
}

// ───────────────────────── delta 导出 ─────────────────────────

export interface PostWriteDelta {
  exported_at: string;
  event_watermark: number;
  /** 表 → 行集（canonical JSON 形态；回放按声明序）。 */
  rows: Record<string, Array<Record<string, unknown>>>;
  /** 行级 digest（对账证明用）。 */
  digests: Record<string, string[]>;
}

/** 导出 post-write 面：PW_* id 前缀行 + q-live 组 + 水位后事件。 */
export async function exportPostWriteDelta(
  db: Db,
  handle: PostWriteHandle,
): Promise<PostWriteDelta> {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  const digests: Record<string, string[]> = {};
  const collect = (table: string, list: Array<Record<string, unknown>>) => {
    rows[table] = list;
    digests[table] = list.map((r) => canonicalHash(r)).sort();
  };

  collect('question', await db.select().from(question).where(eq(question.id, handle.question_id)));
  collect(
    'question_revision',
    await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, handle.group_id)),
  );
  collect(
    'question_group_lifecycle',
    await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, handle.group_id)),
  );
  collect(
    'question_admission_verification',
    await db
      .select()
      .from(question_admission_verification)
      .where(eq(question_admission_verification.revision_id, handle.revision_id)),
  );
  collect(
    'assessment_issuance',
    await db
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, handle.issuance_id)),
  );
  collect(
    'evaluation_group',
    await db
      .select()
      .from(evaluation_group)
      .where(eq(evaluation_group.evaluation_group_id, handle.evaluation_group_id)),
  );
  collect(
    'assessment_submission',
    await db
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, handle.submission_id)),
  );
  collect(
    'assessment_response_draft',
    await db
      .select()
      .from(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, handle.issuance_id)),
  );
  collect(
    'evaluation',
    await db
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_group_id, handle.evaluation_group_id)),
  );
  collect(
    'evaluation_effective_head',
    await db
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, handle.evaluation_group_id)),
  );
  collect(
    'assessment_identity_mapping',
    await db
      .select()
      .from(assessment_identity_mapping)
      .where(eq(assessment_identity_mapping.mapping_id, 'pw-map-1')),
  );
  // post-mark 事件（issue/submit 的 receipt 事件 + 任何伴生写）。
  const newEvents = (await db.execute(
    sql`select * from event where dispatch_seq > ${handle.event_watermark} order by dispatch_seq`,
  )) as Array<Record<string, unknown>>;
  collect('event', newEvents);

  return {
    exported_at: new Date().toISOString(),
    event_watermark: handle.event_watermark,
    rows,
    digests,
  };
}

// ───────────────────────── delta 回放 + 对账 ─────────────────────────

/** 回放拓扑序（FK 父先子后；与 FK_ORDER 的评估簇序一致）。 */
const REPLAY_ORDER = [
  'question',
  'question_revision',
  'question_group_lifecycle',
  'question_admission_verification',
  'assessment_issuance',
  'evaluation_group',
  'assessment_submission',
  'assessment_response_draft',
  'evaluation',
  'evaluation_effective_head',
  'assessment_identity_mapping',
  'event',
] as const;

/**
 * 表列元数据：timestamptz 列名集合（raw `select *` 回 PG 文本形态，
 * drizzle select 回 ISO/Date —— 对账/回放统一按列型归一）。
 */
const timestampColsOf = (table: unknown): Set<string> => {
  const def = table as Record<symbol, unknown>;
  const cols = Object.values(
    (def[Symbol.for('drizzle:Columns')] ?? {}) as Record<string, unknown>,
  ) as Array<{ name: string; dataType: string }>;
  return new Set(
    cols.filter((c) => c.dataType === 'date' || c.dataType === 'local').map((c) => c.name),
  );
};

/** PG 文本形态的 timestamptz（'2026-09-26 10:00:00+00' / '+00:00'）→ Date。 */
const asTimestamp = (v: unknown): unknown => {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return v;
  // PG 文本输出形态：'YYYY-MM-DD HH:MM:SS[.us][+tz| UTC]' —— 空格换 T。
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::\d{2})?|Z)?$/.exec(
    v,
  );
  if (!m) return v;
  let tz = m[3];
  if (tz === undefined || tz === 'Z') {
    tz = 'Z';
  } else if (!tz.includes(':')) {
    // PG 短形 '+00' → ISO '+00:00'（new Date('+00') 不解析 → NaN 原样透传）。
    tz = `${tz}:00`;
  }
  const d = new Date(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(d.getTime()) ? v : d;
};

/**
 * 在 restore 出的 target 上回放 delta。dispatch_seq 显式回放（跳过序列
 * 原值落库后 setval 推进，保证后续写入不撞号）。
 */
const TABLES = {
  question,
  question_revision,
  question_group_lifecycle,
  question_admission_verification,
  assessment_issuance,
  evaluation_group,
  assessment_submission,
  assessment_response_draft,
  evaluation,
  evaluation_effective_head,
  assessment_identity_mapping,
  event,
} as const;

export async function replayPostWriteDelta(db: Db, delta: PostWriteDelta): Promise<void> {
  for (const table of REPLAY_ORDER) {
    const list = delta.rows[table];
    if (!list || list.length === 0) continue;
    // delta rows 源于 drizzle select（timestamptz=Date）或 raw sql select *
    // （timestamptz=PG 文本，如 event 采集列）—— 统一经列元数据归一为
    // driver value（Date 或 ISO string 均可被 pg 解析为 timestamptz）。
    const timestampCols = timestampColsOf(TABLES[table]);
    const normalized = list.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = timestampCols.has(k) ? asTimestamp(v) : v;
      }
      return out;
    });
    await db.insert(TABLES[table]).values(normalized as never[]);
  }
  const maxSeq = (delta.rows.event ?? []).reduce(
    (m, r) => Math.max(m, Number(r.dispatch_seq ?? 0)),
    0,
  );
  if (maxSeq > 0) {
    await db.execute(sql`select setval('event_dispatch_seq', ${maxSeq})`);
  }
}

export interface DeltaReconciliation {
  identical: boolean;
  tables_checked: string[];
  divergences: string[];
}

/** 对账：target 上 delta 行逐条 canonicalHash 回比（缺行/漂移 fail-visible）。 */
export async function reconcilePostWriteDelta(
  db: Db,
  delta: PostWriteDelta,
): Promise<DeltaReconciliation> {
  const divergences: string[] = [];
  const checked: string[] = [];
  const pkOf: Record<string, string> = {
    question: 'id',
    question_revision: 'revision_id',
    question_group_lifecycle: 'group_id',
    question_admission_verification: 'id',
    assessment_issuance: 'issuance_id',
    evaluation_group: 'evaluation_group_id',
    assessment_submission: 'submission_id',
    assessment_response_draft: 'issuance_id',
    evaluation: 'evaluation_id',
    evaluation_effective_head: 'evaluation_group_id',
    assessment_identity_mapping: 'mapping_id',
    event: 'id',
  };
  for (const table of REPLAY_ORDER) {
    const list = delta.rows[table];
    if (!list || list.length === 0) continue;
    checked.push(table);
    const pk = pkOf[table];
    const wanted = new Map(list.map((r) => [String(r[pk]), r] as const));
    const found = (await db.execute(sql.raw(`select * from "${table}"`))) as Array<
      Record<string, unknown>
    >;
    const foundByPk = new Map(
      found.filter((r) => wanted.has(String(r[pk]))).map((r) => [String(r[pk]), r] as const),
    );
    for (const [id, sourceRow] of wanted) {
      const targetRow = foundByPk.get(id);
      if (targetRow === undefined) {
        divergences.push(`${table}.${id}: missing on rollback target`);
        continue;
      }
      // raw `select *` 的驱动类型与 drizzle select 不同：bigint 回 BigInt
      //（drizzle mode:'number' → number），timestamptz 回 PG 文本
      //（drizzle → Date/ISO）。canonicalHash 对二者分别产十进制串/ISO ——
      // 假漂移；比较前统一归一（dispatch_seq 在 Number.MAX_SAFE_INTEGER 内，
      // timestamptz 列按列元数据解析）。
      const tsCols = timestampColsOf(TABLES[table]);
      const normalized = Object.fromEntries(
        Object.entries(targetRow).map(([k, v]) => {
          let out = typeof v === 'bigint' ? Number(v) : v;
          if (tsCols.has(k)) out = asTimestamp(out);
          return [k, out];
        }),
      );
      const srcNorm = Object.fromEntries(
        Object.entries(sourceRow).map(([k, v]) => {
          let out = typeof v === 'bigint' ? Number(v) : v;
          if (tsCols.has(k)) out = asTimestamp(out);
          return [k, out];
        }),
      );
      const a = canonicalHash(normalized);
      const b = canonicalHash(srcNorm);
      if (a !== b) {
        // 逐键定位漂移源（raw 驱动类型差正常化后仍不等 ⇒ 真漂移）。
        const keys = new Set([...Object.keys(normalized), ...Object.keys(srcNorm)]);
        const differing = [...keys]
          .filter((k) => {
            const x =
              normalized[k] instanceof Date ? (normalized[k] as Date).toISOString() : normalized[k];
            const y = srcNorm[k] instanceof Date ? (srcNorm[k] as Date).toISOString() : srcNorm[k];
            return stableStringify(x) !== stableStringify(y);
          })
          .map(
            (k) =>
              `${k}(${JSON.stringify(normalized[k]).slice(0, 60)}≠${JSON.stringify(srcNorm[k]).slice(0, 60)})`,
          );
        divergences.push(
          `${table}.${id}: content drift ${a.slice(0, 12)} vs exported ${b.slice(0, 12)} keys=[${differing.join(',')}]`,
        );
      }
    }
  }
  return { identical: divergences.length === 0, tables_checked: checked, divergences };
}
