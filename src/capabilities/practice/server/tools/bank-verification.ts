import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { ResponseSlotT } from '@/core/schema/assessment/response';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { BankVerificationSchema } from '../../tasks/bank-search-semantic';
import { makeRunTaskFn } from '../task-runtime';
import { resolveBankRefs } from './bank-ref';
import type { BankRequirement, BankSemanticHit, BankTaskReceipt } from './bank-requirements';
import type { BankSearchHit } from './bank-search';
import { freezeBankResponseSlots } from './bank-slot-evidence';
import { bankReadRoleForActor, runReadBank } from './read-bank';

export type BankPassage = {
  locator: string;
  text: string;
  part_ids: string[];
  material_id?: string;
  asset_digest?: string;
  anchor?: { ref: string; revision_id: string; integrity_digest: string };
};
export type FrozenBankCandidate = {
  hit: Pick<
    BankSearchHit,
    'ref' | 'question_id' | 'group_id' | 'title' | 'automatically_servable_part_ids'
  >;
  group_id: string;
  revision_id: string | null;
  integrity_digest: string | null;
  parts: Array<{ part_id: string; material_ids: string[] }>;
  slots: ResponseSlotT[];
  passages: BankPassage[];
  blockers: Array<{ part_ids: string[]; reason: string }>;
};

/** Read authorized immutable content in the recall transaction. No model/network
 * runs until this read-only transaction has ended. No mutable reference_md is evidence. */
