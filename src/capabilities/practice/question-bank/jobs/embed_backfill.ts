// Idempotent embed backfill: fills question and knowledge rows whose embedding is
// NULL or stamped behind EMBED_VERSION. A rerun with no matching rows is a no-op;
// bumping EMBED_VERSION re-embeds older rows in the background.
//
// Question vectors share paid receipts with publication delivery; unknown sends
// wait for reconciliation rather than paying again on the next nightly run.

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  EMBED_VERSION,
  embedHash,
  knowledgeEmbedText,
  questionEmbedText,
} from '@/core/embed-source';
import { lockPaidEffectControlFamily } from '@/core/paid-work/server/paid-effect-control';
import {
  markPaidEffectUnknown,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
} from '@/core/paid-work/server/paid-effect-store';
import type { Db } from '@/db/client';
import { isEmbedRevisionCurrent } from '@/db/embed-currency';
import { knowledge, question, question_group_lifecycle } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { sourceAllowsDerivationSql } from '@/kernel/read-models/usage-policy';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  type EmbedProviderAttemptOptions,
  embedMany,
} from '@/server/ai/embed';
import { embedSolutionPriorVectors } from '../server/admission/solution-prior-vectors';

/** Stamp a vector computed during ingest; valid only when its text is the text about
 *  to be persisted. Otherwise leave it NULL for the backfill to recompute. */
export function questionEmbedStamp(
  q: {
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
    version: number;
  },
  vector: number[],
): {
  embedding: number[];
  embed_model: string;
  embed_version: number;
  embed_content_hash: string;
  embed_source_revision: number;
} | null {
  if (vector.length !== EMBED_DIMS) return null;
  return {
    embedding: vector,
    embed_model: EMBED_MODEL,
    embed_version: EMBED_VERSION,
    embed_content_hash: embedHash(questionEmbedText(q)),
    embed_source_revision: q.version,
  };
}

export async function embedQuestionTextForIngest(
  q: {
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
  },
  providerAttempt: EmbedProviderAttemptOptions,
  embedFn: typeof embedMany = embedMany,
): Promise<number[]> {
  const [vector] = await embedFn([questionEmbedText(q)], providerAttempt);
  if (!vector || vector.length !== EMBED_DIMS || vector.some((v) => !Number.isFinite(v))) {
    throw new Error('ingest embed returned no usable vector');
  }
  return vector;
}

export type QuestionVectorInvalidReason =
  | 'no_vector'
  | 'dimension_mismatch'
  | 'stale_version'
  | 'revision_mismatch'
  | 'hash_mismatch';

/** A stored vector is usable only when present, EMBED_DIMS wide, stamped EMBED_VERSION,
 *  stamped from the row's CURRENT revision (embed_source_revision), and hashed from the
 *  row's CURRENT content (an edit not yet re-embedded leaves a stale vector). Returns
 *  the first failing check, or null. Shared with the search_bank similar_to anchor and
 *  the embed census so they cannot drift from this job. */
export function questionVectorInvalidReason(row: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  version: number;
  embed_version: number | null;
  embed_content_hash: string | null;
  embed_source_revision: number | null;
  /** Stored vector width; null when the row has no vector. */
  dimension: number | null;
}): QuestionVectorInvalidReason | null {
  if (row.dimension === null) return 'no_vector';
  if (row.dimension !== EMBED_DIMS) return 'dimension_mismatch';
  if (row.embed_version !== EMBED_VERSION) return 'stale_version';
  if (!isEmbedRevisionCurrent(row)) return 'revision_mismatch';
  if (row.embed_content_hash !== embedHash(questionEmbedText(row))) return 'hash_mismatch';
  return null;
}

