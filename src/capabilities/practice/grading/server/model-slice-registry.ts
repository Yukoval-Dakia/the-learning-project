// model_admission_slice is the admission record. Nothing here admits a slice by itself.
// A dry run writes no row. Retire keeps the row and flips status, so the serving gate stops.
// A slice is pinned to the model and contract version that will actually run.
// A drifted pin stops serving. The holdout has to be run again.

import { and, eq, or } from 'drizzle-orm';
import { type TaskKind, tasks } from '@/capabilities/task-registry';
import { canonicalHash } from '@/core/migration/canonical';
import { ASSESSMENT_RUBRIC_PROMPT_REVISION } from '@/core/schema/assessment/model-decision';
import type {
  AdmittedModelSliceT,
  ModelResponseClass,
} from '@/core/schema/assessment/serving-admission';
import type { Db, Tx } from '@/db/client';
import { model_admission_slice } from '@/db/schema';
import { admittedSliceFromRow } from '@/kernel/read-models/model-admission';
import { JEV_CANONICAL_MODEL } from '@/server/ai/pricing';
import { resolveConfiguredTaskModel } from '@/server/ai/providers';

type SliceRow = typeof model_admission_slice.$inferSelect;

/**
 * Contract-version pin per task kind. The model id is whatever
 * resolveConfiguredTaskModel will run. This table does not hard-code it.
 */
const CURRENT_MODEL_VERSION_PINS: Readonly<Record<string, string>> = {
  // Typed lane: the canonical response model is the version. Wire drift breaks the contract.
  JevScoringDecisionTask: JEV_CANONICAL_MODEL,
  // Chat lane: the rubric prompt and output contract revision.
  AssessmentRubricJudgeTask: ASSESSMENT_RUBRIC_PROMPT_REVISION,
};

/**
 * The slice that will run must still be this id and still active.
 * The id stored at issue time is not enough. A new task model or a retired slice
 * would otherwise keep paying to grade under a pin that was never admitted.
 */
export async function gradingSliceMatchesLivePin(
  db: Db | Tx,
  admittedSliceId: string,
  taskKind: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const pin = currentModelPins().get(taskKind);
  const pinLabel = pin === undefined ? 'unconfigured' : `${pin.model}@${pin.model_version}`;
  const [row] = await db
    .select()
    .from(model_admission_slice)
    .where(eq(model_admission_slice.slice_id, admittedSliceId))
    .limit(1);
  if (row === undefined || row.status !== 'active') {
    return {
      ok: false,
      detail: `admitted slice '${admittedSliceId}' is not active for the model that would run (${pinLabel})`,
    };
  }
  if (pin === undefined) {
    return { ok: false, detail: `no current model pin for task '${taskKind}'` };
  }
  const liveId = modelSliceIdFor({
    subject: row.subject,
    response_class: row.response_class,
    task_kind: taskKind,
    model: pin.model,
    model_version: pin.model_version,
  });
  if (liveId !== admittedSliceId) {
    return {
      ok: false,
      detail: `admitted slice '${admittedSliceId}' (${row.model}@${row.model_version}) is not the slice for the model that would run (${pin.model}@${pin.model_version})`,
    };
  }
  return { ok: true };
}

/** The model and contract version each admissible task will actually run. */
export function currentModelPins(): ReadonlyMap<string, { model: string; model_version: string }> {
  const pins = new Map<string, { model: string; model_version: string }>();
  for (const [kind, version] of Object.entries(CURRENT_MODEL_VERSION_PINS)) {
    const definition = tasks[kind as TaskKind];
    if (definition === undefined) continue;
    pins.set(kind, { model: resolveConfiguredTaskModel(kind as TaskKind), model_version: version });
  }
  return pins;
}

/**
 * Identity is the hash of the five natural-key fields.
 * Evidence, actor, and time stay out. Including them would make the stored id
 * differ from the job report, and a question citing that report would be withheld.
 */
export function modelSliceIdFor(input: {
  subject: string;
  response_class: ModelResponseClass;
  task_kind: string;
  model: string;
  model_version: string;
}): string {
  const identity = {
    subject: input.subject,
    response_class: input.response_class,
    task_kind: input.task_kind,
    model: input.model,
    model_version: input.model_version,
  };
  return `slice_${canonicalHash(identity).slice(0, 32)}`;
}

const RETIRED_SLICE_DETAIL = (sliceId: string) =>
  `slice '${sliceId}' is retired for this model pin; retirement is permanent for the natural key, and a different model version is a different slice`;

