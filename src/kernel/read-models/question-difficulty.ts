// Complete difficulty reads for attempt transactions, candidate collection and supply scans.
// Callers keep their original read timing; this module owns hard anchors, family identity,
// family snapshots and source quality. It never opens a transaction or selects a default DB.

import { and, eq, inArray } from 'drizzle-orm';
import { DIFFICULTY_PROXY_WEIGHT, difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, item_family_calibration } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { batchResolveEffectiveDomains, getEffectiveDomain } from './knowledge-tree';

type DbLike = Db | Tx;

export interface ItemCalibrationBRow {
  b: number | null;
  b_anchor: number | null;
  b_calib: number | null;
  /** YUK-439 后验均值（优先于锚；无证据时 = b_anchor）。可选：未迁移读面缺省 undefined。 */
  b_post?: number | null;
}

/** b_post ?? b_anchor ?? b。三者皆 null（冷启无锚）→ null。b_calib 不再入链（YUK-439）。 */
export function effectiveB(row: ItemCalibrationBRow | null | undefined): number | null {
  if (row == null) return null;
  return row.b_post ?? row.b_anchor ?? row.b ?? null;
}

export interface FamilyCalibrationRow {
  family_key: string;
  b_delta: number;
  evidence_count: number;
  confidence: number;
  /**
   * Residuals actually folded into the running mean (0 until both gates pass). Distinct
   * from evidence_count; see schema.ts item_family_calibration.calibrated_n.
   */
  calibrated_n: number;
}

/**
 * Effective b after the family adjustment. b_delta is already shrunk, so an ungated family
 * contributes exactly 0; live callers apply this after resolving the columnar anchor.
 */
export function effectiveFamilyB(bAnchor: number, familyRow: FamilyCalibrationRow | null): number {
  if (familyRow === null) return bAnchor;
  return bAnchor + familyRow.b_delta;
}

/** Family calibration row, or null when cold. */
export async function getFamilyCalibration(
  db: DbLike,
  key: string,
): Promise<FamilyCalibrationRow | null> {
  const rows = await db
    .select({
      family_key: item_family_calibration.family_key,
      b_delta: item_family_calibration.b_delta,
      evidence_count: item_family_calibration.evidence_count,
      confidence: item_family_calibration.confidence,
      calibrated_n: item_family_calibration.calibrated_n,
    })
    .from(item_family_calibration)
    .where(eq(item_family_calibration.family_key, key))
    .limit(1);
  return rows[0] ?? null;
}

export function buildFamilyKey(
  subject: string,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): string {
  return `${subject}:${primaryKnowledgeId}:${kind}:${source}`;
}

export interface FamilyKeyInput {
  /** 题目的主 knowledge_id（q.knowledge_ids[0]）。空 → 无法成键 → null。 */
  primaryKnowledgeId: string | null | undefined;
  /** question.kind。 */
  kind: string | null | undefined;
  /** question.source。 */
  source: string | null | undefined;
}

/**
 * family_key for one question, or null when primaryKnowledgeId/kind/source is missing.
 * Application-level missing/root/depth errors become 'unknown', never a default subject.
 * The catch only covers domain/subject derivation. A real PG error still aborts a caller's
 * transaction; no savepoint or recovery is introduced before the later family/mastery reads.
 */
export async function resolveFamilyKeyForQuestion(
  db: DbLike,
  input: FamilyKeyInput,
): Promise<string | null> {
  const primaryKnowledgeId = input.primaryKnowledgeId?.trim();
  if (!primaryKnowledgeId || !input.kind || !input.source) return null;

  let subject = 'unknown';
  try {
    const domain = await getEffectiveDomain(db, primaryKnowledgeId);
    subject = resolveKnownSubjectId(domain) ?? 'unknown';
  } catch {
    subject = 'unknown';
  }

  return buildFamilyKey(subject, primaryKnowledgeId, input.kind, input.source);
}

/**
 * Batch variant. Derives each subject once from a single full-tree read instead of one
 * DB climb per candidate; missing kind/source/primaryKnowledgeId still yields null.
 */
export async function batchResolveFamilyKeys(
  db: DbLike,
  items: Array<{ questionId: string } & FamilyKeyInput>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;

  // Reuse getEffectiveDomain's canonical batch twin so archived-inclusive traversal and the
  // MAX_DEPTH boundary stay identical to the single-question path (YUK-722).
  const primaryKnowledgeIds = items.flatMap((item) => {
    const id = item.primaryKnowledgeId?.trim();
    return id && item.kind && item.source ? [id] : [];
  });
  const domainByKid = await batchResolveEffectiveDomains(db, primaryKnowledgeIds);

  // Questions of the same KC share one subject lookup.
  const subjectByKid = new Map<string, string>();

  for (const item of items) {
    const primaryKnowledgeId = item.primaryKnowledgeId?.trim();
    if (!primaryKnowledgeId || !item.kind || !item.source) {
      out.set(item.questionId, null);
      continue;
    }
    let subject = subjectByKid.get(primaryKnowledgeId);
    if (subject === undefined) {
      const domain = domainByKid.get(primaryKnowledgeId) ?? null;
      subject = resolveKnownSubjectId(domain) ?? 'unknown';
      subjectByKid.set(primaryKnowledgeId, subject);
    }
    out.set(item.questionId, buildFamilyKey(subject, primaryKnowledgeId, item.kind, item.source));
  }

  return out;
}

