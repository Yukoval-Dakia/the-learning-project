import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  COMPONENT_DISAGREEMENT_RULE,
  type JudgmentUnknown,
  type LearnerJudgment,
  type LearnerJudgmentBatch,
  type LearnerJudgmentInput,
  LearnerJudgmentInputSchema,
  type ReviewTiming,
} from '@/core/schema/learner-judgment';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { event, material_fsrs_state } from '@/db/schema';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import {
  resolveSchedulingProjection,
  retrievabilityForKc,
  selectedForgettingEngine,
} from '@/kernel/scheduling';
import { type MasteryProjection, getMasteryProjection } from './mastery-projection';
import {
  type SchedulingReviewFact,
  cardBasis,
  lastRetrievalAt,
  recordedDurationMs,
  reviewTiming,
} from './review-timing';

type DbLike = Db | Tx;
type MasteryReader = (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;
type ComponentRead<T> = { kind: 'available'; values: Map<string, T> } | JudgmentUnknown;

function unknown(reason: string): JudgmentUnknown {
  return { kind: 'unknown', reason };
}

// Reasons meaning a component did not answer at all (query/snapshot/engine
// failure), as opposed to honest per-item unknowns (cold start, inferred-only,
// insufficient evidence). Failure-semantics consumers key on these.
const COMPONENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'mastery_component_unavailable',
  'retention_component_unavailable',
  'engine_selection_unavailable',
  'snapshot_unavailable',
  'caller_transaction_is_not_a_read_only_snapshot',
]);

function isComponentFailureReason(reason: string): boolean {
  return COMPONENT_FAILURE_REASONS.has(reason);
}

// The retention side is comparable only as a number: the port's FSRS reading or
// the candidate's score. A structured unknown reading is not a value.
function retentionValue(retention: LearnerJudgment['retention']): number | null {
  if (retention.kind !== 'available') return null;
  if (typeof retention.reading === 'number') return retention.reading;
  return retention.reading.kind === 'score' ? retention.reading.value : null;
}

function retentionUnavailableReason(retention: LearnerJudgment['retention']): string {
  if (retention.kind === 'unknown') return retention.reason;
  return typeof retention.reading === 'object' && retention.reading.kind === 'unknown'
    ? retention.reading.reason
    : 'missing_scheduling_state';
}

// An explainable divergence between the two incumbent component readings. The
// verdict only compares the already-published observables at the registered
// thresholds — it combines no likelihoods and claims no joint prediction.
function componentDisagreement(
  pfa: LearnerJudgment['p_correct_now'],
  retention: LearnerJudgment['retention'],
): LearnerJudgment['uncertainty']['component_disagreement'] {
  const rule = { high: COMPONENT_DISAGREEMENT_RULE.high, low: COMPONENT_DISAGREEMENT_RULE.low };
  const r = retentionValue(retention);
  if (pfa.kind === 'incumbent_pfa') {
    if (r === null) {
      return {
        kind: 'partial_coverage',
        missing: 'retention',
        reason: retentionUnavailableReason(retention),
      };
    }
    if (pfa.value >= rule.high && r < rule.low) {
      return {
        kind: 'divergence_observed',
        direction: 'ability_high_retention_low',
        rule,
        calibration: 'uncalibrated',
      };
    }
    if (pfa.value < rule.low && r >= rule.high) {
      return {
        kind: 'divergence_observed',
        direction: 'ability_low_retention_high',
        rule,
        calibration: 'uncalibrated',
      };
    }
    return { kind: 'no_divergence_observed', rule, calibration: 'uncalibrated' };
  }
  if (r !== null) {
    return { kind: 'partial_coverage', missing: 'ability', reason: pfa.reason };
  }
  return unknown('component_readings_not_comparable');
}

// Deterministic plain-language sentence covering 会做 / 记得 / 分歧. Qualitative
// only: no numbers reach learner-visible surfaces before the D6 threshold. A
// component failure is reported as a failure, never folded into "no evidence".
function judgementSentence(
  pfa: LearnerJudgment['p_correct_now'],
  retention: LearnerJudgment['retention'],
  disagreement: LearnerJudgment['uncertainty']['component_disagreement'],
): string {
  const canDo =
    pfa.kind === 'incumbent_pfa'
      ? '会做：现役掌握读数可用，尚未个人校准'
      : pfa.reason === 'inferred_only'
        ? '会做：仅知识关联推断，还不知道'
        : isComponentFailureReason(pfa.reason)
          ? '会做：掌握部件不可用，读取失败'
          : '会做：本人作答证据不足，还不知道';
  const remember =
    retentionValue(retention) !== null
      ? '记得：现役保持读数可用，尚未个人校准'
      : retention.kind === 'unknown' && isComponentFailureReason(retention.reason)
        ? '记得：保持部件不可用，读取失败'
        : '记得：暂无保持读数，还不知道';
  const divergence =
    disagreement.kind === 'divergence_observed'
      ? disagreement.direction === 'ability_high_retention_low'
        ? '分歧：会做读数高而保持读数低（可能会了但快忘）'
        : '分歧：保持读数高而会做读数低（可能记得但不会用）'
      : disagreement.kind === 'no_divergence_observed'
        ? '分歧：未见跨阈值的背离'
        : disagreement.kind === 'partial_coverage'
          ? '分歧：仅一端读数可用，暂无法判断'
          : '分歧：两端读数均不可用，还不知道';
  return `${canDo}；${remember}；${divergence}。`;
}