/** One currency-aware question operation for publication and nightly reconciliation. */
export async function runQuestionEmbedding(
  db: Db,
  questionId: string,
  providerAttempt: EmbedProviderAttemptOptions,
  embedFn: typeof embedMany = embedMany,
  publishedRevision?: string,
): Promise<'embedded' | 'skipped' | 'held'> {
  const derivationAllowed = sourceAllowsDerivationSql({ kind: 'question', id: question.id });
  const publicationCurrent =
    publishedRevision === undefined
      ? sql`true`
      : sql`exists (
    select 1 from ${question_group_lifecycle}
    where ${question_group_lifecycle.group_id} = ${question.id}
      and ${question_group_lifecycle.current_revision_id} = ${publishedRevision}
      and ${question_group_lifecycle.scoring_admission_state} = 'admitted'
      and not ${question_group_lifecycle.withdrawn}
      and not ${question_group_lifecycle.suspended}
  )`;
  const [row] = await db
    .select()
    .from(question)
    .where(and(eq(question.id, questionId), derivationAllowed, publicationCurrent))
    .limit(1);
  if (
    !row ||
    questionVectorInvalidReason({ ...row, dimension: row.embedding?.length ?? null }) === null
  ) {
    return 'skipped';
  }
  const text = questionEmbedText(row);
  const sourceCurrent = and(
    eq(question.id, row.id),
    eq(question.version, row.version),
    sql`${question.prompt_md} IS NOT DISTINCT FROM ${row.prompt_md}`,
    sql`${question.reference_md} IS NOT DISTINCT FROM ${row.reference_md}`,
    sql`${question.choices_md} IS NOT DISTINCT FROM ${row.choices_md === null ? null : JSON.stringify(row.choices_md)}::jsonb`,
    derivationAllowed,
    publicationCurrent,
  );
  // Delivery ids never enter paid identity: publication retries and the next
  // night's sweep reuse the same receipt, even after queue retention expires.
  const deliveryId = providerAttempt.operationAnchor ?? `question-embed:${row.id}:${row.version}`;
  const effect = await reservePaidEffect(
    db,
    {
      family: 'embed_backfill',
      entityId: row.id,
      entityRevision: String(row.version),
      unit: 'question_embedding',
      input: { text, model: EMBED_MODEL, embed_version: EMBED_VERSION, dimensions: EMBED_DIMS },
    },
    {
      backend: 'pg-boss',
      deliveryId,
      leaseExpiresAt: providerAttempt.deadlineAt,
    },
  );
  if (effect.kind === 'held') return 'held';
  if (effect.kind === 'winner') {
    try {
      const vector = await embedQuestionTextForIngest(
        row,
        {
          ...providerAttempt,
          beforeSend: async () => {
            await providerAttempt.beforeSend?.();
            const [current] = await db
              .select({ id: question.id })
              .from(question)
              .where(sourceCurrent)
              .limit(1);
            if (!current) throw new Error('question embedding source no longer authorized/current');
          },
        },
        embedFn,
      );
      await db.transaction((tx) =>
        recordPaidEffectResult(
          tx,
          effect.identity,
          deliveryId,
          { vector },
          { fence: effect.fence },
        ),
      );
    } catch (error) {
      // Includes an uncertain receipt commit. The store refuses to erase a known
      // result; a committed receipt can still be replayed after this job fails.
      await db.transaction(async (tx) => {
        await lockPaidEffectControlFamily(tx, effect.identity.family);
        if ((await readPaidEffect(tx, effect.identity))?.state === 'sending') {
          await markPaidEffectUnknown(
            tx,
            effect.identity,
            deliveryId,
            'question_embedding_unresolved',
            { fence: effect.fence },
          );
        }
      });
      throw error;
    }
  }
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, effect.identity.family);
    const receipt = await readPaidEffect(tx, effect.identity);
    const vector = (receipt?.result as { vector?: number[] } | null)?.vector;
    if (!vector || vector.length !== EMBED_DIMS || vector.some((v) => !Number.isFinite(v))) {
      throw new Error('question embedding receipt has no usable vector');
    }
    const stamp = questionEmbedStamp(row, vector);
    if (!stamp) throw new Error('question embedding receipt has invalid dimensions');
    // Publication locks question then lifecycle. Keep the same order, and hold
    // both through vector application so a lifecycle-only withdrawal cannot race.
    await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, row.id))
      .for('update');
    await tx
      .select({ id: question_group_lifecycle.group_id })
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, row.id))
      .for('share');
    const [current] = await tx.select().from(question).where(sourceCurrent).limit(1);
    let embedded = false;
    if (
      current &&
      questionVectorInvalidReason({ ...current, dimension: current.embedding?.length ?? null }) !==
        null
    ) {
      const written = await tx
        .update(question)
        .set(stamp)
        .where(
          and(
            sourceCurrent,
            sql`${question.embed_content_hash} IS NOT DISTINCT FROM ${current.embed_content_hash}`,
          ),
        )
        .returning({ id: question.id });
      embedded = written.length > 0;
    }
    if (receipt?.state === 'receipt_ready') {
      await recordPaidEffectApplication(tx, effect.identity, {
        question_id: row.id,
        version: row.version,
        outcome: embedded ? 'embedded' : 'skipped',
      });
    }
    return embedded ? 'embedded' : 'skipped';
  });
}

// Each getEffectiveDomain call walks up to 32 ancestors with serial SELECTs, so resolving
// the batch sequentially multiplies that. Chunked parallelism cuts latency without
// opening one connection per row (kept below the default pool size).
const EFFECTIVE_DOMAIN_CONCURRENCY = 8;