/** Read the hard columnar anchor at the caller's current DB/Tx point. */
async function readColumnarB(db: DbLike, questionId: string): Promise<number | null> {
  const rows = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
      b_post: item_calibration.b_post,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return effectiveB(rows[0]);
}

export interface AttemptDifficultyInput {
  questionId: string;
  difficulty: number;
  kind?: string;
  source?: string;
  familyPrimaryKnowledgeId?: string | null;
  /** Already normalized by the attempt writer, in its original order. */
  knowledgeIds: string[];
}

/**
 * After the attempt writer's locks: hard anchor → proxy/source weight → single family read.
 * Family lookup uses frozen question metadata, never a fresh question or paper-slot primary.
 * Family delta is already shrunk and does not change the columnar source's weight.
 */
export async function readAttemptDifficulty(
  tx: Tx,
  input: AttemptDifficultyInput,
): Promise<{ b: number; bWeight: number }> {
  const calB = await readColumnarB(tx, input.questionId);
  const columnarB = calB ?? difficultyToLogitB(input.difficulty);
  const bWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;
  let b = columnarB;
  if (input.kind && input.source) {
    // Nullish fallback preserves an explicit empty canonical primary (no family).
    const key = await resolveFamilyKeyForQuestion(tx, {
      primaryKnowledgeId: input.familyPrimaryKnowledgeId ?? input.knowledgeIds[0],
      kind: input.kind,
      source: input.source,
    });
    if (key !== null) b = effectiveFamilyB(columnarB, await getFamilyCalibration(tx, key));
  }
  return { b, bWeight };
}

export type BSource = 'item_calibration' | 'difficulty_proxy' | 'none';

export interface CandidateDifficultyRead {
  read(
    questionId: string,
    difficulty: number | undefined,
  ): Promise<{ b?: number; bSource: BSource }>;
}

/**
 * Capture family rows before mastery/recurrence reads, then read each hard item only when
 * its candidate is processed. This object belongs to one collect call, never a shared cache.
 * Duplicate question ids retain the last family input while every read still queries hard b.
 * Batch domain errors propagate; only the single-key operation has an unknown fallback.
 */
export async function prepareCandidateDifficultyRead(
  db: DbLike,
  familyInputs: Array<{ questionId: string } & FamilyKeyInput>,
): Promise<CandidateDifficultyRead> {
  const familyKeyByRefId = await batchResolveFamilyKeys(db, familyInputs);
  const distinctKeys = Array.from(
    new Set(Array.from(familyKeyByRefId.values()).filter((k): k is string => k !== null)),
  );
  const familyRowByKey = new Map<string, FamilyCalibrationRow>();
  if (distinctKeys.length > 0) {
    const rows = await db
      .select({
        family_key: item_family_calibration.family_key,
        b_delta: item_family_calibration.b_delta,
        evidence_count: item_family_calibration.evidence_count,
        confidence: item_family_calibration.confidence,
        calibrated_n: item_family_calibration.calibrated_n,
      })
      .from(item_family_calibration)
      .where(inArray(item_family_calibration.family_key, distinctKeys));
    for (const r of rows) familyRowByKey.set(r.family_key, r);
  }

  return {
    async read(questionId, difficulty) {
      const calB = await readColumnarB(db, questionId);
      let b: number | undefined;
      let bSource: BSource;
      if (calB !== null) {
        b = calB;
        bSource = 'item_calibration';
      } else if (difficulty !== undefined) {
        b = difficultyToLogitB(difficulty);
        bSource = 'difficulty_proxy';
      } else {
        return { b: undefined, bSource: 'none' };
      }
      const key = familyKeyByRefId.get(questionId) ?? null;
      const familyRow = key !== null ? (familyRowByKey.get(key) ?? null) : null;
      return { b: effectiveFamilyB(b, familyRow), bSource };
    },
  };
}

/** Reliable hard columnar anchors only: no family, tree lookup, proxy or zero filling. */
export async function readHardCalibrationBs(
  db: DbLike,
  questionIds: string[],
): Promise<Map<string, number | null>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      question_id: item_calibration.question_id,
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
      b_post: item_calibration.b_post,
    })
    .from(item_calibration)
    .where(
      and(inArray(item_calibration.question_id, questionIds), eq(item_calibration.track, 'hard')),
    );
  return new Map(rows.map((row) => [row.question_id, effectiveB(row)]));
}
