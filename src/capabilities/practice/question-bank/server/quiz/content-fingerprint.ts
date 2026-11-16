import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { ExecutionPlan, QuestionGroupStructure, ResponseSpec, ScoringBasis, type SelectSlotT } from '@/core/schema/assessment';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import type { ScoringRuleT } from '@/core/schema/assessment/scoring-rule';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import { DraftRubric, type QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { event, knowledge, question, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import {
  draftCanonicalIdentity,
  draftDocumentToContract,
  revisionToDraftDocument,
} from '@/kernel/records/question-draft-contract';
import { enrollAddedKnowledgeScheduling } from '../question-scheduling-enrollment';

// Bumping this version rewrites the canonical string, so every persisted
// `canonical_content_hash` computed under the old version becomes stale and
// old-vs-new duplicate detection silently stops matching. Migration 0067 does no
// backfill, so a version bump MUST be paired with a recompute/backfill plan.
export const CANONICAL_QUESTION_CONTENT_VERSION = 1 as const;

export interface CanonicalQuestionContentInput {
  promptMd: string;
  referenceMd?: string | null;
  choicesMd?: string[] | null;
  rubricJson?: unknown;
  /**
   * shape discriminator for composite (篇) parents. A composite
   * parent's derived prompt_md renders stem + every sub as one blob, so it can
   * be byte-identical to a flat question that happened to carry the same merged
   * text. Without a discriminator the merge branch would treat that flat row as
   * an exact duplicate, skip child materialization, and record a "duplicate
   * success" while poolFetch(compositeParentOnly) still rejects the childless
   * row — the supply gap stays unresolved. Setting `composite: true` puts the
   * composite in its own identity namespace: flat↔flat and composite↔composite
   * dedup are unchanged; flat↔composite can never collide. Callers pass the
   * flag ONLY for composite items — absent keeps the canonical string
   * byte-identical for every pre-existing producer (no hash migration).
   */
  composite?: boolean;
  selectStructure?: unknown[];
  declaredParts?: {
    promptMd: string;
    units: CanonicalQuestionContentInput[];
  }[];
  // Callers may carry provenance envelopes. Identity intentionally reads only the fields above.
  [key: string]: unknown;
}

function normalizeMarkdown(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      // Keep image presence + alt semantics while excluding unstable transport URLs.
      .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, (_match, alt: string) => {
        return `![${alt.trim()}](IMAGE)`;
      })
      // NOTE: underscore-emphasis is deliberately NOT canonicalized. A `_x_`→`*x*` (or `__x__`→`**x**`)
      // rewrite corrupts LaTeX subscripts, which are pervasive in math/physics content: e.g. the real
      // reference answer `$x_1 = 2$，$x_2 = 3$` (src/subjects/math/skills/quiz-gen-calculation/assets/
      // few-shot.json) has the span `_1 = 2$，$x_` rewritten to `*1 = 2$，$x*`, which both mangles the
      // canonical string and collides a genuine subscript with the asterisk emphasis form. Identity
      // safety beats emphasis-equivalence here, so underscore forms are left verbatim. Asterisk forms
      // (`**bold**` / `*italic*`) are already canonical and pass through untouched.
      .replace(/[\t\n\f\r ]+/g, ' ')
      .trim()
  );
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      // Code-unit ordering, NOT localeCompare: locale/ICU-dependent collation would
      // make the canonical hash (a UNIQUE partial index key) non-deterministic across
      // runtimes, breaking dedup and risking spurious unique-constraint violations.
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  // Rubric JSON carries exact-match tokens (keywords, acceptable_answers,
  // final_answer, answer_equivalents, expected_signals). The Markdown pipeline
  // (emphasis rewrite, image stripping, whitespace collapse) would corrupt those,
  // so canonicalize arbitrary JSON strings with Unicode NFKC only.
  return typeof value === 'string' ? value.normalize('NFKC') : value;
}

