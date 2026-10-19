// YUK-1547 — publish the PAID resolved contract, never the frozen base input.
//
// The admission job froze the pre-solve contract as batch input and then
// published THAT document on an admitted verdict — dropping the paid
// dual-solve/calibration `resolved` contract (typed select_key/set_compare
// criteria, deterministic executors). 'admitted' lifecycle landed on a still
// human_review revision, so the serving gate refused to issue.
//
// This module is the single seam that turns an applied admission receipt into
// a publish input, shared by the job application path and the free repair lane
// (same evidence, same contract rules — repair only adds provenance):
//
//   paid_effect identity → receipt (canonicalHash) → resolved contract
//     (receipt-declared digest recorded verbatim) → canonical published seal
//     (question_revision.integrity_digest / verification.revision_digest)
//
// Presentation: `resolved` carries no display layer of its own. Order:
//   1. resolved's own presentation — verbatim, validated against the RESOLVED
//      layers (a bad explicit layout blocks, never silently replaced);
//   2. the frozen input's presentation — carried verbatim, same validation;
//   3. only when NEITHER exists, `defaultPresentation` — the same deterministic
//      constructor the submit path uses (plain select → option_list, blank →
//      blank_input, coordinated/gap variants, unit/slot bound; self-validated
//      and NULL for shapes blocks-v1 cannot express). A serving gate refuses
//      published select/blank slots with no input block as no_input_renderer —
//      a contract it cannot render is not a lawful admitted publication, so an
//      inexpressible shape blocks the build; the receipt is retained, never
//      swallowed.
// The composition is re-sealed canonically — the published digest always
// covers the presentation that ships.