function retentionAvailable(reading: RetentionReading): LearnerJudgment['retention'] {
  return {
    kind: 'available',
    engine:
      typeof reading === 'number'
        ? 'fsrs'
        : reading.kind === 'score'
          ? 'forgetting_candidate'
          : 'unknown',
    reading,
  };
}

function judgment(
  id: string,
  mastery: ComponentRead<MasteryProjection>,
  retention: ComponentRead<RetentionReading>,
  asOf: Date,
  scheduling: ComponentRead<SchedulingReviewFact>,
  durations: ReadonlyMap<string, number | null> | null,
  nonKcIds: ReadonlySet<string> = new Set(),
): LearnerJudgment {
  const entry = mastery.kind === 'available' ? mastery.values.get(id) : undefined;
  const memory = retention.kind === 'available' ? retention.values.get(id) : undefined;
  const ability: LearnerJudgment['ability'] = entry
    ? { kind: 'available', reading: entry }
    : mastery.kind === 'unknown'
      ? mastery
      : unknown('missing_mastery_state');
  // Keep inferred/zero-evidence source readings inspectable, without presenting
  // a population prior or a KG neighbour as this learner's observed success rate.
  const pfa: LearnerJudgment['p_correct_now'] =
    entry?.provenance === 'observed' && entry.evidence_count > 0
      ? {
          kind: 'incumbent_pfa',
          value: entry.mastery,
          band: {
            kind: 'incumbent_mastery_band',
            lo: entry.mastery_lo,
            hi: entry.mastery_hi,
          },
          calibration: 'uncalibrated',
        }
      : unknown(entry?.provenance === 'inferred' ? 'inferred_only' : 'insufficient_evidence');
  // A present New card's zero is preserved; an absent row remains unknown.
  // Structured candidate readings retain their kind/reason/calibration/provenance.
  // Role-gated non-kc ids never reach the retention read at all (YUK-1600).
  const itemRetention: LearnerJudgment['retention'] = nonKcIds.has(id)
    ? unknown('knowledge_role_not_mastery_evaluable')
    : memory !== undefined
      ? retentionAvailable(memory)
      : retention.kind === 'unknown'
        ? retention
        : unknown('missing_scheduling_state');
  const fact = scheduling.kind === 'available' ? scheduling.values.get(id) : undefined;
  const basis = nonKcIds.has(id)
    ? cardBasis({ presence: 'unread', reason: 'knowledge_role_not_mastery_evaluable' })
    : scheduling.kind === 'unknown'
      ? cardBasis({ presence: 'unread', reason: scheduling.reason })
      : fact
        ? cardBasis({
            presence: 'present',
            due_at: fact.due_at,
            state_readable: fact.state_readable,
            last_retrieval_at: fact.last_retrieval_at,
            event_id: fact.last_review_event_id,
            durations,
          })
        : cardBasis({ presence: 'absent', reason: 'missing_scheduling_state' });
  const effectivePfa = ability.kind === 'unknown' ? ability : pfa;
  const disagreement = componentDisagreement(effectivePfa, itemRetention);
  return {
    knowledge_id: id,
    ability,
    p_correct_now: effectivePfa,
    retention: itemRetention,
    review_timing: reviewTiming({ asOf, ability, retention: itemRetention, ...basis }),
    retention_forecast: unknown('incumbent_port_exposes_current_retention_only'),
    uncertainty: {
      independent_evidence: unknown('incumbent_evidence_not_split_by_independence'),
      helped_evidence: unknown('incumbent_evidence_not_split_by_help'),
      self_rated_evidence: unknown('incumbent_evidence_not_split_by_source'),
      component_disagreement: disagreement,
    },
    would_change_it: unknown('information_gain_policy_not_available'),
    patterns: unknown('pattern_component_not_connected'),
    corrections: unknown('correction_reconciliation_not_connected'),
    judgement: judgementSentence(effectivePfa, itemRetention, disagreement),
  };
}