export function canonicalQuestionContent(input: CanonicalQuestionContentInput): string {
  return JSON.stringify({
    version: CANONICAL_QUESTION_CONTENT_VERSION,
    prompt: normalizeMarkdown(input.promptMd),
    answer: input.referenceMd == null ? null : normalizeMarkdown(input.referenceMd),
    choices: input.choicesMd?.map(normalizeMarkdown) ?? null,
    rubric: input.rubricJson == null ? null : stableJson(input.rubricJson),
    // appended LAST so flat callers (composite absent/false) emit the
    // byte-identical canonical string they always did; only composite:true adds
    // the key (JSON.stringify drops undefined/absent keys).
    ...(input.composite === true ? { composite: true } : {}),
    ...(input.selectStructure != null
      ? { select_structure: stableJson(input.selectStructure) }
      : {}),
    ...(input.declaredParts != null
      ? {
          declared_parts: input.declaredParts.map((part) => ({
            prompt: normalizeMarkdown(part.promptMd),
            units: part.units.map(canonicalQuestionContent),
          })),
        }
      : {}),
  });
}

/** Exact identity SHA-256. This is not the embedding freshness hash. */
export function canonicalQuestionContentHash(input: CanonicalQuestionContentInput): string {
  return createHash('sha256').update(canonicalQuestionContent(input)).digest('hex');
}

/** Fresh sourced candidates share the published document's content policy; flat bytes stay v1. */
export function canonicalSourcedQuestionContentHash(
  input: Pick<SourcedQuestionT, 'prompt_md' | 'reference_md' | 'choices_md' | 'rubric_json'>,
  document: QuestionDraftDocumentT | null,
): string {
  return document != null
    ? canonicalTypedQuestionContentHash(document)
    : canonicalQuestionContentHash({
          promptMd: input.prompt_md,
          referenceMd: input.reference_md,
          choicesMd: input.choices_md,
          rubricJson: input.rubric_json,
      });
}

// Grading keys can deliberately distinguish Unicode and whitespace. Unlike flat v1,
// semantic JSON sorts keys without folding its string values.
function typedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry != null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : entry,
  );
}

const contentMarkdown = (value: string) =>
  value.replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, '![$1](IMAGE)');

function selectItemContent(slot: SelectSlotT, id: string): unknown {
  const item = slot.items.find((item) => item.item_id === id);
  if (item == null) return { unresolved: true };
  return {
    ...(item.label_md != null ? { label: contentMarkdown(item.label_md) } : {}),
    ...(item.coordinates != null ? {
      coordinates: Object.fromEntries(Object.entries(item.coordinates).map(([axis, coordinate]) => [
        axis, slot.axes?.[axis]?.find((entry) => entry.id === coordinate)?.label_md ?? null,
      ])),
    } : {}),
    ...(item.gap_after_codepoint != null ? { gap: item.gap_after_codepoint } : {}),
    ...(item.label_md == null && item.coordinates == null && item.gap_after_codepoint == null
      ? { displayed_token: item.item_id } : {}),
  };
}