import { canonicalHash } from '@/core/migration/canonical';
import type { PaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import { LEGACY_DRAFT_STATUS } from '@/core/schema/assessment/lifecycle';
import {
  type PresentationT,
  defaultPresentation,
  validatePresentation,
} from '@/core/schema/assessment/presentation';
import type { ResponseSpecT } from '@/core/schema/assessment/response';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import type { QuestionGroupStructureT } from '@/core/schema/assessment/structure';
import { publishedContractSeal } from '@/kernel/records/assessment-normalization';
import type {
  AdmissionVerificationWrite,
  PublishAdmission,
  PublishQuestionGroupInput,
  WithheldReason,
} from '@/kernel/records/assessment-publication';
import { canonicalQuestionContentHash } from '../quiz/content-fingerprint';
import type { AdmissionResultReceipt, FrozenAdmissionInput } from './receipt';

/** Contract layers + integrity digest as accepted by the central publisher. */
export type PublishContract = PublishQuestionGroupInput['contract'];

/**
 * The payment→publication binding recorded on the new revision's
 * `published_by` and inside the appended verification row's evidence. One paid
 * admission (`unit` + `input_digest` + `entity_revision`) maps to exactly one
 * published contract version; a re-run finds this binding on the current
 * revision and stops instead of minting again.
 */
export interface PaidReceiptBinding {
  family: string;
  unit: string;
  entity_id: string;
  /** Frozen input contract digest — the base the paid run was claimed on. */
  entity_revision: string;
  input_digest: string;
  /** canonicalHash of the applied AdmissionResultReceipt (content-true). */
  receipt_digest: string;
  receipt_recorded_at: string;
  /** Generation the frozen input was claimed under (evidence, not a CAS). */
  input_admission_generation: number;
  /** Receipt-declared resolved digest (recorded verbatim; key-order fragile). */
  resolved_contract_digest?: string;
  /** Canonical seal over the actually-published layers — equals the stored
   *  revision integrity_digest. Distinct from the declared resolved digest. */
  published_contract_digest?: string;
  presentation_source?: 'resolved' | 'carried_from_base' | 'deterministic_default' | 'none';
}

/** Repair-only provenance: old paid row → new revision mapping evidence. */
export interface AdmissionRepairProvenance {
  /** ops driver identity, e.g. 'yuk1547-repair-resolved-contracts'. */
  source: string;
  ticket: string;
  operator_reason: string;
  /** Exact paid row fence — the manifest-pinned send this publication replays. */
  paid_fence: number;
  /** The frozen buggy revision this publication replaces. */
  supersedes_revision_id: string;
  supersedes_revision_digest: string;
  /** Revision the original (buggy) application recorded. */
  original_application_revision_id: string | null;
}

type ResolvedContract = NonNullable<AdmissionResultReceipt['result']['resolved']>;

export interface ResolvedPublishContract {
  contract: PublishContract;
  resolvedContractDigest: string;
  publishedContractDigest: string;
  presentationSource: 'resolved' | 'carried_from_base' | 'deterministic_default' | 'none';
}

export type ResolvedContractBuild =
  | { kind: 'ok'; resolved: ResolvedPublishContract }
  | { kind: 'blocked'; reason: string };

/**
 * Compose the publish document from the receipt's resolved contract. The
 * resolved document is authoritative for the four scoring layers; the
 * presentation follows the resolved→carried→deterministic_default chain above.
 * A resolved contract naming another group, an explicit presentation that does
 * not validate, a shape blocks-v1 cannot express, or layers that cannot be
 * sealed are inconsistencies — fail closed.
 */
export function buildResolvedPublishContract(
  input: FrozenAdmissionInput,
  resolved: ResolvedContract,
): ResolvedContractBuild {
  if (resolved.structure.group_id !== input.contract.structure.group_id) {
    return {
      kind: 'blocked',
      reason:
        `resolved contract group '${resolved.structure.group_id}' != frozen input ` +
        `group '${input.contract.structure.group_id}' — foreign receipt`,
    };
  }
  const explicit =
    resolved.presentation != null
      ? { source: 'resolved' as const, value: resolved.presentation }
      : input.contract.presentation != null
        ? { source: 'carried_from_base' as const, value: input.contract.presentation }
        : null;
  let presentation: PresentationT | undefined;
  let presentationSource: ResolvedPublishContract['presentationSource'];
  if (explicit != null) {
    // Explicit layouts are preserved verbatim — but must validate against the
    // RESOLVED layers (slot ids/units may have changed). An invalid explicit
    // presentation blocks; we never substitute a default over it.
    const issues = validatePresentation(
      explicit.value,
      resolved.structure,
      resolved.response_spec,
      resolved.scoring_basis,
    );
    if (issues.length > 0) {
      return {
        kind: 'blocked',
        reason:
          `${explicit.source} presentation invalid against resolved layers: ` +
          issues
            .slice(0, 3)
            .map((issue) => `${issue.code}:${issue.detail}`)
            .join('; '),
      };
    }
    presentation = explicit.value;
    presentationSource = explicit.source;
  } else if (
    // Only select/blank slots NEED a presentation input block — the serving
    // gate binds BLOCK_INPUT_SLOT_KINDS and withholds them as no_input_renderer
    // without one. Documents whose slots are all natively renderable (text/
    // numeric/formula/…, BLOCK_INPUT_SLOT_KINDS-disjoint) legally keep none.
    !resolved.response_spec.slots.some((slot) => slot.kind === 'select' || slot.kind === 'blank')
  ) {
    presentationSource = 'none';
  } else {
    const generated = defaultPresentation(
      resolved.structure,
      resolved.response_spec,
      resolved.scoring_basis,
    );
    if (generated == null) {
      const kinds = resolved.response_spec.slots.map((slot) => slot.kind).join(',');
      return {
        kind: 'blocked',
        reason:
          'presentation_default_inexpressible: neither resolved nor frozen input carries ' +
          `presentation and blocks-v1 cannot express slots [${kinds}] — refusing to admit a ` +
          'document with no input renderer',
      };
    }
    presentation = generated;
    presentationSource = 'deterministic_default';
  }
  const layers = {
    structure: resolved.structure,
    response_spec: resolved.response_spec,
    scoring_basis: resolved.scoring_basis,
    execution_plan: resolved.execution_plan,
    ...(presentation != null ? { presentation } : {}),
  };
  let canonical: string;
  try {
    canonical = publishedContractSeal(layers).canonical;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: 'blocked',
      reason: `resolved contract does not reseal canonically — ${detail}`,
    };
  }
  return {
    kind: 'ok',
    resolved: {
      contract: { ...layers, integrity_digest: canonical },
      resolvedContractDigest: resolved.integrity_digest,
      publishedContractDigest: canonical,
      presentationSource,
    },
  };
}

export type AdmissionPublishBuild =
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'ok';
      admitted: boolean;
      /** The document actually published — projections must use THIS contract. */
      contract: PublishContract;
      publish: PublishQuestionGroupInput;
    };