/**
 * Fold a batch's ability readings back into the incumbent projection map shape
 * (observed + inferred entries), FAILING CLOSED when the ability component
 * itself did not answer (query or snapshot failure): a component failure must
 * not be folded into "never attempted". Under a successful read, a missing key
 * means only cold start or a not-evaluable role — the same meaning the raw
 * projection map had, whose failure also threw.
 */
export function abilityReadingsByIdOrFail(
  batch: LearnerJudgmentBatch,
): Map<string, MasteryProjection> {
  for (const item of batch.items) {
    if (item.ability.kind === 'unknown' && isComponentFailureReason(item.ability.reason)) {
      throw new Error(`learner-judgment ability component failed: ${item.ability.reason}`);
    }
  }
  const byId = new Map<string, MasteryProjection>();
  for (const item of batch.items) {
    if (item.ability.kind !== 'available') continue;
    byId.set(item.knowledge_id, item.ability.reading);
  }
  return byId;
}

function retentionRead(
  scheduling: ComponentRead<SchedulingReviewFact>,
): ComponentRead<RetentionReading> {
  if (scheduling.kind === 'unknown') return scheduling;
  const values = new Map<string, RetentionReading>();
  for (const [id, fact] of scheduling.values) values.set(id, fact.reading);
  return { kind: 'available', values };
}

const UNREADABLE_RETENTION: RetentionReading = {
  kind: 'unknown',
  reason: 'state_or_history_unavailable',
  calibration: 'uncalibrated',
  provenance: 'engineering',
};

async function loadSchedulingReviewFacts(
  db: DbLike,
  subjectKind: 'question' | 'knowledge',
  ids: string[],
  now: Date,
): Promise<Map<string, SchedulingReviewFact>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        inArray(material_fsrs_state.subject_id, ids),
      ),
    );
  const values = new Map<string, SchedulingReviewFact>();
  for (const raw of rows) {
    const eventId = raw.last_review_event_id ?? null;
    try {
      const row = await resolveSchedulingProjection(db, subjectKind, raw.subject_id, raw, now);
      values.set(raw.subject_id, {
        reading: retrievabilityForKc(row.state, now),
        due_at: row.due_at,
        last_retrieval_at: lastRetrievalAt(row.state),
        state_readable: true,
        last_review_event_id: eventId,
      });
    } catch {
      values.set(raw.subject_id, {
        reading: UNREADABLE_RETENTION,
        due_at: raw.due_at,
        last_retrieval_at: null,
        state_readable: false,
        last_review_event_id: eventId,
      });
    }
  }
  return values;
}

async function durationsByEventId(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, number | null>> {
  const ids = [...new Set(eventIds)];
  const found = new Map<string, number | null>();
  if (ids.length === 0) return found;
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids));
  for (const row of rows) found.set(row.id, recordedDurationMs(row.payload));
  return found;
}

/**
 * One batch identity, one evaluation time, two incumbent owners. No fused P,
 * new model, write, issuance or provider call. A new Db transaction establishes
 * a read-only repeatable snapshot; an existing Tx must already provide one.
 */