// Order-preserving resolution used by both the embed pass and the currency sweep.
// A thrown resolution is transient (broken tree): the row is skipped with a warning so
// no caller stamps a degraded name-only vector, and the select predicate re-picks it
// next run. getEffectiveDomain either returns a domain or throws.
async function resolveKnowledgeEffectiveDomains<T extends { id: string }>(
  db: Db,
  rows: T[],
): Promise<Array<{ row: T; effectiveDomain: string }>> {
  const out: Array<{ row: T; effectiveDomain: string }> = [];
  for (let start = 0; start < rows.length; start += EFFECTIVE_DOMAIN_CONCURRENCY) {
    const chunk = rows.slice(start, start + EFFECTIVE_DOMAIN_CONCURRENCY);
    const outcomes = await Promise.allSettled(chunk.map((row) => getEffectiveDomain(db, row.id)));
    for (let j = 0; j < chunk.length; j++) {
      const outcome = outcomes[j];
      if (outcome.status === 'rejected') {
        console.warn(
          '[embed_backfill] skipping KC %s — effective-domain unresolved, will retry next run:',
          chunk[j].id,
          outcome.reason,
        );
        continue;
      }
      out.push({ row: chunk[j], effectiveDomain: outcome.value });
    }
  }
  return out;
}

// YUK-1603 — provider-free currency sweep over surviving vectors whose provenance fell
// behind the row revision (embed_source_revision NULL legacy rows, metadata-only edits,
// same-domain reparents). A vector whose recomputed content hash still matches is just
// re-stamped with the current revision — no embed call. A hash drift means content moved
// under a surviving vector (a missed invalidation): register the re-embed obligation the
// way editQuestion/applyReparent do — NULL the vector, stamp the new hash — so the stale
// passes in the same run re-embed the current text. Both writes CAS on the revision read
// plus the suspect predicate, so a concurrent embed write is never clobbered.
async function sweepQuestionEmbedCurrency(
  db: Db,
  limit: number,
): Promise<{ restamped: number; invalidated: number }> {
  const suspect = and(
    isNotNull(question.embedding),
    eq(question.embed_version, EMBED_VERSION),
    sql`${question.embed_source_revision} IS DISTINCT FROM ${question.version}`,
  );
  const rows = await db.select().from(question).where(suspect).limit(limit);
  let restamped = 0;
  let invalidated = 0;
  for (const row of rows) {
    const currentHash = embedHash(questionEmbedText(row));
    if (currentHash === row.embed_content_hash) {
      const written = await db
        .update(question)
        .set({ embed_source_revision: row.version })
        .where(
          and(
            eq(question.id, row.id),
            eq(question.version, row.version),
            sql`${question.embed_content_hash} IS NOT DISTINCT FROM ${row.embed_content_hash}`,
            suspect,
          ),
        )
        .returning({ id: question.id });
      restamped += written.length;
    } else {
      const written = await db
        .update(question)
        .set({ embedding: null, embed_content_hash: currentHash, embed_source_revision: null })
        .where(and(eq(question.id, row.id), eq(question.version, row.version), suspect))
        .returning({ id: question.id });
      invalidated += written.length;
    }
  }
  return { restamped, invalidated };
}

async function sweepKnowledgeEmbedCurrency(
  db: Db,
  limit: number,
): Promise<{ restamped: number; invalidated: number }> {
  const suspect = and(
    isNotNull(knowledge.embedding),
    eq(knowledge.embed_version, EMBED_VERSION),
    sql`${knowledge.embed_source_revision} IS DISTINCT FROM ${knowledge.version}`,
  );
  const rows = await db.select().from(knowledge).where(suspect).limit(limit);
  const resolved = await resolveKnowledgeEffectiveDomains(db, rows);
  let restamped = 0;
  let invalidated = 0;
  for (const { row, effectiveDomain } of resolved) {
    const currentHash = embedHash(knowledgeEmbedText({ name: row.name, effectiveDomain }));
    if (currentHash === row.embed_content_hash) {
      const written = await db
        .update(knowledge)
        .set({ embed_source_revision: row.version })
        .where(
          and(
            eq(knowledge.id, row.id),
            eq(knowledge.version, row.version),
            sql`${knowledge.name} IS NOT DISTINCT FROM ${row.name}`,
            sql`${knowledge.embed_content_hash} IS NOT DISTINCT FROM ${row.embed_content_hash}`,
            suspect,
          ),
        )
        .returning({ id: knowledge.id });
      restamped += written.length;
    } else {
      const written = await db
        .update(knowledge)
        .set({ embedding: null, embed_content_hash: currentHash, embed_source_revision: null })
        .where(
          and(
            eq(knowledge.id, row.id),
            eq(knowledge.version, row.version),
            sql`${knowledge.name} IS NOT DISTINCT FROM ${row.name}`,
            suspect,
          ),
        )
        .returning({ id: knowledge.id });
      invalidated += written.length;
    }
  }
  return { restamped, invalidated };
}

