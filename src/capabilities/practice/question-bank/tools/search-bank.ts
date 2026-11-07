import { randomUUID } from 'node:crypto';
import { type SQL, inArray, notInArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { getAttemptedQuestionIds } from '@/kernel/read-models/question-activity';
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
import { resolveBankSearchScope } from './bank-search-scope';
import {
  type BankReceipt,
  type BankSnapshotBinding,
  captureBankSnapshotBindings,
  resumeBankSearchSnapshot,
  saveBankReceipt,
} from './bank-search-snapshot';
import { bankReadRoleForActor } from './read-bank';

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
  const query = input.query?.trim();
  if (!query) throw new Error('query is required');
  const { terms, history, ...filters } = input.filters ?? {};
  const scope: BankSearchScope = {
    ...filters,
    draft_state: input.use === 'inspect' ? 'all' : 'active',
    admission_state: input.use === 'inspect' ? 'any' : 'admitted',
    ...(input.like_ref
      ? { similar_to: { question_ref: input.like_ref, aspect: 'content' as const } }
      : {}),
  };
  const predicates: SQL[] = (terms ?? []).map(
    (term) => sql`position(lower(${term}) in lower(${question.prompt_md})) > 0`,
  );
  if (history && history !== 'any') {
    if (ctx.ticketEventId) throw new Error('Ticket-bound preparation cannot query learner history');
    const ids =
      history === 'wrong'
        ? [
            ...new Set(
              (await getFailureAttemptsForDerivation(ctx.db, { limit: null })).map(
                (r) => r.question_id,
              ),
            ),
          ]
        : await getAttemptedQuestionIds(ctx.db);
    predicates.push(
      history === 'wrong'
        ? ids.length
          ? inArray(question.id, ids)
          : sql`false`
        : ids.length
          ? notInArray(question.id, ids)
          : sql`true`,
    );
  }
  let bindings: BankSnapshotBinding[] = [];
  let scopeDigest = '';
  let documents: BankDocument[] = [];
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
      onPoolFrozen: async (tx, pool) => {
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
        );
        documents = await readBankDocuments(
          tx,
          ctx,
          pool.hits.flatMap((h) => (h.ref ? [h.ref] : [])),
        );
      },
    },
  );
  const conditions = (input.conditions ?? [{ text: query, required: true }]).map((c, i) => ({
    id: `r${i + 1}`,
    ...c,
  }));
  const output = BankSearchOutputSchema.parse({
    contract_version: 3,
    search_id: randomUUID(),
    conditions,
    decision_source: 'caller_assessed',
    hits: recall.hits.map((hit) => ({
      id: hit.question_id,
      ref: hit.ref,
      title: hit.title,
      parts: hit.automatically_servable_part_ids,
      available: hit.automatically_servable_part_ids.length > 0,
      facts: {
        kind: hit.question_kind,
        knowledge_ids: hit.knowledge_ids,
        difficulty: { basis: 'authored', value: hit.difficulty },
      },
      evidence: documents
        .filter(
          (d) =>
            d.ref === hit.ref && (d.source.startsWith('part:') || d.source.startsWith('prior:')),
        )
        .slice(0, 2)
        .map((d) => ({ source: d.source, text: d.text.slice(0, 180) })),
    })),
    coverage: {
      candidates: recall.hits.length,
      complete:
        !recall.coverage.retrieval_truncated && !recall.coverage.unavailable_channels.length,
      unavailable: recall.coverage.unavailable_channels,
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
  if (input.cursor) return resumeBankSearchSnapshot(ctx, input.cursor);
  return saveBankReceipt(ctx, await collectBankSearchReceipt(ctx, input, ablation));
}
export const searchBankTool: DomainTool<SearchBankInput, BankSearchOutputV3> = {
  name: 'search_bank',
  description:
    'Find question-bank candidates and same-revision evidence; no interpretation or verification model runs here. query preserves the learner request. count is the requested qualifying quantity when known; page_size independently controls the small evidence page (default 5). Never infer demand from page size. filters enforce exact KC/kind/difficulty, literal prompt terms and current learner history; like_ref reuses a current version vector. conditions list required/preferred semantics; omitted conditions preserve the query as required. Read answers/rubric and include:solution_prior by returned ref when needed, and judge each required plus same-question joint yourself. Unread/unknown/contradicted never counts as qualified. Results are caller_assessed, not server semantic facts; do not show answers or methods to the learner before their judgment. Continue with only the unchanged cursor. Use search_id and cited assessments in write_quiz/file_bank_gap; those consumers revalidate versions and eligibility. Empty or truncated results never prove bank absence.',
  effect: 'read',
  inputSchema: SearchBankInputSchema,
  outputSchema: BankSearchOutputSchema,
  costClass: 'cheap_llm',
  execute: runBankSearchV3,
  summarize: (_input, output) => `找题 · ${output.hits.length} 道候选`,
  mirrorEvent: 'when_user_visible',
};
