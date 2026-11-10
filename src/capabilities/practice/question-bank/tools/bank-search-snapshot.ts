import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import {
  bank_search_snapshot,
  item_calibration,
  question,
  question_group_lifecycle,
  source_asset,
} from '@/db/schema';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { getAttemptedQuestionIds } from '@/kernel/read-models/question-activity';
import type { ToolContext } from '@/kernel/tools/types';
import { readBankServableParts, resolveBankRefs } from './bank-ref';
import {
  BankGapRequestSchema,
  type BankSearchScope,
  bankGapEvidenceSigningSecret,
  mintBankGapEvidenceMac,
} from './bank-search';
import {
  BANK_SEARCH_POLICY,
  type BankAssessment,
  BankAssessmentSchema,
  type BankDocument,
  BankSearchError,
  BankSearchOutputSchema,
  type BankSearchOutputV3,
  type SearchBankInput,
} from './bank-search-contract';
import { resolveBankHistoryRootIds, resolveBankSearchScope } from './bank-search-scope';
import { bankReadRoleForActor } from './read-bank';

export type BankSnapshotBinding = { question_id: string; ref: string | null; state_digest: string };
export type BankReceipt = {
  version: 3;
  policy: string;
  owner_run: string;
  request: SearchBankInput;
  scope: BankSearchScope;
  scope_digest: string;
  demand_digest: string | null;
  output: BankSearchOutputV3;
  bindings: BankSnapshotBinding[];
  documents: BankDocument[];
};
const TTL = 15 * 60_000;
const actorKey = (ctx: Pick<ToolContext, 'callerActor'>) =>
  `${ctx.callerActor.kind}:${ctx.callerActor.ref}`;
function signingKey() {
  const key = bankGapEvidenceSigningSecret();
  if (!key) throw new BankSearchError('Bank evidence signing key unavailable');
  return key;
}
function mac(body: string) {
  return createHmac('sha256', signingKey()).update(`bank-search:v3:${body}`).digest('hex');
}
function page(receipt: BankReceipt, offset: number): BankSearchOutputV3 {
  const count = receipt.request.page_size ?? 5;
  const hits = receipt.output.hits.slice(offset, offset + count);
  const next = offset + hits.length;
  const body = Buffer.from(JSON.stringify({ id: receipt.output.search_id, offset: next })).toString(
    'base64url',
  );
  return {
    ...receipt.output,
    hits,
    next_cursor: next < receipt.output.hits.length ? `${body}.${mac(body)}` : null,
  };
}
export async function captureBankSnapshotBindings(
  db: Db | Tx,
  identities: Array<{ question_id: string; ref: string | null }>,
  actor: ToolContext['callerActor'],
  calibrated = false,
  knownServable?: ReadonlyMap<string, string[]>,
): Promise<BankSnapshotBinding[]> {
  if (!identities.length) return [];
  const ids = [...new Set(identities.map((h) => h.question_id))];
  const roots = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      choices_md: question.choices_md,
      kind: question.kind,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
      difficulty: question.difficulty,
      draft_status: question.draft_status,
      archived: sql<boolean>`(${question.metadata} -> 'archived_at') IS NOT NULL`,
      dismissed: sql<boolean>`(${question.metadata} -> 'dismissed_at') IS NOT NULL`,
    })
    .from(question)
    .where(inArray(question.id, ids));
  const rootsById = new Map(roots.map((r) => [r.id, r]));
  const resolutions = await resolveBankRefs(
    db,
    identities.flatMap((h) => (h.ref ? [h.ref] : [])),
  );
  const refs = new Map(resolutions.map((r) => [r.raw, r]));
  // Only issuance decisions from this exact read snapshot may be reused.
  // Validation calls omit the cache and always read current serving state.
  const servable = new Map([
    ...(knownServable ?? []),
    ...(await readBankServableParts(
      db,
      ids.filter((id) => !knownServable?.has(id)),
    )),
  ]);
  const calibrations = calibrated
    ? await db
        .select({
          question_id: item_calibration.question_id,
          b: item_calibration.b,
          b_post: item_calibration.b_post,
          b_anchor: item_calibration.b_anchor,
        })
        .from(item_calibration)
        .where(and(inArray(item_calibration.question_id, ids), eq(item_calibration.track, 'hard')))
    : [];
  const role = bankReadRoleForActor(actor);
  const materials = resolutions.flatMap((r) =>
    r.status === 'ok'
      ? r.revision.structure.materials.filter(
          (m) => role !== 'restricted' || m.visibility !== 'private',
        )
      : [],
  );
  const assetIds = [
    ...new Set(materials.filter((m) => m.content_md == null).map((m) => m.asset.asset_id)),
  ];
  const assets = assetIds.length
    ? await db
        .select({ id: source_asset.id, sha256: source_asset.sha256 })
        .from(source_asset)
        .where(inArray(source_asset.id, assetIds))
    : [];
  const assetById = new Map(assets.map((a) => [a.id, a.sha256]));
  return identities.map((identity) => {
    const ref = identity.ref ? refs.get(identity.ref) : undefined;
    const revision = ref?.status === 'ok' ? ref.revision : undefined;
    const dependencies =
      revision?.structure.materials
        .filter((m) => role !== 'restricted' || m.visibility !== 'private')
        .map((m) => ({
          material_id: m.material_id,
          expected: m.asset.digest,
          observed:
            m.content_md == null ? (assetById.get(m.asset.asset_id) ?? null) : m.asset.digest,
        })) ?? [];
    return {
      ...identity,
      state_digest: canonicalHash({
        root: rootsById.get(identity.question_id) ?? null,
        calibration: calibrations
          .filter((row) => row.question_id === identity.question_id)
          .sort((a, b) => a.question_id.localeCompare(b.question_id)),
        resolution: ref?.status ?? (identity.ref ? 'unresolvable' : 'draft'),
        revision_id: revision?.revision_id ?? null,
        digest: revision?.integrity_digest ?? null,
        lifecycle: ref?.status === 'ok' ? ref.lifecycle : null,
        servable_parts: [...(servable.get(identity.question_id) ?? [])].sort(),
        dependencies,
      }),
    };
  });
}

