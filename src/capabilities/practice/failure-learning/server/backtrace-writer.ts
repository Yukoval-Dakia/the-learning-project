import { and, asc, eq, inArray } from 'drizzle-orm';
import { EMBED_VERSION } from '@/core/embed-source';
import {
  AttemptDescription,
  BacktraceDecisions,
  InsightPayload,
  JudgementPayload,
} from '@/core/schema/backtrace';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { attempt_insight_vector, backtrace_work, source_document } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockEventCorrectionsAll } from '@/kernel/events/correction-lock';
import { lockAssessmentEvaluationGroup } from '@/kernel/locks/assessment-evaluation-group-lock';
import { readSourceUsageEpochs } from '@/kernel/read-models/usage-policy';
import { EMBED_MODEL, embedMany } from '@/server/ai/embed';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { backtraceDigest, loadBacktraceInput } from './backtrace-input';
import { backtracePool } from './backtrace-pool';
import { activeBacktraceEvents, currentInsight } from './backtrace-store';

async function guarded<T>(
  db: Db,
  id: string,
  fn: (tx: Tx, current: NonNullable<Awaited<ReturnType<typeof loadBacktraceInput>>>) => Promise<T>,
  extraSources: string[] = [],
) {
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const first = await loadBacktraceInput(tx, id);
    if (!first) return null;
    if (first.input.evaluation_group_id)
      await lockAssessmentEvaluationGroup(tx, first.input.evaluation_group_id);
    await lockEventCorrectionsAll(tx);
    const documents = new Set<string>();
    for (const source of [...new Set([...first.input.source_event_ids, ...extraSources])])
      for (const doc of Object.keys(await readSourceUsageEpochs(tx, { kind: 'event', id: source })))
        documents.add(doc);
    if (documents.size)
      await tx
        .select({ id: source_document.id })
        .from(source_document)
        .where(inArray(source_document.id, [...documents]))
        .orderBy(asc(source_document.id))
        .for('share');
    const current = await loadBacktraceInput(tx, id);
    return current ? fn(tx, current) : null;
  });
}

/** Claim commits before sending. A crash or unknown transport result requires reconciliation, never an automatic resend. */
async function paid(
  db: Db,
  id: string,
  stage: 'AttemptInsightTask' | 'BacktraceJudgeTask',
  digest: string,
  input: unknown,
) {
  const workId = `backtrace:${stage}:${id}:${digest}`;
  const claimed = await db
    .insert(backtrace_work)
    .values({ id: workId, attempt_event_id: id, stage, input_digest: digest, state: 'sending' })
    .onConflictDoNothing()
    .returning();
  if (!claimed.length) {
    const [old] = await db.select().from(backtrace_work).where(eq(backtrace_work.id, workId));
    return old?.state === 'completed' ? old.result : null;
  }
  const runTaskFn = makeRunTaskFn(db);
  const result = await runTaskFn(stage, input, {
    taskRunId: workId,
    beforeProviderQuery: async () => {
      const current = await loadBacktraceInput(db, id);
      if (!current || (stage === 'AttemptInsightTask' && current.digest !== digest))
        throw new Error('backtrace source changed or no longer authorized');
      if (stage === 'BacktraceJudgeTask') {
        const anchor = await currentInsight(db, id);
        if (!anchor || (await backtracePool(db, anchor)).digest !== digest)
          throw new Error('backtrace pool changed');
      }
    },
  });
  const stored = {
    output: result.structured_output,
    text: result.text,
    task_run_id: result.task_run_id,
    cost_usd: result.cost_usd ?? null,
    cost_basis: result.cost_basis,
  };
  await db
    .update(backtrace_work)
    .set({ state: 'completed', result: stored })
    .where(eq(backtrace_work.id, workId));
  return stored;
}