/** postgres.js nests 23505 on the cause chain. Walk it before treating the insert as new. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function findSliceByIdentity(
  db: Db | Tx,
  input: {
    subject: string;
    response_class: ModelResponseClass;
    task_kind: string;
    model: string;
    model_version: string;
  },
): Promise<SliceRow | undefined> {
  const sliceId = modelSliceIdFor(input);
  const [existing] = await db
    .select()
    .from(model_admission_slice)
    .where(
      or(
        eq(model_admission_slice.slice_id, sliceId),
        and(
          eq(model_admission_slice.subject, input.subject),
          eq(model_admission_slice.response_class, input.response_class),
          eq(model_admission_slice.task_kind, input.task_kind),
          eq(model_admission_slice.model, input.model),
          eq(model_admission_slice.model_version, input.model_version),
        ),
      ),
    )
    .limit(1);
  return existing;
}

export class ModelSliceRegistrationError extends Error {
  override name = 'ModelSliceRegistrationError';
  constructor(
    public readonly code:
      | 'unknown_task_kind'
      | 'model_pin_mismatch'
      | 'slice_conflict'
      | 'slice_retired',
    detail: string,
  ) {
    super(`registerModelAdmissionSlice: ${code} — ${detail}`);
  }
}

export interface RegisterModelAdmissionSliceInput {
  readonly subject: string;
  readonly response_class: ModelResponseClass;
  readonly task_kind: string;
  readonly model: string;
  readonly model_version: string;
  /** Holdout evidence. Agreement and severe-error records, not a score. */
  readonly holdout_evidence_ref: string;
  readonly admitted_by: string;
  readonly admitted_at?: Date;
}

/**
 * Check the slice before the paid holdout loop. A retired row, or the same id
 * with different evidence or actor, throws now. An idempotent row, or no row yet, passes.
 * Skip this and at least 30 paid calls finish before registration refuses them.
 * That refusal is caught and the job returns, so the queue does not rerun the loop.
 */
export async function assertModelAdmissionSliceRegistrable(
  db: Db | Tx,
  input: RegisterModelAdmissionSliceInput,
): Promise<void> {
  const sliceId = modelSliceIdFor(input);
  const existing = await findSliceByIdentity(db, input);
  if (existing === undefined) return;
  if (existing.status === 'retired') {
    throw new ModelSliceRegistrationError('slice_retired', RETIRED_SLICE_DETAIL(sliceId));
  }
  if (
    existing.holdout_evidence_ref !== input.holdout_evidence_ref ||
    existing.admitted_by !== input.admitted_by
  ) {
    throw new ModelSliceRegistrationError(
      'slice_conflict',
      `slice '${sliceId}' already exists with different evidence/actor`,
    );
  }
}

/**
 * Register only a model this task will run now. A matching active payload returns
 * the existing row. A different payload conflicts. A retired row is not revived.
 */
export async function registerModelAdmissionSlice(
  db: Db | Tx,
  input: RegisterModelAdmissionSliceInput,
): Promise<AdmittedModelSliceT> {
  const pin = currentModelPins().get(input.task_kind);
  if (pin === undefined) {
    throw new ModelSliceRegistrationError(
      'unknown_task_kind',
      `task kind '${input.task_kind}' has no current model pin — only registered grading tasks are admissible`,
    );
  }
  if (pin.model !== input.model || pin.model_version !== input.model_version) {
    throw new ModelSliceRegistrationError(
      'model_pin_mismatch',
      `slice claims ${input.model}@${input.model_version} but the current pin is ${pin.model}@${pin.model_version}`,
    );
  }
  const sliceId = modelSliceIdFor(input);
  const existing = await findSliceByIdentity(db, input);
  if (existing !== undefined) {
    if (existing.status === 'retired') {
      throw new ModelSliceRegistrationError('slice_retired', RETIRED_SLICE_DETAIL(sliceId));
    }
    if (
      existing.holdout_evidence_ref === input.holdout_evidence_ref &&
      existing.admitted_by === input.admitted_by
    ) {
      return admittedSliceFromRow(existing);
    }
    throw new ModelSliceRegistrationError(
      'slice_conflict',
      `slice '${sliceId}' already exists with different evidence/actor`,
    );
  }
  const admittedAt = input.admitted_at ?? new Date();
  try {
    await db.insert(model_admission_slice).values({
      slice_id: sliceId,
      subject: input.subject,
      response_class: input.response_class,
      task_kind: input.task_kind,
      model: input.model,
      model_version: input.model_version,
      holdout_evidence_ref: input.holdout_evidence_ref,
      admitted_by: input.admitted_by,
      admitted_at: admittedAt,
      status: 'active',
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ModelSliceRegistrationError(
        'slice_conflict',
        `slice '${sliceId}' already exists for this model pin`,
      );
    }
    throw error;
  }
  return admittedSliceFromRow({
    slice_id: sliceId,
    subject: input.subject,
    response_class: input.response_class,
    task_kind: input.task_kind,
    model: input.model,
    model_version: input.model_version,
    holdout_evidence_ref: input.holdout_evidence_ref,
    admitted_by: input.admitted_by,
    admitted_at: admittedAt,
    status: 'active',
  });
}

/** Keep the row. Flipping status stops the serving gate immediately. */
export async function retireModelAdmissionSlice(
  db: Db | Tx,
  sliceId: string,
): Promise<'retired' | 'not_found'> {
  const updated = await db
    .update(model_admission_slice)
    .set({ status: 'retired' })
    .where(
      and(eq(model_admission_slice.slice_id, sliceId), eq(model_admission_slice.status, 'active')),
    )
    .returning({ slice_id: model_admission_slice.slice_id });
  return updated.length > 0 ? 'retired' : 'not_found';
}