function byTypedContent(a: unknown, b: unknown): number {
  const left = typedJson(a), right = typedJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function ruleReferenceContent(statement: string): unknown {
  // criterionFor packs a DraftRubric after the reference. Criterion ids and metadata
  // address that rubric; they are not its grading statements or awards.
  const split = statement.lastIndexOf('\n\n');
  const tail = split < 0 ? statement : statement.slice(split + 2);
  try {
    const rubric = DraftRubric.safeParse(JSON.parse(tail));
    if (rubric.success) return {
      reference: split < 0 ? '' : contentMarkdown(statement.slice(0, split)),
      rubric: {
        guidance: rubric.data.guidance_md,
        criteria: rubric.data.criteria.map((criterion) => ({
          statement: criterion.statement_md, max: criterion.max,
          allowed_awards: criterion.allowed_awards,
        })),
      },
    };
  } catch { /* Plain reference text is already the authoritative statement. */ }
  return contentMarkdown(statement);
}

function typedQuestionContent(
  document: QuestionDraftDocumentT,
  revision?: typeof question_revision.$inferSelect,
): string {
  const contract = revision != null
    ? { ...revision, conversion_issues: [] }
    : draftDocumentToContract(document, 'content');
  const material = (id: string) => {
    const value = contract.structure.materials.find((material) => material.material_id === id);
    return value == null ? { unresolved: true } : {
      kind: value.kind, digest: value.asset.digest, public: isPublicSharedMaterial(value),
      caption: value.caption, alt: value.alt_text,
      text: value.content_md != null ? contentMarkdown(value.content_md) : undefined,
    };
  };
  return typedJson({
    typed_content_version: 2,
    aggregation: contract.scoring_basis.aggregation,
    blank_scores_zero: contract.scoring_basis.blank_scores_zero,
    issues: [...new Set(contract.conversion_issues.map((issue) => issue.code))].sort(),
    parts: document.parts.map((part) => ({
      prompt: contentMarkdown(part.prompt_md),
      materials: part.material_ids.map(material),
      blank_order: part.blank_order?.map((id) => part.units.findIndex((unit) => unit.slot_id === id)),
      units: part.units.map((unit) => {
        const slot = contract.response_spec.slots.find((slot) => slot.slot_id === unit.slot_id);
        const scoring = contract.scoring_basis.units.find((scoring) => scoring.scoring_unit_id === unit.unit_id);
        const executor = contract.execution_plan.assignments.find((assignment) =>
          assignment.scoring_unit_ids.includes(unit.unit_id))?.executor;
        const criterion = scoring?.criterion;
        const award = (value: ScoringRuleT['otherwise']) =>
          'per_item' in value && slot?.kind === 'select'
            ? { ...value, per_item: Object.entries(value.per_item).map(([id, points]) => ({
                item: selectItemContent(slot, id), points,
              })).sort(byTypedContent) }
            : value;
        return {
          response: slot?.kind === 'select' ? {
            kind: slot.kind, pick: slot.pick,
            text: slot.text,
            axes: slot.axes != null ? Object.fromEntries(Object.entries(slot.axes).map(([axis, entries]) => [
              axis, entries.map((entry) => contentMarkdown(entry.label_md)).sort(),
            ])) : undefined,
            items: slot.axes != null || slot.text != null
              ? slot.items.map((item) => selectItemContent(slot, item.item_id)).sort(byTypedContent)
              : slot.items.map((item) => selectItemContent(slot, item.item_id)),
            at_most_per_coordinate: slot.at_most_per_coordinate,
          } : slot != null ? Object.fromEntries(Object.entries(slot).filter(([key]) =>
            key !== 'slot_id' && key !== 'part_id')) : null,
          criterion: criterion?.kind === 'select_key' && slot?.kind === 'select'
            ? { kind: criterion.kind, accepted: criterion.accepted_item_ids.map((id) =>
                selectItemContent(slot, id)).sort(byTypedContent) }
            : criterion?.kind === 'rule_reference'
              ? { kind: criterion.kind, statement: ruleReferenceContent(criterion.statement_md) }
              : criterion ?? null,
          points: scoring?.points,
          materials: scoring?.material_refs.map(material),
          rule: scoring?.rule != null ? {
            version: scoring.rule.version,
            cases: scoring.rule.cases.map((entry) => ({ when: entry.when, award: award(entry.award) })),
            otherwise: award(scoring.rule.otherwise),
          } : null,
          executor: executor?.kind === 'deterministic'
            ? { kind: executor.kind, comparator: executor.comparator }
            : executor?.kind === 'model_executor'
              ? { kind: executor.kind, task_kind: executor.task_kind }
              : executor?.kind,
        };
      }),
    })),
  });
}

/** Content only: never used for a sealed revision, request fingerprint or paid receipt. */
export function canonicalTypedQuestionContentHash(document: QuestionDraftDocumentT): string {
  return createHash('sha256').update(typedQuestionContent(document)).digest('hex');
}

async function currentTypedDocument(db: Db | Tx, id: string): Promise<{
  document: QuestionDraftDocumentT; revision: typeof question_revision.$inferSelect;
} | null> {
  const [row] = await db.select({ revision: question_revision, parentId: question.parent_question_id })
    .from(question)
    .innerJoin(question_group_lifecycle,
      eq(question_group_lifecycle.group_id, sql`COALESCE(${question.parent_question_id}, ${question.id})`))
    .innerJoin(question_revision, eq(question_revision.revision_id, question_group_lifecycle.current_revision_id))
    .where(eq(question.id, id)).limit(1);
  if (row == null) return null;
  try {
    if (!QuestionGroupStructure.safeParse(row.revision.structure).success ||
        !ResponseSpec.safeParse(row.revision.response_spec).success ||
        !ScoringBasis.safeParse(row.revision.scoring_basis).success ||
        !ExecutionPlan.safeParse(row.revision.execution_plan).success) return null;
    const document = revisionToDraftDocument(row.revision);
    if (document.parts.length === 0 || row.revision.scoring_basis.units.some((unit) =>
      unit.criterion.kind !== 'select_key' && unit.criterion.kind !== 'blank_key' &&
      unit.criterion.kind !== 'rule_reference') || document.parts.some((part) =>
        part.units.some((unit) => unit.metadata.unmapped_slot_kind != null))) return null;
    if (row.parentId == null) return { document, revision: row.revision };
    const part = document.parts.find((part) => part.part_id === id);
    return part != null ? { document: { ...document, parts: [part] }, revision: row.revision } : null;
  } catch { return null; }
}

type FlatSourcedContent = Pick<SourcedQuestionT, 'prompt_md' | 'reference_md' | 'choices_md' | 'rubric_json'>;

/** Legacy hashes/stems locate candidates only; the current complete typed content must agree. */
export async function findTypedQuestionDuplicate(
  db: Db | Tx,
  input: { document: QuestionDraftDocumentT; canonicalContentHash?: string;
    legacyFlatContent?: FlatSourcedContent; excludeQuestionId?: string },
): Promise<{ id: string; canonicalContentHash: string } | null> {
  const identity = draftCanonicalIdentity(input.document);
  const canonicalHash = canonicalTypedQuestionContentHash(input.document);
  const legacyDeclaredHash = canonicalQuestionContentHash({ ...identity,
    declaredParts: input.document.parts.map((part) => ({ promptMd: part.prompt_md,
      units: part.units.map((unit) => draftCanonicalIdentity({ ...input.document,
        parts: [{ ...part, units: [unit] }] })),
    })),
  });
  const hashes = [canonicalHash, canonicalQuestionContentHash(identity), legacyDeclaredHash,
    ...(input.canonicalContentHash != null ? [input.canonicalContentHash] : []),
    ...(input.legacyFlatContent != null
      ? [canonicalSourcedQuestionContentHash(input.legacyFlatContent, null)] : [])];
  const candidates = await db.select({ id: question.id, hash: question.canonical_content_hash })
    .from(question).where(and(isNotNull(question.canonical_content_hash),
      or(inArray(question.canonical_content_hash, hashes), eq(question.prompt_md, identity.promptMd)),
      ...(input.excludeQuestionId != null ? [ne(question.id, input.excludeQuestionId)] : [])))
    .orderBy(sql`CASE WHEN ${question.canonical_content_hash} = ${canonicalHash} THEN 0 ELSE 1 END`,
      question.created_at, question.id);
  const content = typedQuestionContent(input.document);
  for (const candidate of candidates) {
    const current = await currentTypedDocument(db, candidate.id);
    if (current != null && candidate.hash != null &&
        typedQuestionContent(current.document, current.revision) === content) {
      return { id: candidate.id, canonicalContentHash: candidate.hash };
    }
  }
  return null;
}

export interface ExactQuestionDuplicate {
  id: string;
  draftStatus: string | null;
  source: string;
}

export interface ExactQuestionDuplicateKnowledgeMerge extends ExactQuestionDuplicate {
  disposition: 'merged' | 'released_terminal_draft';
  previousKnowledgeIds: string[];
  knowledgeIds: string[];
  addedKnowledgeIds: string[];
  enrolledKnowledgeIds: string[];
  previousVersion: number;
  version: number;
  eventId: string | null;
}

/**
 * Keep the current supply target first, then retain any additional model attribution in its own
 * order. Several review/calibration readers treat knowledge_ids[0] as the primary family anchor;
 * a question generated to fill target K1 must therefore not become primarily K2 merely because
 * the model returned K2 explicitly.
 */
export function combineExactDuplicateKnowledgeIds(
  questionKnowledgeIds: string[],
  targetKnowledgeIds: string[],
): string[] {
  return [...new Set([...targetKnowledgeIds, ...questionKnowledgeIds])];
}

/**
 * Cap on how many exact-duplicate records a producer serializes into its observability event.
 * The full count is kept separately (`exact_duplicate_count`); this only bounds the sampled detail
 * list so a batch with many duplicates cannot bloat the immutable event payload.
 */
export const EXACT_DUPLICATE_EVENT_SAMPLE_CAP = 20;

const TERMINAL_VERIFY_ACTION = {
  quiz_gen: 'experimental:quiz_verify',
  web_sourced: 'experimental:source_verify',
} as const;

/** 草稿已经有终态校验事件（outcome 不是 error）时，精确哈希和一页一题网址用同一条放行规则。 */
export async function terminalVerifiedDraftEventId(
  tx: Tx,
  row: { id: string; draftStatus: string | null; source: string },
): Promise<string | null> {
  const action =
    row.source === 'quiz_gen' || row.source === 'web_sourced'
      ? TERMINAL_VERIFY_ACTION[row.source]
      : null;
  if (row.draftStatus !== 'draft' || action == null) return null;
  const terminal = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, action),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, row.id),
        or(isNull(event.outcome), ne(event.outcome, 'error')),
      ),
    )
    .limit(1);
  return terminal[0]?.id ?? null;
}

