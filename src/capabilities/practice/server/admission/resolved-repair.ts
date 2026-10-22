// explicit free repair lane for the applied-but-wrongly-published
// admissions (the P0 set whose 'admitted' lifecycle sits on a frozen
// human_review revision because the job published the base input instead of
// the paid resolved contract).
// This lane NEVER re-pays: it does not claim, send, record a result, or touch
// the applied paid_effect row. It re-publishes the receipt's `resolved`
// contract through the central publisher with the same evidence builder the
// job uses, plus repair provenance — the new revision's published_by /
// verification row carry paid identity + fence + receipt digest + resolved
// digest + the superseded revision, so the old paid row keeps pointing at the
// old revision while the new revision provably maps back to exactly that paid
// admission.
// Gates (all fail-closed inside one transaction): family lock → root+lifecycle
// locks → exact paid row (unit + input_digest + fence, state must be applied)
// → paid-effect identity RECOMPUTED from input_json (producer recipe, never
// digest labels alone) → frozen input self-seals via publishedContractSeal →
// frozen input / applied application / current revision must still match the
// manifest's expected revision+digest+generation → current revision layers are
// loaded, sealed, and must equal the frozen input's canonical content → the
// current revision must NOT already carry this receipt's FULL binding
// (idempotent skip — a bound rerun mints no revision, bumps no generation,
// emits no event) → group blockers → central publishQuestionGroup CAS.
// Mismatch, ambiguity, unknown, missing or stale state stops the entry;
// nothing is guessed.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import { SCORING_ADMISSION_STATE } from '@/core/schema/assessment/lifecycle';
import type { Tx } from '@/db/client';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import { paid_effect, question, question_revision } from '@/db/schema';
import {
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';
import {
  type PublishQuestionGroupInput,
  publishQuestionGroup,
} from '@/kernel/records/assessment-publication';
import { runQuestionAdmissionChecks } from './checks';
import { ADMISSION_FAMILY, lockAdmissionGroup } from './enqueue';
import { AdmissionResultReceipt, FrozenAdmissionInput } from './receipt';
import {
  type ResolvedPublishContract,
  admissionCheckVerdict,
  buildAdmissionPublishInput,
  buildResolvedPublishContract,
  projectAdmittedQuestionRow,
} from './resolved-publication';

const DIGEST = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** One manifest entry pins the exact paid row AND the exact frozen state the
 * operator audited — apply verifies every field before touching anything. */
export const RepairManifestEntry = z.strictObject({
  group_id: z.string().min(1),
  expected_current_revision_id: z.string().min(1),
  expected_current_revision_digest: DIGEST,
  expected_admission_generation: z.number().int().nonnegative(),
  paid: z.strictObject({
    unit: z.string().min(1),
    input_digest: DIGEST,
    fence: z.number().int().nonnegative(),
  }),
});
export type RepairManifestEntry = z.infer<typeof RepairManifestEntry>;

export const REPAIR_SOURCE = 'yuk1547-repair-resolved-contracts';
/** Distinct actor_ref purely for audit provenance. No-re-enqueue comes from
 * the event payload alone: enqueuePublishedQuestionAdmission only follows
 * 'withheld' publications, and a repair publish is always 'admitted'. */
export const REPAIR_ACTOR_REF = 'practice:question_admission_repair';

export type RepairEvaluation =
  | { kind: 'blocked'; groupId: string; reason: string }
  | {
      kind: 'already_repaired';
      groupId: string;
      revisionId: string;
      revisionDigest: string;
    }
  | {
      kind: 'ready';
      groupId: string;
      targetRevisionDigest: string;
      resolvedContractDigest: string;
      presentationSource: ResolvedPublishContract['presentationSource'];
      ready: ReadyRepair;
    };

export interface ReadyRepair {
  input: FrozenAdmissionInput;
  receipt: AdmissionResultReceipt;
  identity: PaidEffectIdentity;
  contract: ResolvedPublishContract;
  paidFence: number;
  applicationRevisionId: string | null;
  availability: 'general_pool' | 'container_only';
  /** Retained same-base 'unknown' rows (unit + digest) — audit only; the
   * repair never consumes or edits them. */
  retainedUnknownRows: { unit: string; input_digest: string }[];
}

/** The full paid-receipt binding a repair/normal-path resolved publication
 * carries on published_by — every field must match for already_repaired; a
 * partial or foreign binding is ambiguous and blocks (never supersede). */
const RevisionPaidBinding = z
  .object({
    paid_receipt: z
      .object({
        family: z.string(),
        entity_id: z.string(),
        entity_revision: z.string(),
        unit: z.string(),
        input_digest: z.string(),
        receipt_digest: z.string(),
        resolved_contract_digest: z.string(),
        published_contract_digest: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const blocked = (groupId: string, reason: string): RepairEvaluation => ({
  kind: 'blocked',
  groupId,
  reason,
});

/**
 * All reads + locks + fail-closed checks for one manifest entry. Write-free —
 * but it takes pg_advisory_xact_lock and FOR UPDATE row locks, so it runs in a
 * NORMAL transaction (plan mode commits without writes); do NOT run it in a
 * Postgres READ ONLY transaction, the locks would fail there.
 */
export async function evaluateResolvedRepair(
  tx: Tx,
  entry: RepairManifestEntry,
): Promise<RepairEvaluation> {
  await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
  const { root, lifecycle } = await lockAdmissionGroup(tx, entry.group_id);
  if (!root) return blocked(entry.group_id, 'group_root_missing');
  if (root.parent_question_id !== null) return blocked(entry.group_id, 'not_a_group_root');
  if (!lifecycle) return blocked(entry.group_id, 'lifecycle_missing');
  if (lifecycle.withdrawn) return blocked(entry.group_id, 'group_withdrawn');

  // ---- exact paid row (manifest-named identity, locked) ----
  const [paid] = await tx
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, entry.group_id),
        eq(paid_effect.unit, entry.paid.unit),
        eq(paid_effect.input_digest, entry.paid.input_digest),
      ),
    )
    .for('update')
    .limit(1);
  if (!paid) return blocked(entry.group_id, 'paid_row_missing');
  if (paid.fence !== entry.paid.fence)
    return blocked(
      entry.group_id,
      `paid_fence_mismatch: expected ${entry.paid.fence}, saw ${paid.fence}`,
    );
  if (paid.state !== 'applied')
    return blocked(entry.group_id, `paid_state_${paid.state}: only applied rows repair`);
  if (paid.entity_revision !== entry.expected_current_revision_digest)
    return blocked(
      entry.group_id,
      'paid_base_digest_mismatch: paid entity_revision != manifest current digest',
    );

  const input = FrozenAdmissionInput.safeParse(paid.input_json);
  if (!input.success) return blocked(entry.group_id, 'paid_input_unparseable');
  if (input.data.group_id !== entry.group_id)
    return blocked(entry.group_id, 'frozen_input_group_mismatch');
  if (input.data.contract.integrity_digest !== paid.entity_revision)
    return blocked(entry.group_id, 'frozen_input_contract_digest_mismatch');
  if (input.data.revision_id !== entry.expected_current_revision_id)
    return blocked(
      entry.group_id,
      'frozen_input_revision_mismatch: paid input names another revision',
    );

  // the row's PK columns are claims, not proof: recompute the
  // paid-effect identity from the parsed input with the SAME recipe
  // claimAdmissionBatch used at send time (FrozenAdmissionInput.parse →
  // computePaidEffectIdentity over the parsed object — the schema-stripped
  // shape is what the producer hashed). Copied digest labels on a
  // different-content input_json diverge from the stored input_digest.
  const recomputed = computePaidEffectIdentity({
    family: ADMISSION_FAMILY,
    entityId: input.data.group_id,
    entityRevision: input.data.contract.integrity_digest,
    unit: paid.unit,
    input: input.data,
  });
  if (
    recomputed.entityId !== paid.entity_id ||
    recomputed.entityRevision !== paid.entity_revision ||
    recomputed.unit !== paid.unit ||
    recomputed.inputDigest !== paid.input_digest
  ) {
    return blocked(
      entry.group_id,
      'paid_identity_recompute_mismatch: input_json does not recompute to the row identity',
    );
  }
  // The frozen contract must self-seal — a label copied onto different layers
  // fails publishedSealAccepts even when the digest string round-trips.
  let inputSeal: ReturnType<typeof publishedContractSeal>;
  try {
    inputSeal = publishedContractSeal(input.data.contract);
  } catch {
    return blocked(entry.group_id, 'frozen_input_layers_unparseable');
  }
  if (!publishedSealAccepts(inputSeal, input.data.contract.integrity_digest))
    return blocked(
      entry.group_id,
      'frozen_input_seal_mismatch: contract layers do not seal to integrity_digest',
    );

  const receipt = AdmissionResultReceipt.safeParse(paid.result_json);
  if (!receipt.success) return blocked(entry.group_id, 'receipt_unparseable');
  const result = receipt.data.result;
  if (result.status !== 'admitted')
    return blocked(entry.group_id, `receipt_not_admitted: ${result.status}`);
  if (result.resolved == null) return blocked(entry.group_id, 'receipt_missing_resolved');
  if (result.verification.outcome !== 'passed')
    return blocked(entry.group_id, `receipt_outcome_${result.verification.outcome}`);

  // The recorded application must bind the ORIGINAL buggy publication — the
  // row stays terminal on the old revision; repair never rewrites it.
  const application = z
    .object({ status: z.string(), revision_id: z.string().nullish() })
    .passthrough()
    .safeParse(paid.application_json);
  if (
    !application.success ||
    application.data.status !== 'admitted' ||
    application.data.revision_id !== entry.expected_current_revision_id
  ) {
    return blocked(
      entry.group_id,
      'application_binding_mismatch: applied result does not name the manifest revision',
    );
  }

  let contract: ReturnType<typeof buildResolvedPublishContract>;
  try {
    contract = buildResolvedPublishContract(input.data, result.resolved);
  } catch {
    return blocked(entry.group_id, 'resolved_contract_unsealable');
  }
  if (contract.kind === 'blocked') return blocked(entry.group_id, contract.reason);

  // ---- idempotency: a binding already on the current revision ends the entry
  // BEFORE the publisher — no revision, no generation bump, no duplicate
  // verification row. The check uses REAL content (canonical seal of the
  // stored layers) and the FULL paid binding — never digest labels alone.
  const currentRevisionId = lifecycle.current_revision_id;
  if (currentRevisionId == null) return blocked(entry.group_id, 'no_current_revision');
  const [currentRevision] = await tx
    .select({
      revision_id: question_revision.revision_id,
      integrity_digest: question_revision.integrity_digest,
      published_by: question_revision.published_by,
      structure: question_revision.structure,
      response_spec: question_revision.response_spec,
      scoring_basis: question_revision.scoring_basis,
      execution_plan: question_revision.execution_plan,
      presentation: question_revision.presentation,
    })
    .from(question_revision)
    .where(eq(question_revision.revision_id, currentRevisionId))
    .limit(1);
  if (!currentRevision) return blocked(entry.group_id, 'current_revision_missing');
  // Same seam as the job's sealedRevisionContract: parse the stored layers and
  // accept canonical/legacy digest encodings — fail closed, no parallel math.
  let currentSeal: ReturnType<typeof publishedContractSeal>;
  try {
    currentSeal = publishedContractSeal({
      structure: currentRevision.structure,
      response_spec: currentRevision.response_spec,
      scoring_basis: currentRevision.scoring_basis,
      execution_plan: currentRevision.execution_plan,
      ...(currentRevision.presentation != null
        ? { presentation: currentRevision.presentation }
        : {}),
    });
  } catch {
    return blocked(entry.group_id, 'current_revision_layers_unparseable');
  }
  if (!publishedSealAccepts(currentSeal, currentRevision.integrity_digest))
    return blocked(
      entry.group_id,
      'current_revision_unsealed: stored integrity_digest does not seal the stored layers',
    );

  const priorBinding = RevisionPaidBinding.safeParse(currentRevision.published_by);
  if (priorBinding.success) {
    const bound = priorBinding.data.paid_receipt;
    // Full-identity bind: every payment leg + both digests must match the row
    // and the recomputed receipt hash — a label-equal foreign or partial
    // binding is ambiguous and blocks.
    const boundToThisReceipt =
      bound.family === ADMISSION_FAMILY &&
      bound.entity_id === entry.group_id &&
      bound.entity_revision === paid.entity_revision &&
      bound.unit === entry.paid.unit &&
      bound.input_digest === entry.paid.input_digest &&
      bound.receipt_digest === canonicalHash(receipt.data) &&
      bound.resolved_contract_digest === result.resolved.integrity_digest &&
      bound.published_contract_digest === currentSeal.canonical &&
      currentSeal.canonical === contract.resolved.publishedContractDigest;
    if (boundToThisReceipt) {
      return {
        kind: 'already_repaired',
        groupId: entry.group_id,
        revisionId: currentRevision.revision_id,
        revisionDigest: currentRevision.integrity_digest,
      };
    }
    return blocked(
      entry.group_id,
      'current_revision_bound_to_other_receipt: ambiguous ownership, refusing to supersede',
    );
  }
  if (currentSeal.canonical === contract.resolved.publishedContractDigest) {
    return blocked(
      entry.group_id,
      'same_document_without_receipt_binding: identical document exists but lacks the paid binding',
    );
  }

  // ---- manifest expectations (CAS tokens) + before/after content proof ----
  if (currentRevisionId !== entry.expected_current_revision_id)
    return blocked(entry.group_id, 'current_revision_changed');
  if (currentRevision.integrity_digest !== entry.expected_current_revision_digest)
    return blocked(entry.group_id, 'current_digest_mismatch');
  // BEFORE repair the current document must BE the paid frozen input's
  // content (canonical seal equality) — only reached when no binding exists;
  // a repaired rerun never lands here because the binding branch returns
  // first and the current document is then the RESOLVED document, not the
  // input. A copied input digest label on different base layers fails here.
  if (currentSeal.canonical !== inputSeal.canonical)
    return blocked(
      entry.group_id,
      'current_content_differs_from_paid_input: manifest pins the input digest but the stored document is not the paid input',
    );
  if (lifecycle.scoring_admission_generation !== entry.expected_admission_generation)
    return blocked(
      entry.group_id,
      `generation_mismatch: expected ${entry.expected_admission_generation}, saw ${lifecycle.scoring_admission_generation}`,
    );
  if (lifecycle.scoring_admission_state !== SCORING_ADMISSION_STATE.ADMITTED)
    return blocked(
      entry.group_id,
      `admission_state_${lifecycle.scoring_admission_state}: repair only republishes already-admitted groups`,
    );

  // Non-applied rows on the SAME base that can still mint writes stop the
  // entry — 'sending'/'receipt_ready' owe a live application, 'pending' intents
  // can still be claimed. Retained 'unknown' rows (e.g. superseded @1/@2 sends
  // the @3 paid result replaced) cannot write on their own — a later reconcile
  // replays application only, which CAS-stales after our publish — so they are
  // recorded, never consumed, never edited.
  const inFlight = await tx
    .select({
      unit: paid_effect.unit,
      input_digest: paid_effect.input_digest,
      state: paid_effect.state,
    })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, entry.group_id),
        eq(paid_effect.entity_revision, entry.expected_current_revision_digest),
        inArray(paid_effect.state, ['pending', 'sending', 'receipt_ready']),
      ),
    )
    .limit(10);
  if (inFlight.length > 0)
    return blocked(
      entry.group_id,
      `open_same_base_obligations: ${inFlight.map((r) => `${r.unit}/${r.state}`).join(',')}`,
    );
  const retainedUnknown = await tx
    .select({ unit: paid_effect.unit, input_digest: paid_effect.input_digest })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, entry.group_id),
        eq(paid_effect.entity_revision, entry.expected_current_revision_digest),
        eq(paid_effect.state, 'unknown'),
      ),
    )
    .limit(10);

  // ---- same admission gate the job applies at publish time ----
  const decision = await runQuestionAdmissionChecks(tx, {
    knowledgeIds: root.knowledge_ids ?? [],
    ...admissionCheckVerdict(result),
  });
  if (decision.group_blockers.length > 0)
    return blocked(
      entry.group_id,
      `group_blockers: ${decision.group_blockers.map((b) => `${b.code}: ${b.detail}`).join('; ')}`,
    );
  if (decision.admission.state !== 'admitted')
    return blocked(entry.group_id, 'checks_not_admitted');

  return {
    kind: 'ready',
    groupId: entry.group_id,
    targetRevisionDigest: contract.resolved.publishedContractDigest,
    resolvedContractDigest: contract.resolved.resolvedContractDigest,
    presentationSource: contract.resolved.presentationSource,
    ready: {
      input: input.data,
      receipt: receipt.data,
      identity: {
        family: paid.family,
        entityId: paid.entity_id,
        entityRevision: paid.entity_revision,
        unit: paid.unit,
        inputDigest: paid.input_digest,
      },
      contract: contract.resolved,
      paidFence: paid.fence,
      applicationRevisionId: application.data.revision_id ?? null,
      availability: lifecycle.availability,
      retainedUnknownRows: retainedUnknown,
    },
  };
}

