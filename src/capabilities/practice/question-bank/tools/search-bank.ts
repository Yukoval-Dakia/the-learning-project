import { randomUUID } from 'node:crypto';
import { type SQL, inArray, notInArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { item_calibration, question } from '@/db/schema';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { getAttemptedQuestionIds } from '@/kernel/read-models/question-activity';
import { allowedQuestionIds, sourceAllowsDerivationSql } from '@/kernel/read-models/usage-policy';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { EMBED_MODEL, embedText } from '@/server/ai/embed';
import { resolveBankRefs } from './bank-ref';
import { type BankSearchScope, runSearchBank } from './bank-search';
import {
  type BankDocument,
  BankSearchOutputSchema,
  type BankSearchOutputV3,
  type SearchBankInput,
  SearchBankInputSchema,
} from './bank-search-contract';
import { readBankDocuments } from './bank-search-evidence';
import { resolveBankHistoryRootIds, resolveBankSearchScope } from './bank-search-scope';
import {
  type BankReceipt,
  type BankSnapshotBinding,
  captureBankSnapshotBindings,
  resumeBankSearchSnapshot,
  saveBankReceipt,
} from './bank-search-snapshot';
import { bankReadRoleForActor, callerIsDerivationSurface } from './read-bank';

const queryVectors = new WeakMap<Db, Map<string, { value: number[]; expires: number }>>();
/** Benchmark cold cohorts clear only query reuse, never change retrieval or provider routing. */
export function clearBankQueryCache(db: Db) {
  queryVectors.delete(db);
}
async function queryVector(ctx: ToolContext, text: string) {
  const cache = queryVectors.get(ctx.db) ?? new Map<string, { value: number[]; expires: number }>();
  queryVectors.set(ctx.db, cache);
  const key = JSON.stringify([
    EMBED_MODEL,
    process.env.MEM0_EMBEDDING_BASE_URL ?? '',
    text.normalize('NFKC').trim(),
  ]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await embedText(text, {
    db: ctx.db,
    caller: 'api',
    deadlineAt: new Date(ctx.providerSessionDeadlineAt ?? Date.now() + 20_000),
    signal: ctx.signal,
  });
  if (cache.size >= 256) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, expires: Date.now() + 60 * 60_000 });
  return value;
}
export async function collectBankSearchReceipt(
  ctx: ToolContext,
  raw: SearchBankInput,
  ablation?: {
    embedFn?: (text: string) => Promise<number[]>;
    vectors: 'off' | 'content' | 'prior';
  },
): Promise<Omit<BankReceipt, 'version' | 'policy' | 'owner_run'>> {
  const input = SearchBankInputSchema.parse(raw);
  if (input.cursor) throw new Error('Evidence collection needs a new query');
  input.use ??=
    ctx.callerActor.ref.replace(/^agent:/, '') === 'question_preparer' ? 'inventory' : 'practice';
  input.page_size ??= input.use === 'inventory' ? 10 : 5;
  const demand = input.use === 'inventory' ? ctx.supplyDemand : undefined;
  if (demand) {
    if (input.count !== undefined && input.count !== demand.inventory_goal.eligible_count)
      throw new Error('Inventory count must match the bound ticket');
    input.count = demand.inventory_goal.eligible_count;
    const f = input.filters ?? {};
    const same = (a: string[], b: string[]) =>
      JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
    if (f.subject !== undefined && f.subject !== demand.subject_id)
      throw new Error('Inventory subject differs from ticket');
    if (f.knowledge_ids && !same(f.knowledge_ids, demand.claim.knowledge_ids))
      throw new Error('Inventory KCs differ from ticket');
    if (f.knowledge_mode === 'any' && demand.claim.knowledge_ids.length > 1)
      throw new Error('Inventory ticket requires every KC on the same question');
    if (
      !demand.task.kinds.includes('any') &&
      (f.kind !== undefined || (f.kinds && !same(f.kinds, demand.task.kinds)))
    )
      throw new Error('Inventory kinds must preserve the ticket union');
    input.filters = {
      ...f,
      subject: demand.subject_id,
      knowledge_ids: demand.claim.knowledge_ids,
      knowledge_mode: 'all',
      ...(demand.task.kinds.includes('any') ? {} : { kinds: demand.task.kinds }),
    };
  }
  const query = input.query?.trim();
  if (!query) throw new Error('query is required');
  const { terms, history, ...filters } = input.filters ?? {};
  const scope: BankSearchScope = {
    ...filters,
    knowledge_mode: filters.knowledge_mode ?? (input.use === 'inventory' ? 'all' : 'any'),
    draft_state: input.use === 'inspect' || input.use === 'dedup' ? 'all' : 'active',
    admission_state: input.use === 'inspect' || input.use === 'dedup' ? 'any' : 'admitted',
    ...(input.like_ref
      ? { similar_to: { question_ref: input.like_ref, aspect: 'content' as const } }
      : {}),
  };
  const predicates: SQL[] = (terms ?? []).map(
    (term) => sql`position(lower(${term}) in lower(${question.prompt_md})) > 0`,
  );
  // Derivation surfaces (question_preparer) read the bank to author OTHER questions;
  // restricted lineage is excluded inside the scope WHERE so it never enters the
  // candidate pool, the frozen snapshot, or a page — submit-side dedup stays
  // authoritative for rows hidden this way.
  if (callerIsDerivationSurface(ctx.callerActor)) {
    predicates.push(sourceAllowsDerivationSql({ kind: 'question', id: question.id }));
  }
  if (history && history !== 'any') {
    if (ctx.ticketEventId) throw new Error('Ticket-bound preparation cannot query learner history');
    const memberIds =
      history === 'wrong'
        ? [
            ...new Set(
              (await getFailureAttemptsForDerivation(ctx.db, { limit: null })).map(
                (r) => r.question_id,
              ),
            ),
          ]
        : await getAttemptedQuestionIds(ctx.db);
    const ids = await resolveBankHistoryRootIds(ctx.db, memberIds);
    predicates.push(
      history === 'wrong'
        ? ids.size
          ? inArray(question.id, [...ids])
          : sql`false`
        : ids.size
          ? notInArray(question.id, [...ids])
          : sql`true`,
    );
  }
  const boundCondition = demand
    ? `${demand.claim.statement}\nTicket constraints: ${JSON.stringify({ task: demand.task, difficulty: demand.difficulty, observables: demand.evidence.observables })}`
    : '';
  const requirements = demand
    ? [
        { text: boundCondition, required: true },
        ...(input.conditions ?? []).filter(
          (c) => c.text !== demand.claim.statement && c.text !== boundCondition,
        ),
      ]
    : (input.conditions ?? [{ text: query, required: true }]);
  if (requirements.length > 10)
    throw new Error('Bound ticket plus extra conditions exceeds 10; do not drop conditions');
  if (
    (input.use === 'practice' || input.use === 'inventory') &&
    !requirements.some((c) => c.required)
  )
    throw new Error('Practice and inventory need at least one required condition');
  let bindings: BankSnapshotBinding[] = [];
  let scopeDigest = '';
  let documents: BankDocument[] = [];
  let calibratedValues = new Map<string, number | null>();
  const recall = await runSearchBank(
    ctx.db,
    { form: 'new', query, scope, limit: input.page_size ?? 5 },
    {
      fullPool: true,
      priorFacets: ablation?.vectors !== 'content' && ablation?.vectors !== 'off',
      disableVectors: ablation?.vectors === 'off',
      predicates,
      publicOnly: bankReadRoleForActor(ctx.callerActor) === 'restricted',
      embedFn: ablation?.embedFn ?? ((text) => queryVector(ctx, text)),
      onPoolFrozen: async (tx, pool, servable) => {
        const calibrated =
          scope.difficulty?.basis === 'calibrated' && pool.hits.length
            ? await tx
                .select({
                  id: item_calibration.question_id,
                  value: sql<
                    number | null
                  >`coalesce(${item_calibration.b_post},${item_calibration.b_anchor},${item_calibration.b})`,
                })
                .from(item_calibration)
                .where(
                  sql`${item_calibration.track}='hard' AND ${inArray(
                    item_calibration.question_id,
                    pool.hits.map((h) => h.question_id),
                  )}`,
                )
            : [];
        calibratedValues = new Map(calibrated.map((c) => [c.id, c.value]));

        scopeDigest = canonicalHash(await resolveBankSearchScope(tx, scope));
        const [anchor] = input.like_ref ? await resolveBankRefs(tx, [input.like_ref]) : [];
        const anchors =
          anchor?.status === 'ok'
            ? [{ question_id: anchor.revision.group_id, ref: anchor.raw }]
            : [];
        bindings = await captureBankSnapshotBindings(
          tx,
          [
            ...anchors,
            ...pool.hits.flatMap((h) => [
              h,
              ...h.automatically_servable_part_ids
                .filter((id) => id !== h.question_id)
                .map((id) => ({ question_id: id, ref: h.ref })),
            ]),
          ],
          ctx.callerActor,
          scope.difficulty?.basis === 'calibrated',
          servable,
        );
        documents = await readBankDocuments(
          tx,
          ctx,
          pool.hits.flatMap((h) => (h.ref ? [h.ref] : [])),
        );
      },
    },
  );
  const conditions = requirements.map((c, i) => ({
    id: `r${i + 1}`,
    ...c,
  }));
  const factsFor = (hit: (typeof recall.hits)[number]) => ({
    source: `facts:${hit.question_id}`,
    kind: hit.question_kind,
    draft_status: hit.draft_status,
    admission: hit.admission?.state ?? null,
    withheld_reason: hit.admission?.withheld_reason ?? null,
    suspended: hit.suspended,
    knowledge_ids: hit.knowledge_ids,
    difficulty:
      scope.difficulty?.basis === 'calibrated'
        ? { basis: 'calibrated' as const, value: calibratedValues.get(hit.question_id) ?? null }
        : { basis: 'authored' as const, value: hit.difficulty },
  });
  for (const hit of recall.hits)
    if (hit.ref) {
      const facts = factsFor(hit);
      documents.push({
        ref: hit.ref,
        source: facts.source,
        text: JSON.stringify(facts),
        parts: hit.automatically_servable_part_ids,
      });
    }
  const output = BankSearchOutputSchema.parse({
    contract_version: 3,
    search_id: randomUUID(),
    goal: { use: input.use, count: input.count ?? null },
    conditions,
    decision_source: 'caller_assessed',
    hits: recall.hits.map((hit) => ({
      id: hit.question_id,
      ref: hit.ref,
      title: hit.title,
      parts: hit.automatically_servable_part_ids,
      available: hit.automatically_servable_part_ids.length > 0,
      missing: [
        ...documents
          .filter((d) => d.ref === hit.ref)
          .flatMap((d) =>
            (d.missing ?? []).flatMap((reason) => d.parts.map((part) => ({ part, reason }))),
          ),
        ...hit.automatically_servable_part_ids
          .filter(
            (part) => !documents.some((d) => d.ref === hit.ref && d.source === `part:${part}`),
          )
          .map((part) => ({ part, reason: 'part_text_unread' })),
      ],
      facts: factsFor(hit),
      evidence: documents
        .filter(
          (d) =>
            d.ref === hit.ref && (d.source.startsWith('part:') || d.source.startsWith('prior:')),
        )
        .slice(0, 2)
        .map((d) => ({
          source: d.source,
          text: d.text.slice(0, 180),
          complete: d.complete !== false && d.text.length <= 180,
        })),
    })),
    coverage: {
      candidates: recall.hits.length,
      complete:
        !recall.coverage.retrieval_truncated && !recall.coverage.unavailable_channels.length,
      unavailable: recall.coverage.unavailable_channels,
      prior: {
        requested:
          ablation?.vectors !== 'off' &&
          ablation?.vectors !== 'content' &&
          bankReadRoleForActor(ctx.callerActor) !== 'restricted',
        missing_channels: ['method', 'pitfall'].filter(
          (channel) => !recall.coverage.recall_scan?.some((c) => c.channel === channel),
        ),
        missing_refs: recall.hits.flatMap((h) =>
          h.ref && !documents.some((d) => d.ref === h.ref && d.source.startsWith('prior:'))
            ? [h.ref]
            : [],
        ),
      },
      enforced: [
        ...recall.requirements.enforced,
        ...(terms?.length ? ['literal_prompt_terms'] : []),
        ...(history && history !== 'any' ? [`history:${history}`] : []),
      ],
      absence: 'not_established',
    },
    next_cursor: null,
  });
  return {
    request: input,
    scope,
    scope_digest: scopeDigest,
    demand_digest: ctx.supplyDemand ? canonicalHash(ctx.supplyDemand) : null,
    output,
    bindings,
    documents,
  };
}
export async function runBankSearchV3(
  ctx: ToolContext,
  raw: SearchBankInput,
  ablation?: { vectors: 'off' | 'content' | 'prior' },
) {
  const input = SearchBankInputSchema.parse(raw);
  const output = input.cursor
    ? await resumeBankSearchSnapshot(ctx, input.cursor)
    : await saveBankReceipt(ctx, await collectBankSearchReceipt(ctx, input, ablation));
  // Resume-path guard: snapshots frozen before the scope predicate took effect (or
  // any pool assembled outside collectBankSearchReceipt) still cannot leak restricted
  // hits to derivation surfaces.
  if (callerIsDerivationSurface(ctx.callerActor) && output.hits.length > 0) {
    const allowed = await allowedQuestionIds(
      ctx.db,
      output.hits.map((hit) => hit.id),
    );
    output.hits = output.hits.filter((hit) => allowed.has(hit.id));
  }
  return output;
}
export const searchBankTool: DomainTool<SearchBankInput, BankSearchOutputV3> = {
  name: 'search_bank',
  description:
    'Question preparation comes first. inventory searches admitted/servable stock for a gap ticket; dedup searches active, pending/withheld and draft candidates before adding a question. Defaults: question_preparer uses inventory (10/page), other callers practice (5/page); explicit page_size overrides only pagination, never the inventory goal. Copy the ticket goal into count, its subject/KCs/kinds into filters; inventory KCs default to all on ONE question. kinds is an allowed-type union, not one question of every kind. For dedup broaden KC/kind filters to avoid missing mislabeled duplicates; ref=null means an unread unpublished draft, never proof of no duplicate. scan_coverage_gaps owns pending-stock reservations; submit_question retains authoritative exact/source/vector dedup and admission. This tool does no interpretation/verification model calls. query is the retrieval text; conditions preserve required/preferred ticket semantics, judged by the caller with same-question joint evidence. Numeric difficulty filters need a known scale/range; do not invent a range from a relative band. Read content/materials, answers/rubric and solution_prior by returned ref as needed. Practice/inventory require at least one required condition. missing lists per-part blockers; server forces their judgments unknown. Excerpts mark complete; truncated/unread/unknown/contradicted never qualify. Facts describe inventory status, not semantic suitability; cite facts.source with exact value text for structured evidence. Cursor-only continues this snapshot. search_id plus cited assessments connects file_bank_gap/write_quiz; file_bank_gap creates the preparer ticket and is not recursively called by the preparer. Incomplete/empty recall never proves corpus absence. Do not reveal answers/methods to the learner before their judgment',
  effect: 'read',
  inputSchema: SearchBankInputSchema,
  outputSchema: BankSearchOutputSchema,
  costClass: 'cheap_llm',
  execute: runBankSearchV3,
  summarize: (_input, output) => `找题 · ${output.hits.length} 道候选`,
  mirrorEvent: 'when_user_visible',
};