/**
 * 归档一条终态草稿并放开它的 canonical hash，让修正后的候选能重新插入。
 * 判定与 mergeExactQuestionDuplicateKnowledgeIds 以前内联的规则是同一个函数。
 */
export async function releaseTerminalVerifiedDraft(
  tx: Tx,
  row: {
    id: string;
    draftStatus: string | null;
    source: string;
    metadata: (typeof question.$inferSelect)['metadata'];
    version: number;
    canonicalContentHash: string;
  },
  params: {
    actorRef: 'quiz_gen' | 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<{ eventId: string; version: number } | null> {
  const terminalEventId = await terminalVerifiedDraftEventId(tx, row);
  if (terminalEventId == null) return null;
  const nextVersion = row.version + 1;
  const eventId = createId();
  const archivedAt = Math.floor(params.now.getTime() / 1000);
  await tx
    .update(question)
    .set({
      canonical_content_hash: null,
      metadata: {
        ...(row.metadata ?? {}),
        archived_at: archivedAt,
        archived_reason: 'terminal_draft_superseded_by_reproduction',
        archived_previous_draft_status: row.draftStatus,
      },
      updated_at: params.now,
      version: nextVersion,
    })
    .where(
      and(eq(question.id, row.id), eq(question.canonical_content_hash, row.canonicalContentHash)),
    );
  await writeEvent(tx, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: QUESTION_EDIT_ACTION,
    subject_kind: 'question',
    subject_id: row.id,
    outcome: 'success',
    payload: {
      question_id: row.id,
      previous_version: row.version,
      next_version: nextVersion,
      before: {
        canonical_content_hash: row.canonicalContentHash,
        archived_at: null,
      },
      after: { canonical_content_hash: null, archived_at: archivedAt },
      reason: 'terminal_draft_superseded_for_reproduction',
      terminal_verify_event_id: terminalEventId,
      task_run_id: params.taskRunId ?? null,
      preserved_draft_status: row.draftStatus,
    },
    created_at: params.now,
  });
  return { eventId, version: nextVersion };
}

/**
 * 一页一题的网址命中。活题并入知识点。终态草稿在即将插入的事务里放行；
 * 更早的预检只跳过合并，避免后面的 n-gram 拒绝把旧草稿先归档掉。
 */
export async function settleOneQuestionPageHit(
  tx: Tx,
  params: {
    questionId: string;
    knowledgeIds: string[];
    actorRef: 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
    onTerminal: 'defer' | 'release';
  },
): Promise<'continue' | { existingQuestionId: string; addedKnowledgeIds: string[] }> {
  await acquireLearningStateWriteLock(tx);
  const [row] = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      source: question.source,
      metadata: question.metadata,
      version: question.version,
      canonicalContentHash: question.canonical_content_hash,
    })
    .from(question)
    .where(eq(question.id, params.questionId))
    .limit(1)
    .for('update');
  if (row == null) return 'continue';
  const terminalEventId = await terminalVerifiedDraftEventId(tx, row);
  if (terminalEventId != null) {
    if (params.onTerminal === 'release' && row.canonicalContentHash != null) {
      await releaseTerminalVerifiedDraft(
        tx,
        { ...row, canonicalContentHash: row.canonicalContentHash },
        params,
      );
    }
    return 'continue';
  }
  const merged = await mergeKnowledgeForSourceDuplicate(tx, params);
  return { existingQuestionId: row.id, addedKnowledgeIds: merged.addedKnowledgeIds };
}