export interface RepairApplyOptions {
  operatorReason: string;
  now: Date;
  readAssetBytes?: PublishQuestionGroupInput['readAssetBytes'];
}

export type RepairOutcome =
  | {
      status: 'repaired';
      group_id: string;
      revision_id: string;
      revision_digest: string;
      revision_ordinal: number;
      admission_generation: number;
      event_id: string;
      resolved_contract_digest: string;
      presentation_source: ResolvedPublishContract['presentationSource'];
      /** Retained same-base 'unknown' rows observed at repair time (audit only). */
      retained_unknown_rows: { unit: string; input_digest: string }[];
    }
  | { status: 'already_repaired'; group_id: string; revision_id: string; revision_digest: string }
  | { status: 'blocked'; group_id: string; reason: string }
  | { status: 'conflict'; group_id: string; reason: string };

/**
 * Apply one manifest entry inside the caller's transaction: evaluate → publish
 * the paid resolved contract through the central publisher → project the root
 * question row from the SAME contract. The old paid row is never written; the
 * new revision's published_by + verification row carry the old→new mapping.
 */
export async function applyResolvedRepair(
  tx: Tx,
  entry: RepairManifestEntry,
  opts: RepairApplyOptions,
): Promise<RepairOutcome> {
  const evaluation = await evaluateResolvedRepair(tx, entry);
  if (evaluation.kind === 'blocked')
    return { status: 'blocked', group_id: entry.group_id, reason: evaluation.reason };
  if (evaluation.kind === 'already_repaired')
    return {
      status: 'already_repaired',
      group_id: entry.group_id,
      revision_id: evaluation.revisionId,
      revision_digest: evaluation.revisionDigest,
    };
  const { ready } = evaluation;
  const built = buildAdmissionPublishInput({
    groupId: entry.group_id,
    input: ready.input,
    identity: ready.identity,
    receipt: ready.receipt,
    admitted: true,
    expectedCurrentRevision: entry.expected_current_revision_id,
    expectedAdmissionGeneration: entry.expected_admission_generation,
    availability: ready.availability,
    actorRef: REPAIR_ACTOR_REF,
    now: opts.now,
    repair: {
      source: REPAIR_SOURCE,
      ticket: 'YUK-1547',
      operator_reason: opts.operatorReason,
      paid_fence: ready.paidFence,
      supersedes_revision_id: entry.expected_current_revision_id,
      supersedes_revision_digest: entry.expected_current_revision_digest,
      original_application_revision_id: ready.applicationRevisionId,
    },
  });
  if (built.kind === 'blocked')
    return { status: 'blocked', group_id: entry.group_id, reason: built.reason };
  const persisted = await publishQuestionGroup(tx, {
    ...built.publish,
    readAssetBytes: opts.readAssetBytes,
  });
  if (persisted.status === 'conflict')
    return { status: 'conflict', group_id: entry.group_id, reason: persisted.reason };
  if (persisted.status !== 'published')
    return {
      status: 'blocked',
      group_id: entry.group_id,
      reason: `unexpected_publish_status: ${persisted.status}`,
    };
  // Root row projection comes from the same resolved contract that was sealed.
  const projected = projectAdmittedQuestionRow(built.contract);
  await tx
    .update(question)
    .set({
      prompt_md: projected.prompt_md,
      reference_md: projected.reference_md,
      choices_md: projected.choices_md,
      kind: projected.kind,
      canonical_content_hash: projected.canonical_content_hash,
      draft_status: projected.draft_status,
      updated_at: opts.now,
      version: sql`${question.version} + 1`,
    })
    .where(eq(question.id, entry.group_id));
  return {
    status: 'repaired',
    group_id: entry.group_id,
    revision_id: persisted.revision_id,
    revision_digest: persisted.revision_digest,
    revision_ordinal: persisted.revision_ordinal,
    admission_generation: persisted.admission_generation,
    event_id: persisted.event_id,
    resolved_contract_digest: ready.contract.resolvedContractDigest,
    presentation_source: ready.contract.presentationSource,
    retained_unknown_rows: ready.retainedUnknownRows,
  };
}