export async function writeAttemptInsight(db: Db, id: string, backfillRunId?: string) {
  const before = await loadBacktraceInput(db, id);
  if (!before) return;
  let active = await currentInsight(db, id);
  if (!active) {
    const result = await paid(db, id, 'AttemptInsightTask', before.digest, before.input);
    if (!result) return;
    const description = AttemptDescription.parse(result.output ?? JSON.parse(String(result.text)));
    const corpus = `${before.input.answer_md}\n${before.input.reasoning_trace}`.normalize('NFKC');
    const verified = (quote?: string) => !!quote && corpus.includes(quote.normalize('NFKC'));
    if (description.method)
      for (const step of description.method.steps) step.quote_verified = verified(step.quote);
    if (description.mechanism)
      description.mechanism.quote_verified = verified(description.mechanism.quote);
    if (before.input.outcome === 'success') description.mechanism = null;
    if (before.input.image_status === 'unavailable') {
      description.method = null;
      description.mechanism = null;
      description.no_description_reason = '照片过程尚不可读取';
    }
    if (before.input.user_notes !== null && description.mechanism)
      description.mechanism.what_went_wrong_md = before.input.user_notes;
    await guarded(db, id, async (tx, current) => {
      if (current.digest !== before.digest) return;
      const payload = InsightPayload.parse({
        ...description,
        insight_version: 'attempt-insight-v1',
        question_id: current.input.question_id,
        input_digest: current.digest,
        source_event_ids: current.input.source_event_ids,
        verdict_seen: {
          outcome: current.input.outcome,
          judge_event_id: current.input.judge_event_id,
          evaluation_id: current.input.evaluation_id,
        },
        user_cause_event_id: current.input.user_cause_event_id,
        image_status: current.input.image_status,
        ...(backfillRunId ? { backfill_run_id: backfillRunId } : {}),
      });
      const previous = await activeBacktraceEvents(tx, 'experimental:attempt_insight', id);
      await writeEvent(tx, {
        id: `insight:${id}:${before.digest}`,
        actor_kind: 'agent',
        actor_ref: 'attempt-insight',
        action: 'experimental:attempt_insight',
        subject_kind: 'event',
        subject_id: id,
        caused_by_event_id: id,
        task_run_id: String(result.task_run_id),
        cost_micro_usd:
          typeof result.cost_usd === 'number' ? Math.round(result.cost_usd * 1e6) : null,
        payload,
        ingest_at: new Date(),
        affected_scopes: [],
      });
      for (const old of previous)
        if (old.id !== `insight:${id}:${before.digest}`)
          await writeEvent(tx, {
            id: `insight-supersede:${old.id}:${before.digest}`,
            actor_kind: 'agent',
            actor_ref: 'attempt-insight',
            action: 'correct',
            subject_kind: 'event',
            subject_id: old.id,
            outcome: 'success',
            payload: {
              correction_kind: 'supersede',
              replacement_event_id: `insight:${id}:${before.digest}`,
              reason_md: '作答的有效证据已更正',
              affected_refs: [{ kind: 'question', id: current.input.question_id }],
            },
          });
    });
    active = await currentInsight(db, id);
  }
  if (!active) return;
  const insight = active.insight;
  const facets = [
    {
      facet: 'mechanism',
      text: insight.mechanism
        ? `${insight.mechanism.what_went_wrong_md}\n${insight.mechanism.trigger_md}`
        : null,
    },
    {
      facet: 'method',
      text: insight.method ? `${insight.method.core_idea_md}\n${insight.method.key_step_md}` : null,
    },
    {
      facet: 'needed_method',
      text: insight.needed_method
        ? `${insight.needed_method.core_idea_md}\n${insight.needed_method.key_step_md}`
        : null,
    },
  ].filter((x): x is { facet: string; text: string } => x.text !== null);
  const indexed = await db
    .select()
    .from(attempt_insight_vector)
    .where(
      and(
        eq(attempt_insight_vector.insight_event_id, active.row.id),
        eq(attempt_insight_vector.embed_version, EMBED_VERSION),
      ),
    );
  const missing = facets.filter(
    (x) => !indexed.some((y) => y.facet === x.facet && y.content_hash === backtraceDigest(x.text)),
  );
  if (missing.length) {
    const indexId = `backtrace-index:${active.row.id}:${EMBED_VERSION}:${backtraceDigest(missing)}`;
    const claim = await db
      .insert(backtrace_work)
      .values({
        id: indexId,
        attempt_event_id: id,
        stage: 'embedding',
        input_digest: before.digest,
        state: 'sending',
      })
      .onConflictDoNothing()
      .returning();
    let vectors: number[][];
    if (claim.length) {
      const vectors = await embedMany(
        missing.map((x) => x.text),
        {
          db,
          caller: 'worker',
          deadlineAt: new Date(Date.now() + 600_000),
          operationAnchor: `insight-index:${active.row.id}:${EMBED_VERSION}`,
          beforeSend: async () => {
            if (!(await currentInsight(db, id))) throw new Error('insight no longer authorized');
          },
        },
      );
      await db
        .update(backtrace_work)
        .set({ state: 'completed', result: { vectors } })
        .where(eq(backtrace_work.id, indexId));
      // Read the committed receipt below, so both fresh execution and recovery use the same bytes.
    }
    const [receipt] = await db.select().from(backtrace_work).where(eq(backtrace_work.id, indexId));
    if (receipt?.state !== 'completed' || !Array.isArray(receipt.result?.vectors)) return;
    vectors = receipt.result.vectors as number[][];
    await guarded(db, id, async (tx, current) => {
      if (current.digest !== before.digest) return;
      for (const [i, x] of missing.entries()) {
        const row = {
          insight_event_id: active.row.id,
          attempt_event_id: id,
          question_id: insight.question_id,
          created_at: new Date(current.input.created_at),
          facet: x.facet,
          embedding: vectors[i],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          content_hash: backtraceDigest(x.text),
        };
        await tx
          .insert(attempt_insight_vector)
          .values(row)
          .onConflictDoUpdate({
            target: [attempt_insight_vector.insight_event_id, attempt_insight_vector.facet],
            set: row,
          });
      }
    });
  }
}