/** Reusable active+draft lookup; legacy NULL-hash rows intentionally do not match. */
export async function findExactQuestionDuplicate(
  db: Db | Tx,
  hash: string,
): Promise<ExactQuestionDuplicate | null> {
  const rows = await db
    .select({ id: question.id, draftStatus: question.draft_status, source: question.source })
    .from(question)
    .where(eq(question.canonical_content_hash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reconcile a canonical duplicate with the knowledge attribution requested by the current supply
 * run. The existing question remains the single global content identity; missing KCs are appended
 * in request order under a row lock, with a normal question-edit audit event + version bump.
 *
 * Lifecycle is deliberately preserved. An active duplicate stays active and each newly-attributed
 * live KC is FSRS-enrolled-if-absent in the same transaction. A pending draft stays in its original
 * route's verification flow. A terminal rejected/needs-review draft cannot be re-dispatched because
 * verifier events are append-only idempotency guards, so it releases the canonical hash and lets the
 * current producer persist a fresh candidate instead of falsely closing the target KC's supply gap.
 * No-op when the duplicate already covers every requested live KC.
 *
 * Must run inside the producer's transaction so lookup, merge, and any competing canonical-hash
 * INSERT are serialized as one persistence decision.
 */
export async function mergeExactQuestionDuplicateKnowledgeIds(
  tx: Tx,
  params: {
    canonicalContentHash: string;
    document?: QuestionDraftDocumentT;
    legacyFlatContent?: FlatSourcedContent;
    knowledgeIds: string[];
    // jyeoo_fetch reuses this cross-KC dedup path via insertSourcedDraft.
    actorRef: 'quiz_gen' | 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<ExactQuestionDuplicateKnowledgeMerge | null> {
  // review F2 (revised after the barrier-test deadlock postmortem) — lock order
  // must be G→question-row (matching the live submit tx), but taking G on the LOOKUP-MISS
  // path serializes the producers' entire persist txs and deadlocks the designed
  // canonical-hash race choreography (a tx holding G at the post-miss seam while its racing
  // twin blocks on G). So: optimistic UNLOCKED peek first — a miss returns null having
  // taken NO locks (the miss path is safe without them: the caller's INSERT is guarded by
  // onConflictDoNothing on the canonical hash, and the conflict loser re-enters here and
  // merges under the locks). Only a HIT acquires G and then re-reads FOR UPDATE, so every
  // path that touches the row or reaches enrollFsrsStateIfAbsent holds G first.
  const typedHit = params.document != null
    ? await findTypedQuestionDuplicate(tx, {
        document: params.document, canonicalContentHash: params.canonicalContentHash,
        legacyFlatContent: params.legacyFlatContent,
      })
    : null;
  const peek = params.document != null
    ? typedHit != null ? [{ id: typedHit.id, hash: typedHit.canonicalContentHash }] : []
    : await tx.select({ id: question.id, hash: question.canonical_content_hash })
        .from(question).where(eq(question.canonical_content_hash, params.canonicalContentHash)).limit(1);
  if (peek.length === 0) return null;
  const matchedHash = peek[0].hash;
  if (matchedHash == null) return null;

  await acquireLearningStateWriteLock(tx);
  const rows = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      source: question.source,
      knowledgeIds: question.knowledge_ids,
      metadata: question.metadata,
      version: question.version,
    })
    .from(question)
    .where(and(eq(question.id, peek[0].id), eq(question.canonical_content_hash, matchedHash)))
    .limit(1)
    .for('update');
  const row = rows[0];
  // The peeked row can vanish between the unlocked peek and the locked re-read only via
  // out-of-band deletion (question rows are never deleted by production flows); treat as
  // a clean miss rather than inventing a row.
  if (!row) return null;
  if (params.document != null) {
    const current = await currentTypedDocument(tx, row.id);
    if (current == null || typedQuestionContent(current.document, current.revision) !==
        typedQuestionContent(params.document)) return null;
  }

  const released = await releaseTerminalVerifiedDraft(
    tx,
    {
      id: row.id,
      draftStatus: row.draftStatus,
      source: row.source,
      metadata: row.metadata,
      version: row.version,
      canonicalContentHash: matchedHash,
    },
    params,
  );
  if (released) {
    return {
      ...row,
      disposition: 'released_terminal_draft',
      previousKnowledgeIds: row.knowledgeIds,
      knowledgeIds: row.knowledgeIds,
      addedKnowledgeIds: [],
      enrolledKnowledgeIds: [],
      previousVersion: row.version,
      version: released.version,
      eventId: released.eventId,
    };
  }

  const requestedKnowledgeIds = [
    ...new Set(params.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const liveKnowledgeRows =
    requestedKnowledgeIds.length > 0
      ? await tx
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, requestedKnowledgeIds), isNull(knowledge.archived_at)))
          .orderBy(knowledge.id)
          .for('update')
      : [];
  const liveKnowledgeIds = new Set(liveKnowledgeRows.map((candidate) => candidate.id));

  const seen = new Set(row.knowledgeIds);
  const addedKnowledgeIds: string[] = [];
  for (const id of requestedKnowledgeIds) {
    if (!liveKnowledgeIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    addedKnowledgeIds.push(id);
  }
  const knowledgeIds = [...row.knowledgeIds, ...addedKnowledgeIds];
  if (addedKnowledgeIds.length === 0) {
    return {
      ...row,
      disposition: 'merged',
      previousKnowledgeIds: row.knowledgeIds,
      knowledgeIds,
      addedKnowledgeIds,
      enrolledKnowledgeIds: [],
      previousVersion: row.version,
      eventId: null,
    };
  }

  const nextVersion = row.version + 1;
  const updated = await tx
    .update(question)
    .set({ knowledge_ids: knowledgeIds, updated_at: params.now, version: nextVersion })
    .where(
      and(
        eq(question.id, row.id),
        eq(question.canonical_content_hash, matchedHash),
      ),
    )
    .returning({ id: question.id });
  if (updated.length === 0) {
    throw new Error(`canonical duplicate ${row.id} changed while merging knowledge attribution`);
  }

  const eventId = createId();
  const enrolledKnowledgeIds =
    row.draftStatus !== 'draft'
      ? await enrollAddedKnowledgeScheduling(tx, {
          questionId: row.id,
          knowledgeIds: addedKnowledgeIds,
          evidenceEventId: eventId,
          now: params.now,
        })
      : [];
  await writeEvent(tx, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: QUESTION_EDIT_ACTION,
    subject_kind: 'question',
    subject_id: row.id,
    outcome: 'success',
    payload: {
      question_id: row.id,
      previous_version: row.version,
      next_version: nextVersion,
      before: { knowledge_ids: row.knowledgeIds },
      after: { knowledge_ids: knowledgeIds },
      reason: 'cross_kc_exact_duplicate',
      canonical_content_hash: matchedHash,
      added_knowledge_ids: addedKnowledgeIds,
      enrolled_knowledge_ids: enrolledKnowledgeIds,
      task_run_id: params.taskRunId ?? null,
      preserved_draft_status: row.draftStatus,
    },
    created_at: params.now,
  });

  return {
    ...row,
    disposition: 'merged',
    previousKnowledgeIds: row.knowledgeIds,
    knowledgeIds,
    addedKnowledgeIds,
    enrolledKnowledgeIds,
    previousVersion: row.version,
    version: nextVersion,
    eventId,
  };
}

/** 同一道题的来源网址命中时并入知识点。不改 canonical_content_hash。终态草稿由 releaseTerminalVerifiedDraft 放行，不在这里合并。 */
export async function mergeKnowledgeForSourceDuplicate(
  tx: Tx,
  params: {
    questionId: string;
    knowledgeIds: string[];
    actorRef: 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<{ addedKnowledgeIds: string[] }> {
  await acquireLearningStateWriteLock(tx);
  const [row] = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      knowledgeIds: question.knowledge_ids,
      version: question.version,
    })
    .from(question)
    .where(eq(question.id, params.questionId))
    .limit(1)
    .for('update');
  if (row == null) return { addedKnowledgeIds: [] };

  const requested = [
    ...new Set(params.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const liveRows =
    requested.length > 0
      ? await tx
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)))
          .orderBy(knowledge.id)
          .for('update')
      : [];
  const live = new Set(liveRows.map((candidate) => candidate.id));
  const seen = new Set(row.knowledgeIds);
  const addedKnowledgeIds: string[] = [];
  for (const id of requested) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    addedKnowledgeIds.push(id);
  }
  if (addedKnowledgeIds.length === 0) return { addedKnowledgeIds };

  const knowledgeIds = [...row.knowledgeIds, ...addedKnowledgeIds];
  const nextVersion = row.version + 1;
  await tx
    .update(question)
    .set({ knowledge_ids: knowledgeIds, updated_at: params.now, version: nextVersion })
    .where(eq(question.id, row.id));

  const eventId = createId();
  const enrolledKnowledgeIds =
    row.draftStatus !== 'draft'
      ? await enrollAddedKnowledgeScheduling(tx, {
          questionId: row.id,
          knowledgeIds: addedKnowledgeIds,
          evidenceEventId: eventId,
          now: params.now,
        })
      : [];
  await writeEvent(tx, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: QUESTION_EDIT_ACTION,
    subject_kind: 'question',
    subject_id: row.id,
    outcome: 'success',
    payload: {
      question_id: row.id,
      previous_version: row.version,
      next_version: nextVersion,
      before: { knowledge_ids: row.knowledgeIds },
      after: { knowledge_ids: knowledgeIds },
      reason: 'same_source_ref',
      added_knowledge_ids: addedKnowledgeIds,
      enrolled_knowledge_ids: enrolledKnowledgeIds,
      task_run_id: params.taskRunId ?? null,
      preserved_draft_status: row.draftStatus,
    },
    created_at: params.now,
  });
  return { addedKnowledgeIds };
}