export async function freezeBankCandidate(
  db: Db | Tx,
  hit: FrozenBankCandidate['hit'],
  actor: ToolContext['callerActor'],
): Promise<FrozenBankCandidate> {
  const frozen: FrozenBankCandidate = {
    hit,
    group_id: hit.group_id,
    revision_id: null,
    integrity_digest: null,
    parts: [],
    slots: [],
    passages: [],
    blockers: [],
  };
  if (!hit.ref) {
    frozen.blockers.push({ part_ids: [], reason: 'unpublished_draft_has_no_immutable_revision' });
    return frozen;
  }
  const [resolved] = await resolveBankRefs(db, [hit.ref]);
  if (
    resolved?.status !== 'ok' ||
    resolved.lifecycle?.current_revision_id !== resolved.revision.revision_id
  ) {
    frozen.blockers.push({ part_ids: [], reason: 'revision_unavailable_or_changed' });
    return frozen;
  }
  if (hit.group_id && hit.group_id !== resolved.revision.group_id)
    throw new Error('candidate_ref_group_mismatch');
  frozen.group_id = resolved.revision.group_id;
  if (!hit.group_id)
    frozen.hit = { ...hit, group_id: frozen.group_id, question_id: frozen.group_id };
  frozen.revision_id = resolved.revision.revision_id;
  frozen.integrity_digest = resolved.revision.integrity_digest;
  const role = bankReadRoleForActor(actor);
  const read = await runReadBank(
    db,
    {
      refs: [hit.ref],
      include:
        role === 'restricted' ? ['content', 'materials'] : ['content', 'materials', 'answers'],
      extent: { chars: 200000 },
    },
    { role, callerRef: actor.ref },
  );
  const item = read.items[0];
  if (item?.status !== 'ok' || !item.current || !item.content) {
    frozen.blockers.push({
      part_ids: [],
      reason:
        item?.status === 'ok'
          ? 'revision_not_current_or_no_content'
          : (item?.status ?? 'read_failed'),
    });
    return frozen;
  }
  frozen.parts = item.content.parts.map((part) => ({
    part_id: part.part_id,
    material_ids: part.material_ids,
  }));
  let remaining = 90000;
  const add = (passage: BankPassage) => {
    if (/!\[|<(?:img|svg|audio|video|picture|source|iframe|object|embed)\b/i.test(passage.text))
      frozen.blockers.push({
        part_ids: passage.part_ids,
        reason: `${passage.locator}:inline_media_not_read`,
      });
    const text = passage.text.slice(0, Math.max(0, remaining));
    remaining -= text.length;
    if (text.length !== passage.text.length)
      frozen.blockers.push({
        part_ids: passage.part_ids,
        reason: 'read_character_budget_truncated',
      });
    if (text.length) frozen.passages.push({ ...passage, text });
  };
  for (const part of item.content.parts) {
    add({ locator: `part:${part.part_id}:prompt`, text: part.prompt_md, part_ids: [part.part_id] });
    if (part.extent?.complete === false)
      frozen.blockers.push({ part_ids: [part.part_id], reason: 'part_text_incomplete' });
    for (const id of part.material_ids) {
      const material = item.materials?.find((m) => m.material_id === id);
      if (!material)
        frozen.blockers.push({
          part_ids: [part.part_id],
          reason: `material:${id}:missing_or_denied`,
        });
    }
  }
  frozen.slots = freezeBankResponseSlots(item.content.slots, resolved.revision.structure, {
    add,
    block: (part_ids, reason) => frozen.blockers.push({ part_ids, reason }),
    reserve: (chars, part_ids, reason) => {
      if (chars > remaining) {
        frozen.blockers.push({ part_ids, reason });
        return false;
      }
      remaining -= chars;
      return true;
    },
  });
  for (const material of item.materials ?? []) {
    const part_ids = frozen.parts
      .filter((p) => p.material_ids.includes(material.material_id))
      .map((p) => p.part_id);
    if (
      material.content_md === undefined ||
      !material.asset.digest_verified ||
      material.text_extent?.complete === false
    ) {
      frozen.blockers.push({
        part_ids,
        reason: `material:${material.material_id}:${material.content_md === undefined ? 'media_not_read' : 'digest_or_extent_unverified'}`,
      });
      continue;
    }
    add({
      locator: `material:${material.material_id}:text`,
      text: material.content_md,
      part_ids,
      material_id: material.material_id,
      asset_digest: material.asset.digest,
    });
  }
  const leafTexts = (value: unknown, locator: string, part_ids: string[]) => {
    if (typeof value === 'string') add({ locator, text: value, part_ids });
    else if (Array.isArray(value))
      value.forEach((v, i) => {
        leafTexts(v, `${locator}/${i}`, part_ids);
      });
    else if (value && typeof value === 'object')
      for (const [key, v] of Object.entries(value))
        leafTexts(v, `${locator}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, part_ids);
  };
  for (const unit of item.answers?.units ?? []) {
    const owners = item.content.slots
      .filter((s) => unit.slot_refs.includes(s.slot_id))
      .map((s) => s.part_id);
    leafTexts(unit.criterion, `scoring:${unit.scoring_unit_id}:criterion`, [
      ...new Set(owners.length ? owners : frozen.parts.map((p) => p.part_id)),
    ]);
  }
  // Unbound or unread content cannot be made into proof by a model assertion.
  if (frozen.parts.length === 0)
    frozen.blockers.push({ part_ids: [], reason: 'no_readable_parts' });
  return frozen;
}

/** The canonical runner owns config resolution, attempts and cost. A receipt
 * refers to that actual durable row, including failed/unknown outcomes. */
export async function callBankSemanticTask(
  ctx: ToolContext,
  kind: 'BankRequirementInterpretTask' | 'BankConditionVerifyTask',
  input: unknown,
  deadline: number,
): Promise<{ value: unknown; receipt: BankTaskReceipt }> {
  const id = randomUUID();
  const runTask = makeRunTaskFn(ctx.db, {
    signal: ctx.signal,
    parentTaskRunId: ctx.taskRunId,
    providerSessionDeadlineAt: deadline,
  });
  let value: unknown = null;
  let outputDigest: string | null = null;
  let reason: string | null = null;
  let success = false;
  try {
    // Keep literal task kinds visible to the existing task census.
    const result =
      kind === 'BankRequirementInterpretTask'
        ? await runTask('BankRequirementInterpretTask', input, { taskRunId: id })
        : await runTask('BankConditionVerifyTask', input, { taskRunId: id });
    outputDigest = canonicalHash({
      text: result.text,
      structured_output: result.structured_output ?? null,
    });
    if (['length', 'max_tokens'].includes(result.finishReason))
      throw new Error('model_output_truncated');
    value = result.structured_output ?? JSON.parse(result.text);
    success = true;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const [row] = await ctx.db.select().from(ai_task_runs).where(eq(ai_task_runs.id, id)).limit(1);
  const usageBasis =
    row?.usage_json?.usage_basis ?? (row?.status === 'success' ? 'reported' : 'unknown');
  const knownCost = row?.cost_basis === 'reported' || row?.cost_basis === 'estimated';
  return {
    value,
    receipt: {
      task_kind: kind,
      task_run_id: row?.id ?? null,
      status: success ? 'success' : 'failed',
      runner_status: row?.status ?? null,
      input_tokens: usageBasis === 'unknown' ? null : (row?.usage_json?.inputTokens ?? null),
      output_tokens: usageBasis === 'unknown' ? null : (row?.usage_json?.outputTokens ?? null),
      usage_basis: usageBasis,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      input_digest: canonicalHash(input),
      output_digest: outputDigest,
      compiled_prompt_hash: row?.compiled_prompt_hash ?? null,
      cost_usd: knownCost ? (row?.cost_usd ?? null) : null,
      cost_basis:
        knownCost && row?.cost_usd != null
          ? (row.cost_basis as 'reported' | 'estimated')
          : 'unknown',
      cost_ref: row?.cost_ref ?? null,
      attempt_evidence_ref: row?.usage_json?.transport
        ? `ai_task_runs:${row.id}:usage_json.transport`
        : null,
      reason,
    },
  };
}

export function unverifiedBankHit(
  frozen: FrozenBankCandidate,
  requirements: BankRequirement[],
  rank: number,
  reason: string,
): BankSemanticHit {
  return {
    ref: frozen.hit.ref,
    question_id: frozen.hit.question_id,
    group_id: frozen.hit.group_id,
    revision_id: frozen.revision_id,
    integrity_digest: frozen.integrity_digest,
    title: frozen.hit.title,
    selected_part_ids: [],
    group: 'unverified',
    verification_status: 'not_run',
    checks: requirements.map((r) => ({
      requirement_id: r.id,
      verdict: 'unknown',
      method: 'mixed',
      reason,
      evidence: [],
    })),
    joint: { requirement_id: '$joint', verdict: 'unknown', method: 'mixed', reason, evidence: [] },
    use_availability: 'unknown',
    missing: [...new Set(frozen.blockers.map((b) => b.reason).concat(reason))],
    recall_rank: rank,
    final_rank: rank,
    preferred_supported: 0,
    task_run_ids: [],
  };
}

/** Model output is only a proposal. Exact text/offsets, complete ids, selected
 * parts and material bindings are checked here before any supported verdict. */
export function verifyBankModelOutput(
  frozen: FrozenBankCandidate,
  requirements: BankRequirement[],
  raw: unknown,
  use: 'inspect' | 'practice',
  rank: number,
): BankSemanticHit {
  const result = BankVerificationSchema.parse(raw);
  const selected = new Set(result.selected_part_ids);
  if (
    selected.size !== result.selected_part_ids.length ||
    result.selected_part_ids.some((id) => !frozen.parts.some((p) => p.part_id === id))
  )
    throw new Error('invalid_selected_parts');
  const checkIds = result.checks.map((c) => c.requirement_id);
  if (
    new Set(checkIds).size !== requirements.length ||
    checkIds.length !== requirements.length ||
    requirements.some((r) => !checkIds.includes(r.id))
  )
    throw new Error('incomplete_or_invented_requirement_ids');
  const blockers = frozen.blockers
    .filter((b) => b.part_ids.length === 0 || b.part_ids.some((id) => selected.has(id)))
    .map((b) => b.reason);
  const makeCheck = (
    check: z.infer<typeof BankVerificationSchema>['joint'],
    id: string,
  ): BankSemanticHit['joint'] => {
    const evidence = check.evidence.map((citation) => {
      const passage = frozen.passages.find((p) => p.locator === citation.locator);
      if (
        !passage ||
        (!passage.anchor &&
          (!passage.part_ids.length ||
            !(passage.material_id
              ? passage.part_ids.some((part) => selected.has(part))
              : passage.part_ids.every((part) => selected.has(part))))) ||
        citation.end <= citation.start ||
        passage.text.slice(citation.start, citation.end) !== citation.quote
      )
        throw new Error('citation_not_in_authorized_selected_content');
      return {
        ...citation,
        ref: passage.anchor?.ref ?? (frozen.hit.ref as string),
        revision_id: passage.anchor?.revision_id ?? (frozen.revision_id as string),
        integrity_digest: passage.anchor?.integrity_digest ?? (frozen.integrity_digest as string),
      };
    });
    const anchorPrefix = id.startsWith('anchor:')
      ? `${id.split(':').slice(0, 2).join(':')}:`
      : null;
    const allAnchorPrefixes = [
      ...new Set(
        frozen.passages
          .filter((p) => p.anchor)
          .map((p) => `${p.locator.split(':').slice(0, 2).join(':')}:`),
      ),
    ];
    const anchorsToCite = anchorPrefix ? [anchorPrefix] : id === '$joint' ? allAnchorPrefixes : [];
    const needsEvidence =
      check.verdict !== 'unknown' &&
      (!evidence.some((citation) => citation.ref === frozen.hit.ref) ||
        anchorsToCite.some(
          (prefix) => !evidence.some((citation) => citation.locator.startsWith(prefix)),
        ));
    return {
      requirement_id: id,
      verdict: blockers.length || needsEvidence ? 'unknown' : check.verdict,
      method: 'mixed',
      reason: blockers.length
        ? blockers.join('; ')
        : needsEvidence
          ? 'missing_candidate_or_anchor_original_evidence'
          : check.reason,
      evidence,
    };
  };
  const checks = requirements.map((r) =>
    makeCheck(
      result.checks.find((c) => c.requirement_id === r.id) as z.infer<
        typeof BankVerificationSchema
      >['joint'],
      r.id,
    ),
  );
  const joint = makeCheck(result.joint, '$joint');
  const availability =
    use === 'inspect' ||
    result.selected_part_ids.every((id) => frozen.hit.automatically_servable_part_ids.includes(id));
  const required = checks.filter(
    (c) => requirements.find((r) => r.id === c.requirement_id)?.importance === 'required',
  );
  const contradicted =
    required.some((c) => c.verdict === 'contradicted') || joint.verdict === 'contradicted';
  const supported =
    required.length > 0 &&
    required.every((c) => c.verdict === 'supported') &&
    joint.verdict === 'supported';
  return {
    ...unverifiedBankHit(frozen, requirements, rank, 'not_verified'),
    selected_part_ids: result.selected_part_ids,
    checks,
    joint,
    group: !availability
      ? 'unavailable'
      : contradicted
        ? 'contradicted'
        : supported
          ? 'matched'
          : 'unverified',
    verification_status:
      checks.some((c) => c.verdict === 'unknown') || joint.verdict === 'unknown'
        ? 'partial'
        : 'complete',
    use_availability: availability ? 'available' : 'unavailable',
    missing: blockers,
    preferred_supported: checks.filter(
      (c) =>
        c.verdict === 'supported' &&
        requirements.find((r) => r.id === c.requirement_id)?.importance === 'preferred',
    ).length,
  };
}