export async function readLearnerJudgments(
  db: DbLike,
  input: LearnerJudgmentInput,
  // Preserve the existing Copilot mastery-reader injection. This is an explicit
  // partial source override: no DB access or fictitious retention/snapshot is
  // added to an injected read. Production supplies no override.
  deps: { getMasteryProjectionFn?: MasteryReader } = {},
): Promise<LearnerJudgmentBatch> {
  const parsed = LearnerJudgmentInputSchema.parse(input);
  const ids = [...new Set(parsed.knowledge_ids)];
  const asOf = new Date(parsed.as_of.getTime());
  const batch: LearnerJudgmentBatch = {
    version: 'v0-incumbent',
    calibration: 'uncalibrated',
    context: parsed.context,
    as_of: asOf,
    consistency: unknown('snapshot_not_established'),
    components: {
      ability: {
        source: 'kernel/read-models/mastery-projection:getMasteryProjection',
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
      retention: {
        source: 'kernel/scheduling:retrievabilityForKc',
        selected_engine: unknown('engine_not_read'),
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
    },
    input_high_water: unknown('incumbent_ports_do_not_expose_complete_input_high_water'),
    calibration_evidence: unknown('sealed_outcome_pairs_not_connected'),
    sealing: 'not_connected',
    items: [],
  };
  const unavailable = (reason: string) => {
    const failed = unknown(reason);
    batch.items = ids.map((id) => judgment(id, failed, failed, asOf, failed, null));
    return batch;
  };
  if (ids.length === 0) return batch;

  const injectedMastery = deps.getMasteryProjectionFn;
  if (injectedMastery) {
    batch.consistency = unknown('injected_partial_source');
    batch.components.ability.version = unknown('injected_source');
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = { kind: 'available', values: await injectedMastery(db, ids) };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    const unread = unknown('retention_source_not_injected');
    batch.items = ids.map((id) => judgment(id, mastery, unread, asOf, unread, null));
    return batch;
  }

  try {
    batch.components.retention.selected_engine = {
      kind: 'selected',
      engine: selectedForgettingEngine(),
    };
  } catch {
    batch.components.retention.selected_engine = unknown('engine_selection_unavailable');
  }

  const readSnapshot = async (tx: Tx): Promise<LearnerJudgmentBatch> => {
    // Isolate errors with savepoints so a failed component query does not abort
    // the other component's read. Reads are sequential on the same connection.
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = {
        kind: 'available',
        values: await tx.transaction((part) => getMasteryProjection(part, ids)),
      };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    let scheduling: ComponentRead<SchedulingReviewFact>;
    let nonKcIds: ReadonlySet<string> = new Set();
    let durations: ReadonlyMap<string, number | null> | null = new Map();
    if (batch.components.retention.selected_engine.kind === 'unknown') {
      scheduling = unknown('engine_selection_unavailable');
    } else {
      try {
        scheduling = {
          kind: 'available',
          values: await tx.transaction(async (part) => {
            // YUK-1600: retention is a mastery-family reading, so goal/container
            // roots never read FSRS R(t), even where pre-gate stock rows exist.
            nonKcIds = await getNonKcKnowledgeIds(part, ids);
            return loadSchedulingReviewFacts(
              part,
              'knowledge',
              ids.filter((id) => !nonKcIds.has(id)),
              asOf,
            );
          }),
        };
        const eventIds = [...scheduling.values.values()].flatMap((fact) =>
          fact.last_review_event_id ? [fact.last_review_event_id] : [],
        );
        try {
          durations = await tx.transaction((part) => durationsByEventId(part, eventIds));
        } catch {
          durations = null;
        }
      } catch {
        scheduling = unknown('retention_component_unavailable');
        durations = null;
      }
    }
    const retention = retentionRead(scheduling);
    batch.items = ids.map((id) =>
      judgment(id, mastery, retention, asOf, scheduling, durations, nonKcIds),
    );
    return batch;
  };

  try {
    if ('$client' in db) {
      const result = await db.transaction(readSnapshot, {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      result.consistency = {
        kind: 'snapshot',
        isolation: 'repeatable read',
        access: 'read only',
      };
      return result;
    }
    // A savepoint cannot upgrade its parent's snapshot or access mode. Do not
    // silently label a caller's read-committed/write transaction as a snapshot.
    const settings = await db.execute<{ isolation: string; read_only: string }>(sql`
      select current_setting('transaction_isolation') as isolation,
             current_setting('transaction_read_only') as read_only
    `);
    const setting = settings[0];
    if (
      setting?.read_only !== 'on' ||
      (setting.isolation !== 'repeatable read' && setting.isolation !== 'serializable')
    ) {
      return unavailable('caller_transaction_is_not_a_read_only_snapshot');
    }
    await readSnapshot(db);
    batch.consistency = {
      kind: 'snapshot',
      isolation: setting.isolation,
      access: 'read only',
    };
    return batch;
  } catch {
    batch.consistency = unknown('snapshot_unavailable');
    return unavailable('snapshot_unavailable');
  }
}

/** Unlabeled question card. No ability row exists on this subject, so freshness
 * stays unknown unless the card's own retention point is high enough for a shelf. */
export async function readQuestionCardReviewTiming(
  db: DbLike,
  questionId: string,
  asOf: Date,
): Promise<ReviewTiming | null> {
  const facts = await loadSchedulingReviewFacts(db, 'question', [questionId], asOf);
  const fact = facts.get(questionId);
  if (!fact) return null;
  let durations: ReadonlyMap<string, number | null> | null = new Map();
  if (fact.last_review_event_id) {
    try {
      durations = await durationsByEventId(db, [fact.last_review_event_id]);
    } catch {
      durations = null;
    }
  }
  const basis = cardBasis({
    presence: 'present',
    due_at: fact.due_at,
    state_readable: fact.state_readable,
    last_retrieval_at: fact.last_retrieval_at,
    event_id: fact.last_review_event_id,
    durations,
  });
  return reviewTiming({
    asOf,
    ability: unknown('question_card_has_no_ability_reading'),
    retention: retentionAvailable(fact.reading),
    ...basis,
  });
}