async function validateReceipt(
  db: Db | Tx,
  ctx: Pick<ToolContext, 'callerActor' | 'taskRunId' | 'supplyDemand'>,
  receipt: BankReceipt,
  lock: boolean,
) {
  if (lock && receipt.bindings.length) {
    const ids = [...new Set(receipt.bindings.map((b) => b.question_id))].sort();
    await db
      .select({ id: question.id })
      .from(question)
      .where(inArray(question.id, ids))
      .orderBy(question.id)
      .for('update');
    await db
      .select({ id: question_group_lifecycle.group_id })
      .from(question_group_lifecycle)
      .where(inArray(question_group_lifecycle.group_id, ids))
      .orderBy(question_group_lifecycle.group_id)
      .for('update');
  }
  if (canonicalHash(await resolveBankSearchScope(db, receipt.scope)) !== receipt.scope_digest)
    throw new BankSearchError('Bank evidence stale: hard scope changed');
  const history = receipt.request.filters?.history;
  if (history && history !== 'any') {
    const ids = await resolveBankHistoryRootIds(
      db,
      history === 'wrong'
        ? (await getFailureAttemptsForDerivation(db, { limit: null })).map((r) => r.question_id)
        : await getAttemptedQuestionIds(db),
    );
    if (receipt.output.hits.some((h) => (history === 'wrong' ? !ids.has(h.id) : ids.has(h.id))))
      throw new BankSearchError('Bank evidence stale: learner history changed');
  }
  const now = await captureBankSnapshotBindings(
    db,
    receipt.bindings,
    ctx.callerActor,
    receipt.scope.difficulty?.basis === 'calibrated',
  );
  if (canonicalHash(now) !== canonicalHash(receipt.bindings))
    throw new BankSearchError(
      'Bank evidence stale: revision, content, materials or serving state changed',
    );
}

