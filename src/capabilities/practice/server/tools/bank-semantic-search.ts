import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { ToolContext } from '@/kernel/tools/types';
import { BankInterpretationSchema } from '../../tasks/bank-search-semantic';
import {
  BANK_SEARCH_WALL_MS,
  BANK_SEMANTIC_POLICY,
  BANK_VERIFICATION_CAP,
  type BankRequirement,
  BankSearchV2Error,
  type BankSearchV2New,
  BankSearchV2NewSchema,
  type BankSearchV2Output,
  BankSearchV2OutputSchema,
  type BankSemanticHit,
  type BankTaskReceipt,
} from './bank-requirements';
import { type BankSearchOutput, type BankSearchScope, runSearchBank } from './bank-search';
import { resolveBankSearchScope } from './bank-search-scope';
import {
  type BankSnapshotBinding,
  bankSnapshotExpiry,
  bankSnapshotScopeDigest,
  captureBankSnapshotBindings,
  pruneBankSearchSnapshots,
  requireBankSnapshotSigningKey,
  storeBankSearchSnapshot,
} from './bank-search-snapshot';
import {
  type FrozenBankCandidate,
  callBankSemanticTask,
  freezeBankCandidate,
  unverifiedBankHit,
  verifyBankModelOutput,
} from './bank-verification';
import { bankReadRoleForActor } from './read-bank';

async function interpret(
  ctx: ToolContext,
  input: BankSearchV2New,
  deadline: number,
  receipts: BankTaskReceipt[],
) {
  if (input.requirements)
    return BankInterpretationSchema.parse({
      status: 'ready',
      requirements: input.requirements,
      spans: [],
      unresolved: [],
    });
  const call = await callBankSemanticTask(
    ctx,
    'BankRequirementInterpretTask',
    { query: input.query, policy_version: BANK_SEMANTIC_POLICY },
    deadline,
  );
  receipts.push(call.receipt);
  const parsed = BankInterpretationSchema.safeParse(call.value);
  if (!parsed.success || call.receipt.status !== 'success') {
    call.receipt.status = 'failed';
    call.receipt.reason ??= 'interpretation_output_schema_invalid';
    return BankInterpretationSchema.parse({
      status: 'needs_clarification',
      requirements: [],
      spans: [],
      unresolved: ['Query interpretation failed; provide explicit structured requirements.'],
    });
  }
  const result = parsed.data;
  const ids = result.requirements.map((r) => r.id);
  const valid =
    new Set(ids).size === ids.length &&
    !ids.some((id) => id.startsWith('anchor:') || id === '$joint') &&
    result.requirements.some((r) => r.importance === 'required') &&
    result.unresolved.length === 0 &&
    result.spans.every(
      (span) =>
        ids.includes(span.requirement_id) &&
        span.end > span.start &&
        input.query.slice(span.start, span.end) === span.quote,
    ) &&
    ids.every((id) => result.spans.some((span) => span.requirement_id === id));
  if (!valid) {
    result.status = 'needs_clarification';
    result.unresolved.push(
      'Interpretation has missing/invalid original spans, unresolved conditions or no required condition; no satisfaction claim is authorized.',
    );
  }
  return result;
}

/** The sole live v2 search chain. It owns no learner reads, gap writes,
 * generation, quiz selection or issuance. */
