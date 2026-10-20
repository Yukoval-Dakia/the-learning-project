// After new writes there is no lossless image rollback.
// Export the new writes, restore an independent target, replay, then reconcile.
// publish, issue, draft, and submit use their real seams.
// The question row and the identity mapping are direct inserts.
// reference_md is display metadata and is not parsed for keys.
// The event.dispatch_seq watermark marks this rehearsal delta. It is not an integrity proof.
// Replay is INSERT. The target is a clean restore, so a conflict fails.

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
import { contractIntegrityDigest } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';

export interface PostWriteHandle {
  question_id: string;
  revision_id: string;
  group_id: string;
  issuance_id: string;
  submission_id: string;
  evaluation_group_id: string;
  /** event.dispatch_seq before the new writes. The delta starts after this. */
  event_watermark: number;
  writer_summary: Record<string, string>;
}

const PW_NOW = new Date('2026-09-26T10:00:00.000Z');

/** Real writer seams. PW_* ids mark rows that belong to the delta. */
export async function simulatePostCutoverWrites(db: Db): Promise<PostWriteHandle> {
  const watermarkRows = await db.execute<{ m: number | null }>(
    sql`select max(dispatch_seq) as m from event`,
  );
  const watermark = Number(watermarkRows[0]?.m ?? 0);

  // Explicit contract. This fixture does not extract an answer key from reference text.
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
    // NULL means active. The key must appear. A string would drop that contract.
    draft_status: null,
    created_at: PW_NOW,
    updated_at: PW_NOW,
    version: 0,
  });
  // The answer key lives only in scoring_basis. reference_md routes nothing.
  const options = [
    { option_id: 'opt_q_live_a', label: 'A', text: '11/12' },
    { option_id: 'opt_q_live_b', label: 'B', text: '9/12' },
    { option_id: 'opt_q_live_c', label: 'C', text: '7/6' },
    { option_id: 'opt_q_live_d', label: 'D', text: '4/10' },
  ];
  const contract = {
    structure: {
      group_id: 'q-live',
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '（演练 live 题）3/4 + 1/6 = ?', material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'single_choice' as const, options }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: ['opt_q_live_a'],
          },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' as const },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic' as const, comparator: 'exact_option_set' as const },
        },
      ],
      escalation: {
        on_unadmitted_model: 'withhold' as const,
        on_low_confidence: 'human_review' as const,
      },
    },
  };
  const published = await publishQuestionGroup(db, {
    group_id: 'q-live',
    contract: { ...contract, integrity_digest: contractIntegrityDigest(contract) },
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
  // Bound to the frozen revision's scoring_basis, not slot text or reference text.
  // The criterion accepts exactly one option, and that option is 11/12.
  const unit = rev.scoring_basis.units[0];
  if (
    unit === undefined ||
    unit.criterion.kind !== 'option_set_key' ||
    unit.criterion.accepted_option_ids.length !== 1
  ) {
    throw new Error('post-write: expected single-answer option_set_key criterion');
  }
  const acceptedOptionId = unit.criterion.accepted_option_ids[0];
  const correctOption = slot.options.find((o) => o.option_id === acceptedOptionId);
  if (correctOption?.text !== '11/12') {
    throw new Error('post-write: correct option missing');
  }

  // Real issue, draft, and submit seams. Submit clears the draft. The event and head stay.
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
        option_ids: [acceptedOptionId],
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

  // Migration-surface write. The delta has to carry it.
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

export interface PostWriteDelta {
  exported_at: string;
  event_watermark: number;
  /** Object key order is not the replay order. */
  rows: Record<string, Array<Record<string, unknown>>>;
  /** Sorted. Row order is not part of the proof. */
  digests: Record<string, string[]>;
}

/** Rows written after cutover, plus events after the watermark. */
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
  // Receipts and any companion writes after the watermark.
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

/** Parents before children. Matches the assessment cluster in FK_ORDER. */
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
 * timestamptz column names. Raw select * returns PG text. Drizzle returns Date.
 * Hashing those two forms false-drifts, so replay and reconcile normalize first.
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

/** PG timestamptz text to Date. A short offset such as '+00' is not valid ISO. */
const asTimestamp = (v: unknown): unknown => {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return v;
  // PG prints a space. Date parses 'T'.
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::\d{2})?|Z)?$/.exec(
    v,
  );
  if (!m) return v;
  let tz = m[3];
  if (tz === undefined || tz === 'Z') {
    tz = 'Z';
  } else if (!tz.includes(':')) {
    // new Date('+00') is NaN. Append ':00' or the value would pass through unparsed.
    tz = `${tz}:00`;
  }
  const d = new Date(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(d.getTime()) ? v : d;
};

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

/**
 * INSERT onto a clean restore. A conflict fails. dispatch_seq is written as stored,
 * then setval advances the sequence so a later write does not collide.
 */
export async function replayPostWriteDelta(db: Db, delta: PostWriteDelta): Promise<void> {
  for (const table of REPLAY_ORDER) {
    const list = delta.rows[table];
    if (!list || list.length === 0) continue;
    // Drizzle rows carry Date. Raw event rows carry PG text. Both must become driver values.
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

/** canonicalHash each delta row against the target. A miss or a drift stays visible. */
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
      // Raw select returns bigint as BigInt and timestamptz as PG text.
      // Drizzle returns number and Date. Hashing those raw forms false-drifts.
      // dispatch_seq is inside Number.MAX_SAFE_INTEGER. Timestamps parse by column type.
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
        // Keys that still differ after that normalization are a real drift.
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