/**
 * Receipt → publish input. admitted ⇒ publish the resolved contract with the
 * paid-receipt binding; otherwise publish the frozen input contract withheld —
 * identical to the pre-fix behavior for every non-admitted verdict.
 */
export function buildAdmissionPublishInput(args: {
  groupId: string;
  input: FrozenAdmissionInput;
  identity: PaidEffectIdentity;
  receipt: AdmissionResultReceipt;
  /** Caller's admission decision already requires resolved != null. */
  admitted: boolean;
  expectedCurrentRevision: string | null;
  expectedAdmissionGeneration: number | null;
  availability: 'general_pool' | 'container_only';
  actorRef: string;
  /** Publish clock — receipt.recorded_at for the job, repair time for repair. */
  now: Date;
  repair?: AdmissionRepairProvenance;
}): AdmissionPublishBuild {
  const { input, receipt } = args;
  const result = receipt.result;
  let contract: PublishContract = input.contract;
  let resolvedPart: Pick<
    PaidReceiptBinding,
    'resolved_contract_digest' | 'published_contract_digest' | 'presentation_source'
  > = {};
  if (args.admitted) {
    if (result.resolved == null) {
      return { kind: 'blocked', reason: 'admitted receipt carries no resolved contract' };
    }
    const build = buildResolvedPublishContract(input, result.resolved);
    if (build.kind === 'blocked') return build;
    contract = build.resolved.contract;
    resolvedPart = {
      resolved_contract_digest: build.resolved.resolvedContractDigest,
      published_contract_digest: build.resolved.publishedContractDigest,
      presentation_source: build.resolved.presentationSource,
    };
  }

  const binding: PaidReceiptBinding = {
    family: args.identity.family,
    unit: args.identity.unit,
    entity_id: args.identity.entityId,
    entity_revision: args.identity.entityRevision,
    input_digest: args.identity.inputDigest,
    receipt_digest: canonicalHash(receipt),
    receipt_recorded_at: receipt.recorded_at,
    input_admission_generation: input.admission_generation,
    ...resolvedPart,
  };

  const verifierContext = input.solver2 ? 'independent_model' : 'same_model_isolated_context';
  const admission: PublishAdmission = args.admitted
    ? {
        state: 'admitted',
        evidence: {
          marking_provenance: 'system_verified',
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'independent_model',
              verified_at: receipt.recorded_at,
            },
            note: `YUK-1445 dual blind solve + frozen probe calibration (${input.policy_id}); verifier_context=${verifierContext}`,
          },
          model_slice: null,
        },
      }
    : {
        state: 'withheld',
        reason: (result.per_unit.some((u) => u.reason === 'no_admitted_executor')
          ? 'no_admitted_executor'
          : result.per_unit.some((u) => u.reason?.startsWith('source_crosscheck'))
            ? 'verification_failed'
            : 'unverified_rules') satisfies WithheldReason,
      };

  const verification: AdmissionVerificationWrite = {
    policy_id: result.verification.policy_id,
    outcome: result.verification.outcome,
    evidence: {
      ...result.verification.evidence,
      paid_effect: {
        unit: binding.unit,
        input_digest: binding.input_digest,
        entity_revision: binding.entity_revision,
        admission_generation: input.admission_generation,
      },
      receipt_digest: binding.receipt_digest,
      ...(args.admitted ? resolvedPart : {}),
      ...(args.repair != null ? { repair: args.repair } : {}),
    },
  };

  return {
    kind: 'ok',
    admitted: args.admitted,
    contract,
    publish: {
      group_id: args.groupId,
      contract,
      expectedCurrentRevision: args.expectedCurrentRevision,
      expectedAdmissionGeneration: args.expectedAdmissionGeneration,
      availability: args.availability,
      admission,
      ...(args.admitted ? { suspension: { suspended: false } } : {}),
      verification,
      actorRef: args.actorRef,
      publishedBy: {
        by: 'system',
        lane: 'question_admission',
        policy_id: input.policy_id,
        task_run_ids: result.evidence_refs.task_run_ids,
        paid_receipt: binding,
        ...(args.repair != null ? { repair: args.repair } : {}),
      },
      now: args.now,
    },
  };
}