export async function writeBacktraceJudgement(db: Db, id: string) {
  const anchor = await currentInsight(db, id);
  if (!anchor) return;
  const pool = await backtracePool(db, anchor);
  const input = {
    anchor: { attempt_event_id: id, insight: anchor.insight },
    candidates: pool.pool,
  };
  const result = pool.pool.length
    ? await paid(db, id, 'BacktraceJudgeTask', pool.digest, input)
    : { output: { matches: [] }, task_run_id: null, cost_usd: null };
  if (!result) return;
  const decisions = BacktraceDecisions.parse(result.output ?? JSON.parse(String(result.text)));
  for (const match of decisions.matches)
    if (match.shared_step) {
      const prior = pool.pool.find((x) => x.attempt_event_id === match.attempt_event_id);
      if (
        !anchor.insight.method?.steps.some((x) => x.k === match.shared_step?.now_k) ||
        !prior?.insight.method?.steps.some((x) => x.k === match.shared_step?.then_k)
      )
        match.shared_step = null;
    }
  if (
    decisions.matches.length !== pool.pool.length ||
    new Set(decisions.matches.map((x) => x.attempt_event_id)).size !== pool.pool.length ||
    decisions.matches.some((x) => !pool.pool.some((y) => y.attempt_event_id === x.attempt_event_id))
  )
    throw new Error('backtrace candidate coverage mismatch');
  await guarded(
    db,
    id,
    async (tx) => {
      const current = await currentInsight(tx, id);
      if (!current || current.row.id !== anchor.row.id) return;
      const recheck = await backtracePool(tx, current);
      if (recheck.digest !== pool.digest) return;
      const payload = JudgementPayload.parse({
        ...decisions,
        judgement_version: 'backtrace-judge-v1',
        pool_digest: pool.digest,
        anchor_insight_id: anchor.row.id,
        source_event_ids: [anchor.row.id, ...pool.pool.map((x) => x.insight_event_id)],
      });
      await writeEvent(tx, {
        id: `backtrace:${id}:${pool.digest}`,
        actor_kind: 'agent',
        actor_ref: 'backtrace-judge',
        action: 'experimental:backtrace_judgement',
        subject_kind: 'event',
        subject_id: id,
        caused_by_event_id: anchor.row.id,
        task_run_id: typeof result.task_run_id === 'string' ? result.task_run_id : null,
        payload,
        ingest_at: new Date(),
        cost_micro_usd:
          typeof result.cost_usd === 'number' ? Math.round(result.cost_usd * 1e6) : null,
        affected_scopes: [],
      });
    },
    pool.pool.flatMap((x) => x.insight.source_event_ids),
  );
}