/** Consumers call under their write transaction, so referenced rows stay locked through issuance/claim. */
async function readBankReceipt(
  db: Db | Tx,
  ctx: Pick<ToolContext, 'callerActor' | 'taskRunId' | 'supplyDemand'>,
  id: string,
  lock = false,
  taskCompletion = false,
): Promise<BankReceipt> {
  const [row] = await db
    .select()
    .from(bank_search_snapshot)
    .where(eq(bank_search_snapshot.search_id, id))
    .limit(1);
  const ownedTaskCompletion =
    taskCompletion &&
    ctx.supplyDemand &&
    ctx.callerActor.kind === 'agent' &&
    ctx.callerActor.ref === 'question_preparer';
  if (!row || (!ownedTaskCompletion && row.expires_at.getTime() <= Date.now()))
    throw new BankSearchError('Bank evidence expired or absent');
  if (row.actor_key !== actorKey(ctx) || row.read_role !== bankReadRoleForActor(ctx.callerActor))
    throw new BankSearchError('Bank evidence belongs to a different actor or read role');
  const receipt = (row.payload as unknown as { receipt: BankReceipt }).receipt;
  if (!receipt) throw new BankSearchError('Unsupported bank evidence version');
  if (
    receipt.version !== 3 ||
    receipt.policy !== BANK_SEARCH_POLICY ||
    receipt.demand_digest !== (ctx.supplyDemand ? canonicalHash(ctx.supplyDemand) : null) ||
    receipt.owner_run !== ctx.taskRunId ||
    canonicalHash(receipt) !== row.result_digest ||
    canonicalHash(receipt.request) !== row.request_digest
  )
    throw new BankSearchError('Bank evidence integrity, version or owner mismatch');
  BankSearchOutputSchema.parse(receipt.output);
  await validateReceipt(db, ctx, receipt, lock);
  return receipt;
}
export async function saveBankReceipt(
  ctx: ToolContext,
  receipt: Omit<BankReceipt, 'version' | 'policy' | 'owner_run'>,
): Promise<BankSearchOutputV3> {
  signingKey();
  const full: BankReceipt = {
    ...receipt,
    version: 3,
    policy: BANK_SEARCH_POLICY,
    owner_run: ctx.taskRunId,
  };
  await ctx.db.transaction(
    async (tx) => {
      const asOf = new Date();
      await tx.insert(bank_search_snapshot).values({
        search_id: full.output.search_id,
        actor_key: actorKey(ctx),
        read_role: bankReadRoleForActor(ctx.callerActor),
        request_digest: canonicalHash(full.request),
        result_digest: canonicalHash(full),
        payload: { receipt: full, decisions: {} },
        as_of: asOf,
        expires_at: new Date(asOf.getTime() + TTL),
      });
      await tx.execute(
        sql`DELETE FROM ${bank_search_snapshot} WHERE search_id IN (SELECT search_id FROM ${bank_search_snapshot} WHERE expires_at <= now() - interval '1 day' ORDER BY expires_at LIMIT 10)`,
      );
    },
    { isolationLevel: 'repeatable read' },
  );
  return page(full, 0);
}
export async function resumeBankSearchSnapshot(ctx: ToolContext, cursor: string) {
  const [body, signature, extra] = cursor.split('.');
  const expected = Buffer.from(mac(body ?? ''), 'hex');
  const actual = Buffer.from(signature ?? '', 'hex');
  if (!body || extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new BankSearchError('Invalid bank cursor');
  const parsed = z
    .object({ id: z.uuid(), offset: z.number().int().positive() })
    .strict()
    .parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  return ctx.db.transaction(
    async (tx) => {
      const receipt = await readBankReceipt(tx, ctx, parsed.id);
      if (
        parsed.offset >= receipt.output.hits.length ||
        parsed.offset % (receipt.request.page_size ?? 5)
      )
        throw new BankSearchError('Invalid bank page offset');
      return page(receipt, parsed.offset);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Caller judgments remain attributed opinions; validation proves provenance and scope, not semantic truth. */
function assessBankReceipt(receipt: BankReceipt, raw: BankAssessment[]) {
  const assessments = BankAssessmentSchema.array().parse(raw);
  if (new Set(assessments.map((a) => a.ref)).size !== assessments.length)
    throw new BankSearchError('Duplicate candidate assessment');
  const accepted: string[] = [];
  const acceptedRefs: string[] = [];
  for (const assessment of assessments) {
    const hit = receipt.output.hits.find((h) => h.ref === assessment.ref);
    if (!hit?.available || assessment.parts.some((p) => !hit.parts.includes(p)))
      throw new BankSearchError('Assessment selects unavailable candidate or foreign part');
    // Missing input is a deterministic unknown, regardless of a caller's opinion.
    if (hit.missing.some((m) => assessment.parts.includes(m.part))) {
      assessment.checks = assessment.checks.map((c) => ({ ...c, verdict: 'unknown' as const }));
      assessment.joint = { ...assessment.joint, verdict: 'unknown' };
    }
    const checks = assessment.checks;
    if (
      new Set(checks.map((c) => c.condition)).size !== checks.length ||
      checks.length !== receipt.output.conditions.length ||
      checks.some((c) => !receipt.output.conditions.some((r) => r.id === c.condition))
    )
      throw new BankSearchError('Each original condition needs exactly one judgment');
    const validate = (decision: BankAssessment['joint']) => {
      if (decision.verdict === 'unknown') return;
      if (!decision.evidence.length)
        throw new BankSearchError('Judgment needs same-revision evidence');
      for (const e of decision.evidence) {
        const doc = receipt.documents.find(
          (d) => d.ref === assessment.ref && d.source === e.source,
        );
        if (
          !doc?.text.includes(e.quote) ||
          (doc.parts.length && !doc.parts.some((p) => assessment.parts.includes(p)))
        )
          throw new BankSearchError('Judgment citation is outside authorized selected content');
      }
    };
    checks.forEach(validate);
    validate(assessment.joint);
    if (
      receipt.output.conditions.some((c) => c.required) &&
      assessment.joint.verdict === 'supported' &&
      receipt.output.conditions
        .filter((c) => c.required)
        .every((c) => checks.find((v) => v.condition === c.id)?.verdict === 'supported')
    ) {
      accepted.push(...assessment.parts);
      acceptedRefs.push(assessment.ref);
    }
  }
  return {
    source: 'caller_assessed' as const,
    accepted_ids: accepted,
    accepted_refs: acceptedRefs,
    assessments,
  };
}

export async function bankReceiptGapEvidence(
  db: Db | Tx,
  ctx: Pick<ToolContext, 'callerActor' | 'taskRunId' | 'supplyDemand'>,
  searchId: string,
  assessments: BankAssessment[],
) {
  const receipt = await readBankReceipt(db, ctx, searchId, true);
  if (receipt.request.use === 'inspect' || receipt.request.use === 'dedup')
    throw new BankSearchError('Supply evidence needs a practice search');
  const decision = assessBankReceipt(receipt, assessments);
  const known = receipt.output.hits
    .filter((h) => h.available)
    .every((h) =>
      decision.assessments.some(
        (a) =>
          a.ref === h.ref &&
          a.joint.verdict !== 'unknown' &&
          receipt.output.conditions
            .filter((c) => c.required)
            .every((c) => a.checks.some((v) => v.condition === c.id && v.verdict !== 'unknown')),
      ),
    );
  const count = new Set(decision.accepted_refs).size;
  const needed = receipt.request.count;
  if (needed === undefined)
    throw new BankSearchError('Gap authorization requires an explicit requested count');
  if (count >= needed)
    throw new BankSearchError('The assessed stock already satisfies the requested count');
  // Demand dispatch retains its signed legacy internal contract; models only carry the receipt id.
  const unsigned = BankGapRequestSchema.parse({
    target_contract: 'EvidenceDemandV1',
    status: 'needs_agent_context_and_filing_tool',
    claim: { kind: 'content_coverage', statement: receipt.request.query },
    inventory_goal: { eligible_count: needed },
    causes: [{ kind: 'coverage_gap' }],
    constraints: {
      query: receipt.request.query,
      scope: receipt.scope,
      requested_count: needed,
      retrieved_count: count,
      reason: 'insufficient_retrieved_candidates',
    },
    required_context: [],
    complete: receipt.output.coverage.complete && known,
    retrieval_truncated: !receipt.output.coverage.complete,
    unavailable_channels: receipt.output.coverage.unavailable,
  });
  const observation = {
    ...unsigned,
    search_id: searchId,
    assessment_digest: canonicalHash(decision),
    decision_source: 'caller_assessed' as const,
    semantic_conditions: receipt.output.conditions,
    unsupported_constraints: [] as string[],
  };
  observation.unsupported_constraints = [
    ...(receipt.request.filters?.terms?.length
      ? [`literal_terms:${JSON.stringify(receipt.request.filters.terms)}`]
      : []),
    ...(receipt.request.filters?.history && receipt.request.filters.history !== 'any'
      ? [`history:${receipt.request.filters.history}`]
      : []),
  ];
  const evidence = {
    ...observation,
    evidence_mac: mintBankGapEvidenceMac(observation) ?? undefined,
  };
  await recordBankDecision(db, searchId, decision);
  return { evidence, search_id: searchId };
}

/** Keep quoted answer evidence in the server receipt, never artifact/page metadata. */
async function recordBankDecision(
  db: Db | Tx,
  searchId: string,
  decision: ReturnType<typeof assessBankReceipt>,
) {
  const digest = canonicalHash(decision);
  await db
    .update(bank_search_snapshot)
    .set({
      payload: sql`jsonb_set(${bank_search_snapshot.payload}, ARRAY['decisions', ${digest}]::text[], ${JSON.stringify(decision)}::jsonb, true)`,
    })
    .where(eq(bank_search_snapshot.search_id, searchId));
  return digest;
}

export async function selectBankReceipt(
  db: Db | Tx,
  ctx: Pick<ToolContext, 'callerActor' | 'taskRunId' | 'supplyDemand'>,
  searchId: string,
  assessments: BankAssessment[],
  lock = false,
  taskCompletion = false,
) {
  const receipt = await readBankReceipt(db, ctx, searchId, lock, taskCompletion);
  if (receipt.request.use === 'inspect' || receipt.request.use === 'dedup')
    throw new BankSearchError('Paper and stock selection require practice or inventory evidence');
  const selection = assessBankReceipt(receipt, assessments);
  if (lock) await recordBankDecision(db, searchId, selection);
  return {
    source: selection.source,
    use: receipt.request.use,
    goal: receipt.request.count,
    accepted_refs: selection.accepted_refs,
    accepted_ids: selection.accepted_ids,
    part_refs: Object.fromEntries(
      assessments
        .filter((a) => a.parts.every((p) => selection.accepted_ids.includes(p)))
        .flatMap((a) => a.parts.map((part) => [part, a.ref])),
    ),
  };
}