/** Embed up to `limit` stale question and knowledge rows, stamping model, version, and
 *  content hash. Returns the number embedded; rerunning is safe. */
export async function runEmbedBackfill(
  db: Db,
  limit = 100,
  providerAttempt: EmbedProviderAttemptOptions = {
    db,
    caller: 'worker',
    deadlineAt: new Date(Date.now() + 20_000),
  },
  /** Test seam: production callers leave this unset so sends go through the real
   *  DashScope client. */
  embedFn: typeof embedMany = embedMany,
): Promise<number> {
  let total = 0;

  // YUK-1603 — currency sweep first, so provenance repairs are free of provider calls
  // and sweep-invalidated rows are re-embedded by the stale passes in this same run.
  const qSweep = await sweepQuestionEmbedCurrency(db, limit);
  const kSweep = await sweepKnowledgeEmbedCurrency(db, limit);
  if (qSweep.restamped + qSweep.invalidated + kSweep.restamped + kSweep.invalidated > 0) {
    console.log('[embed_backfill] currency sweep', { question: qSweep, knowledge: kSweep });
  }

  // Re-embed when the vector is missing (never embedded / edit-NULLed) or stamped
  // behind EMBED_VERSION. `lt` is not NULL-tolerant, so legacy rows need the
  // explicit isNull(embed_version) branch.
  const qStale = or(
    isNull(question.embedding),
    isNull(question.embed_version),
    lt(question.embed_version, EMBED_VERSION),
  );
  // Source-document consent: restricted lineage is excluded at the scan predicate —
  // before the batch limit — so those rows can neither consume the budget nor reach
  // embedMany. The same predicate rides the write CAS, so a restriction flipped
  // mid-send also blocks the landing vector.
  const qDerivationAllowed = sourceAllowsDerivationSql({
    kind: 'question',
    id: question.id,
  });
  const qs = await db.select().from(question).where(and(qStale, qDerivationAllowed)).limit(limit);
  for (const row of qs) {
    const outcome = await runQuestionEmbedding(db, row.id, providerAttempt, embedFn);
    if (outcome === 'embedded') total += 1;
  }

  const kStale = or(
    isNull(knowledge.embedding),
    isNull(knowledge.embed_version),
    lt(knowledge.embed_version, EMBED_VERSION),
  );
  const ks = await db.select().from(knowledge).where(kStale).limit(limit);
  if (ks.length > 0) {
    // Fold each KC's effective domain into its embed text so same-named cross-subject
    // KCs get distinct vectors and hashes. Resolution keeps every row paired with its
    // own domain.
    const resolved = await resolveKnowledgeEffectiveDomains(db, ks);
    const pairs = resolved.map(({ row, effectiveDomain }) => ({
      k: row,
      text: knowledgeEmbedText({ name: row.name, effectiveDomain }),
    }));

    if (pairs.length > 0) {
      const vecs = await embedFn(
        pairs.map((r) => r.text),
        providerAttempt,
      );
      for (let i = 0; i < pairs.length; i++) {
        const { k, text } = pairs[i];
        await db
          .update(knowledge)
          .set({
            embedding: vecs[i],
            embed_model: EMBED_MODEL,
            embed_version: EMBED_VERSION,
            embed_content_hash: embedHash(text),
            embed_source_revision: k.version,
          })
          // Same concurrency guard as the question update above, plus selection-time
          // name/hash parity: a reparent that NULLed the embedding and stamped a new
          // hash (or a rename) must not let this late write land the old effective
          // domain's vector as current.
          .where(
            and(
              eq(knowledge.id, k.id),
              kStale,
              eq(knowledge.version, k.version),
              sql`${knowledge.name} IS NOT DISTINCT FROM ${k.name}`,
              sql`${knowledge.embed_content_hash} IS NOT DISTINCT FROM ${k.embed_content_hash}`,
            ),
          );
      }
    }
    // Only rows with a correctly resolved domain are embedded and counted; skipped
    // rows stay re-pickable.
    total += pairs.length;
  }

  total += await embedSolutionPriorVectors(db, limit, providerAttempt, embedFn);

  return total;
}

// A throw propagates to pg-boss for retry; rows stay NULL until the next run.
export function buildEmbedBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async (jobs) => {
    try {
      const embedded = await runEmbedBackfill(db, 100, {
        db,
        caller: 'worker',
        deadlineAt: new Date(Date.now() + 20_000),
        operationAnchor: jobs[0]?.id,
      });
      console.log('[embed_backfill] embedded', embedded);
    } catch (err) {
      console.error('[embed_backfill] failed', err);
      throw err;
    }
  };
}