/** Shared shape of the verdict/cell input runQuestionAdmissionChecks consumes. */
export function admissionCheckVerdict(result: AdmissionResultReceipt['result']) {
  return {
    unitSummary: result.per_unit.map((unit) => ({
      unit_id: unit.scoring_unit_id,
      judgeable_today: unit.status !== 'withheld',
      ...(unit.reason != null ? { withheld_reason: unit.reason } : {}),
    })),
    verdict: {
      status: result.status,
      per_unit: result.per_unit.map((unit) => ({
        scoring_unit_id: unit.scoring_unit_id,
        status: unit.status,
        ...(unit.reason != null ? { reason: unit.reason } : {}),
      })),
    },
  };
}

/** Same stem rule as submit's projectPrompt: a shared stem is the row prompt. */
function projectPromptMd(structure: QuestionGroupStructureT): string {
  const parts = structure.parts;
  if (parts.length === 1) return parts[0].prompt_md;
  const stem = parts
    .flatMap((part) => part.material_ids)
    .map((id) => structure.materials.find((material) => material.material_id === id))
    .find((material) => material != null && material.caption === 'stem/shared context');
  if (stem?.content_md != null) return stem.content_md;
  return parts
    .map((part) => part.prompt_md)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

/**
 * Root question row projection — must come from the SAME contract that was
 * published (the resolved contract on an admitted apply), so the flat legacy
 * columns (prompt/reference/choices/hash) describe what serving actually sees.
 */
export function projectAdmittedQuestionRow(contract: {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
}) {
  const parts = contract.structure.parts;
  const promptMd = projectPromptMd(contract.structure);
  const slotById = new Map(contract.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  const references: string[] = [];
  for (const unit of contract.scoring_basis.units) {
    const slot = unit.slot_refs[0] != null ? slotById.get(unit.slot_refs[0]) : undefined;
    const criterion = unit.criterion;
    if (criterion.kind === 'blank_key') {
      references.push(
        criterion.key.kind === 'text'
          ? criterion.key.accepted.join(' / ')
          : String(criterion.key.expected),
      );
    } else if (criterion.kind === 'text_key') {
      references.push(criterion.accepted_texts.join(' / '));
    } else if (criterion.kind === 'numeric_key') {
      references.push(String(criterion.expected));
    } else if (criterion.kind === 'select_key' && slot?.kind === 'select') {
      const labels = criterion.accepted_item_ids
        .map((id) => slot.items.findIndex((item) => item.item_id === id))
        .filter((index) => index >= 0)
        .map((index) => String.fromCharCode(65 + index));
      if (labels.length > 0) references.push(labels.join(''));
    } else if (
      criterion.kind === 'option_set_key' &&
      (slot?.kind === 'single_choice' || slot?.kind === 'multi_choice')
    ) {
      const labels = criterion.accepted_option_ids
        .map((id) => slot.options.find((option) => option.option_id === id)?.label)
        .filter((label): label is string => label != null && label.length > 0);
      if (labels.length > 0) references.push(labels.join(''));
    }
  }
  const referenceMd = references.length > 0 ? references.join('\n\n') : null;
  const choiceSlot = contract.response_spec.slots.find(
    (slot) =>
      slot.kind === 'select' || slot.kind === 'single_choice' || slot.kind === 'multi_choice',
  );
  const choicesMd =
    choiceSlot?.kind === 'select'
      ? choiceSlot.items.map((item) => item.label_md ?? item.item_id)
      : choiceSlot?.kind === 'single_choice' || choiceSlot?.kind === 'multi_choice'
        ? choiceSlot.options.map((option) => option.text)
        : null;
  const slotKinds = new Set(contract.response_spec.slots.map((slot) => slot.kind));
  const composite = parts.length > 1 || slotKinds.size > 1;
  const choice =
    slotKinds.has('select') || slotKinds.has('single_choice') || slotKinds.has('multi_choice');
  const blank =
    slotKinds.has('blank') ||
    slotKinds.has('text') ||
    slotKinds.has('numeric') ||
    slotKinds.has('formula');
  const kind = composite ? 'composite' : choice ? 'choice' : blank ? 'fill_blank' : 'short_answer';
  return {
    prompt_md: promptMd,
    reference_md: referenceMd,
    choices_md: choicesMd,
    kind,
    canonical_content_hash: canonicalQuestionContentHash({
      promptMd,
      referenceMd,
      choicesMd,
      ...(composite ? { composite: true } : {}),
    }),
    draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
  };
}