export async function runBankSemanticSearch(
  ctx: ToolContext,
  raw: BankSearchV2New,
): Promise<BankSearchV2Output> {
  const input = BankSearchV2NewSchema.parse(raw);
  requireBankSnapshotSigningKey();
  if (input.need?.demand_id || input.need?.demand_revision || input.need?.definition_digest)
    throw new BankSearchV2Error(
      'unsupported_demand_binding',
      'Registered demand authority belongs to the remaining gap slice. This search accepts an unregistered count only and cannot issue a gap/issuance receipt.',
    );
  if (input.supersedes_search_id)
    throw new BankSearchV2Error(
      'unsupported_predecessor',
      'Persistent same-demand predecessor authorization is not connected in this search slice; start an explicit independent search.',
    );
  // Confirm the operational snapshot seam before any paid task/embedding.
  try {
    await pruneBankSearchSnapshots(ctx.db);
  } catch {
    throw new BankSearchV2Error(
      'snapshot_unavailable',
      'Semantic snapshot storage is unavailable; no task or embedding was started.',
    );
  }
  const started = Date.now();
  const deadline = Math.min(
    started + BANK_SEARCH_WALL_MS,
    ctx.providerSessionDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  // Practice always applies the real serving gate before each channel's K cap.
  const scope: BankSearchScope = {
    ...input.scope,
    draft_state: input.scope?.draft_state ?? (input.use === 'practice' ? 'active' : 'all'),
    admission_state:
      input.use === 'practice' ? 'admitted' : (input.scope?.admission_state ?? 'any'),
  };
  try {
    await resolveBankSearchScope(ctx.db, scope);
  } catch (error) {
    throw new BankSearchV2Error(
      'invalid_request',
      error instanceof Error ? error.message : String(error),
    );
  }
  const receipts: BankTaskReceipt[] = [];
  const interpretation = await interpret(ctx, input, deadline, receipts);
  if (interpretation.requirements.length + (input.anchors?.length ?? 0) * 2 > 30) {
    interpretation.status = 'needs_clarification';
    interpretation.unresolved.push(
      'Combined interpreted and anchor conditions exceed this policy limit; split the explicit request.',
    );
  }
  const requirements: BankRequirement[] = [...interpretation.requirements];
  for (const [index, anchor] of (input.anchors ?? []).entries()) {
    requirements.push({
      id: `anchor:${index}:preserve`,
      statement: `与锚题 ${anchor.question_ref} 对比，保持：${anchor.preserve}`,
      importance: 'required',
    });
    requirements.push({
      id: `anchor:${index}:change`,
      statement: `与锚题 ${anchor.question_ref} 对比，改变：${anchor.change}`,
      importance: 'required',
    });
  }
  const frozen: FrozenBankCandidate[] = [];
  const anchors: FrozenBankCandidate[] = [];
  let bindings: BankSnapshotBinding[] = [];
  let scopeDigest = '';
  let frozenAt = started;
  const recall: BankSearchOutput = await runSearchBank(
    ctx.db,
    { form: 'new', query: input.query, scope, limit: input.page_size },
    {
      deadlineAt: deadline,
      providerAttemptCaller: ctx.providerAttemptCaller,
      onSnapshotOpened: async (tx) => {
        // Force the PG snapshot now, and report the database observation time.
        scopeDigest = await bankSnapshotScopeDigest(tx, input);
        const observed = await tx.execute<{ observed_at: string }>(
          sql`SELECT transaction_timestamp()::text AS observed_at`,
        );
        frozenAt = new Date(observed[0].observed_at).getTime();
      },
      fullPool: true,
      publicOnly: bankReadRoleForActor(ctx.callerActor) === 'restricted',
      onPoolFrozen: async (tx, pool) => {
        for (const anchor of input.anchors ?? []) {
          // A ref, never a mutable question pointer or an upgraded reader role.
          const read = await freezeBankCandidate(
            tx,
            {
              question_id: '',
              group_id: '',
              ref: anchor.question_ref,
              title: 'versioned anchor',
              automatically_servable_part_ids: [],
            },
            ctx.callerActor,
          );
          if (
            !read.revision_id ||
            !read.parts.length ||
            read.blockers.length ||
            read.passages.reduce((sum, p) => sum + p.text.length, 0) +
              JSON.stringify(read.slots).length >
              50000
          )
            throw new BankSearchV2Error(
              'anchor_unavailable',
              'Anchor is stale, inaccessible, incomplete or requires unread media.',
            );
          // Resolve its root from the same immutable read, not from a caller id.
          anchors.push(read);
        }
        for (const hit of pool.hits) {
          if (frozen.length < BANK_VERIFICATION_CAP)
            frozen.push(await freezeBankCandidate(tx, hit, ctx.callerActor));
          else
            frozen.push({
              hit,
              group_id: hit.group_id,
              revision_id: hit.revision_id ?? null,
              integrity_digest: hit.integrity_digest ?? null,
              parts: [],
              slots: [],
              passages: [],
              blockers: [],
            });
        }
        bindings = await captureBankSnapshotBindings(
          tx,
          [...pool.hits, ...anchors.map((a) => a.hit)].map(({ question_id, ref }) => ({
            question_id,
            ref,
          })),
          ctx.callerActor,
          input.scope?.difficulty?.basis === 'calibrated',
        );
      },
    },
  );
  const hits: BankSemanticHit[] = [];
  let checked = 0;
  let matched = 0;
  let stop =
    interpretation.status !== 'ready'
      ? 'interpretation_needs_clarification'
      : 'candidate_pool_processed';
  let halted = interpretation.status !== 'ready';
  for (const [index, candidate] of frozen.entries()) {
    if (!halted && (Date.now() >= deadline || ctx.signal?.aborted)) {
      halted = true;
      stop = 'wall_clock_or_cancelled';
    }
    if (!halted && index >= BANK_VERIFICATION_CAP) {
      halted = true;
      stop = 'verification_budget';
    }
    if (!halted && input.need && matched >= input.need.count) {
      halted = true;
      stop = 'need_met';
    }
    if (halted || !candidate.revision_id || !candidate.parts.length) {
      hits.push(
        unverifiedBankHit(
          candidate,
          requirements,
          index + 1,
          halted ? stop : 'no_readable_immutable_revision',
        ),
      );
      continue;
    }
    const passages = [...candidate.passages];
    for (const [anchorIndex, anchor] of anchors.entries()) {
      for (const passage of anchor.passages)
        passages.push({
          ...passage,
          locator: `anchor:${anchorIndex}:${passage.locator}`,
          part_ids: [],
          anchor: {
            ref: anchor.hit.ref as string,
            revision_id: anchor.revision_id as string,
            integrity_digest: anchor.integrity_digest as string,
          },
        });
    }
    const anchorInput = (input.anchors ?? []).map((a, i) => ({
      ...a,
      locator_prefix: `anchor:${i}:`,
      ref: anchors[i].hit.ref,
      revision_id: anchors[i].revision_id,
      integrity_digest: anchors[i].integrity_digest,
      parts: anchors[i].parts,
      slots: anchors[i].slots,
    }));
    if (
      passages.reduce((sum, passage) => sum + passage.text.length, 0) +
        JSON.stringify(candidate.slots).length +
        JSON.stringify(anchorInput).length >
      120000
    ) {
      hits.push(
        unverifiedBankHit(
          candidate,
          requirements,
          index + 1,
          'verification_input_character_budget',
        ),
      );
      stop = 'verification_input_character_budget';
      continue;
    }
    const candidateInput = { ...candidate, passages };
    checked++;
    const call = await callBankSemanticTask(
      ctx,
      'BankConditionVerifyTask',
      {
        query: input.query,
        requirements,
        use: input.use,
        policy_version: BANK_SEMANTIC_POLICY,
        ref: candidate.hit.ref,
        revision_id: candidate.revision_id,
        integrity_digest: candidate.integrity_digest,
        parts: candidate.parts,
        slots: candidate.slots,
        passages,
        missing: candidate.blockers,
        anchors: anchorInput,
      },
      deadline,
    );
    receipts.push(call.receipt);
    let result: BankSemanticHit;
    try {
      if (call.receipt.status !== 'success') throw new Error(call.receipt.reason ?? 'task_failed');
      result = verifyBankModelOutput(
        candidateInput,
        requirements,
        call.value,
        input.use,
        index + 1,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result = unverifiedBankHit(candidate, requirements, index + 1, reason);
      result.verification_status = 'failed';
      call.receipt.status = 'failed';
      call.receipt.reason = reason;
      halted = true;
      stop = 'verification_failed_no_retry';
    }
    result.task_run_ids = call.receipt.task_run_id ? [call.receipt.task_run_id] : [];
    if (result.group === 'matched') matched++;
    hits.push(result);
  }
  const order = { matched: 0, unverified: 1, contradicted: 2, unavailable: 3 };
  hits.sort(
    (a, b) =>
      order[a.group] - order[b.group] ||
      (a.group === 'matched' ? b.preferred_supported - a.preferred_supported : 0) ||
      a.recall_rank - b.recall_rank ||
      a.group_id.localeCompare(b.group_id),
  );
  hits.forEach((hit, i) => {
    hit.final_rank = i + 1;
  });
  const unverified = hits.filter((h) => h.group === 'unverified').length;
  const indexMissing = ['revision_material_long_text_visibility_projections_not_delivered'];
  const incomplete =
    recall.coverage.retrieval_truncated ||
    recall.coverage.unavailable_channels.length > 0 ||
    indexMissing.length > 0;
  const needed = input.need?.count ?? null;
  const fulfillment =
    needed === null
      ? 'not_assessed'
      : interpretation.status !== 'ready'
        ? 'undetermined'
        : matched >= needed
          ? 'met'
          : matched > 0
            ? 'partial'
            : unverified > 0 || incomplete || hits.length === 0
              ? 'undetermined'
              : 'unmet';
  const requestDigest = canonicalHash({
    input,
    requirements,
    interpretation,
    policy_version: BANK_SEMANTIC_POLICY,
    role: bankReadRoleForActor(ctx.callerActor),
  });
  const output = BankSearchV2OutputSchema.parse({
    contract_version: 2,
    status: 'ok',
    policy_version: BANK_SEMANTIC_POLICY,
    search_id: randomUUID(),
    as_of: new Date(frozenAt).toISOString(),
    expires_at: bankSnapshotExpiry(frozenAt),
    request_digest: requestDigest,
    result_digest: '',
    original_request: input,
    canonical_demand_text: input.query,
    interpretation,
    requirements: {
      conditions: requirements,
      enforced: recall.requirements.enforced.filter((s) => !s.startsWith('similar_to')),
      not_verified: [
        ...requirements
          .filter(
            (r) =>
              !hits.length ||
              hits.some(
                (h) => h.checks.find((c) => c.requirement_id === r.id)?.verdict !== 'supported',
              ),
          )
          .map((r) => r.id),
        'unrecalled_content_and_cross_question_combination_requirements',
      ],
    },
    scope_applied: JSON.parse(JSON.stringify(recall.scope_applied)),
    hits,
    fulfillment,
    matched_count: matched,
    needed_count: needed,
    remaining_count: needed === null ? null : Math.max(0, needed - matched),
    unverified_count: unverified,
    evidence: {
      candidate_count: hits.length,
      checked_count: checked,
      retrieval_truncated: recall.coverage.retrieval_truncated,
      verification_truncated: hits.some((h) => h.verification_status === 'not_run'),
      unavailable_channels: recall.coverage.unavailable_channels,
      vector_reason:
        bankReadRoleForActor(ctx.callerActor) === 'restricted'
          ? 'legacy_vector_contains_private_answers_no_visibility_projection'
          : recall.coverage.unavailable_channels.includes('vector')
            ? 'embedding_or_anchor_vector_unavailable'
            : null,
      recall_scan: recall.coverage.recall_scan ?? [],
      index_generation: 'legacy_question_projection_unversioned',
      index_missing: indexMissing,
      stop_reason: stop,
      absence: 'not_established',
      reasons: [
        ...(incomplete ? ['retrieval_incomplete'] : []),
        ...(unverified ? ['evidence_missing'] : []),
        ...(hits.some((h) => h.group === 'unavailable') ? ['content_unavailable'] : []),
        ...(needed !== null && matched < needed ? ['requirement_unmet'] : []),
      ],
      task_receipts: receipts,
      evidence_ref: null,
      redeemable_for_gap_or_issuance: false,
    },
    page: { page_size: input.page_size, offset: 0, has_more: false, next_cursor: null },
    proposed_demand_definition: {
      definition_digest: canonicalHash({
        original_query: input.query,
        requirements,
        scope,
        use: input.use,
        anchors: input.anchors ?? [],
        need: input.need ?? null,
      }),
      redeemable: false,
    },
  });
  return storeBankSearchSnapshot(ctx, output, bindings, scopeDigest);
}
