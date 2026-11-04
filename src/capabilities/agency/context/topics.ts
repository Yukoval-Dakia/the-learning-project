// Current topics reuse the brief row; immutable before/after versions live in
// the event ledger so C1 can migrate both without losing reversibility.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { allowedEventIds, lockEventDerivationSources } from '@/kernel/events/derivation-policy';
import { lockPurposeBrief } from '@/kernel/locks/memory-locks';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { briefPurposeCurrent, latestPurposeWithdrawal } from '@/kernel/read-models/purpose-change';
import { markBriefPurpose } from '../server/memory/brief-purpose';
import { type LegacyFact, readLegacyFacts, restoreLegacy, supersedeLegacy } from './legacy-facts';

import {
  CONTEXT_CHANGE,
  ChangeResult,
  DIGEST_SCOPE,
  Digest,
  type DigestT,
  type FactT,
  TALK_TOPIC,
  type TopicPatchT,
} from './topic-contract';

const empty = (): DigestT => ({ format: 1, topics: [], as_of: null, overnight: null });

export async function readTopics(db: Db | Tx) {
  const [row] = await db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, DIGEST_SCOPE))
    .limit(1);
  if (!row) return { digest: empty(), version: 0 };
  if (!(await briefPurposeCurrent(db, DIGEST_SCOPE, row.version)))
    return { digest: empty(), version: row.version };
  return { digest: Digest.parse(JSON.parse(row.long_term_md)), version: row.version };
}

function portrait(digest: DigestT) {
  return digest.topics
    .filter((t) => t.key !== TALK_TOPIC)
    .map((t) => `${t.name}：${t.facts.map((f) => f.body).join('；')}`)
    .join('\n');
}

async function persist(
  tx: Tx,
  before: DigestT,
  after: DigestT,
  version: number,
  input: {
    actor: FactT['written_by'];
    taskRunId: string;
    sourceIds: string[];
    undoOf?: string;
    legacy?: LegacyFact[];
  },
) {
  const now = new Date();
  const changeId = newId();
  const allIds = [...new Set(after.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)))];
  for (const id of [...new Set([...allIds, ...input.sourceIds])].sort())
    await lockEventDerivationSources(tx, id);
  const allowed = await allowedEventIds(tx, [...new Set([...allIds, ...input.sourceIds])]);
  if ([...allIds, ...input.sourceIds].some((id) => !allowed.has(id)))
    throw new Error('restricted or missing context evidence');
  const withdrawal = await latestPurposeWithdrawal(tx);
  await writeEvent(tx, {
    id: changeId,
    action: CONTEXT_CHANGE,
    actor_kind: input.actor === 'learner' ? 'user' : 'agent',
    actor_ref: input.actor,
    subject_kind: 'query',
    subject_id: DIGEST_SCOPE,
    payload: {
      format: 1,
      before,
      after,
      version: version + 1,
      task_run_id: input.taskRunId,
      legacy_before: input.legacy ?? [],
      undo_of: input.undoOf ?? null,
      evidence_ids: allIds,
    },
    affected_scopes: [],
    ingest_at: now,
  });
  for (const fact of input.legacy ?? []) await supersedeLegacy(tx, fact, changeId);
  const md = portrait(after);
  await tx
    .insert(memory_brief_note)
    .values({
      id: `memory_brief:${DIGEST_SCOPE}`,
      scope_key: DIGEST_SCOPE,
      recent_week_md: md,
      recent_months_md: '',
      long_term_md: JSON.stringify(after),
      recent_week_evidence_ids: allIds,
      recent_months_evidence_ids: [],
      long_term_evidence_ids: allIds,
      evidence_count: allIds.length,
      source_event_id: input.sourceIds[0] ?? null,
      latest_evidence_at: now,
      refreshed_at: now,
      created_at: now,
      updated_at: now,
      version: version + 1,
    })
    .onConflictDoUpdate({
      target: memory_brief_note.scope_key,
      set: {
        recent_week_md: md,
        long_term_md: JSON.stringify(after),
        recent_week_evidence_ids: allIds,
        long_term_evidence_ids: allIds,
        evidence_count: allIds.length,
        source_event_id: input.sourceIds[0] ?? null,
        latest_evidence_at: now,
        refreshed_at: now,
        updated_at: now,
        version: version + 1,
      },
    });
  await markBriefPurpose(tx, DIGEST_SCOPE, version + 1, withdrawal);
  return ChangeResult.parse({
    status: 'changed',
    change_id: changeId,
    version: version + 1,
    before: before.topics,
    after: after.topics,
    issues: [],
  });
}

export async function changeTopics(
  db: Db,
  input: {
    expectedVersion: number;
    actor: FactT['written_by'];
    taskRunId: string;
    sourceIds: string[];
    patches?: TopicPatchT[];
    withdrawKey?: string;
    undoId?: string;
    asOf?: string;
    overnight?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const preview = await readTopics(tx);
    if (preview.version !== input.expectedVersion)
      throw new Error('context version conflict; reload');
    const legacyIds =
      input.patches?.flatMap((p) => p.replaces.filter((id) => id.startsWith('mem0:'))) ?? [];
    const legacy = legacyIds.length
      ? (await readLegacyFacts(tx)).filter((f) => legacyIds.includes(f.id))
      : [];
    const undo = input.undoId
      ? await tx
          .select({ payload: event.payload })
          .from(event)
          .where(and(eq(event.id, input.undoId), eq(event.action, CONTEXT_CHANGE)))
      : [];
    const prior = undo[0]
      ? z.object({ before: Digest, after: Digest }).parse(undo[0].payload)
      : null;
    const refs = [
      ...new Set([
        ...input.sourceIds,
        ...preview.digest.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)),
        ...legacy.flatMap((f) => f.evidence_ids),
        ...[...(prior?.before.topics ?? []), ...(prior?.after.topics ?? [])].flatMap((t) =>
          t.facts.flatMap((f) => f.evidence_ids),
        ),
      ]),
    ];
    // Purpose mutation locks source documents before the global brief lock.
    // Match that order, then CAS the projection before applying any change.
    for (const id of refs.sort()) await lockEventDerivationSources(tx, id);
    await lockPurposeBrief(tx);
    const { digest: before, version } = await readTopics(tx);
    if (version !== input.expectedVersion) throw new Error('context version conflict; reload');
    const after = structuredClone(before);
    const legacyChanged: LegacyFact[] = [];
    const result = (issues: z.infer<typeof ChangeResult>['issues']) =>
      ChangeResult.parse({
        status: issues.length ? 'issue' : 'unchanged',
        change_id: null,
        version,
        before: before.topics,
        after: before.topics,
        issues,
      });
    if (input.undoId) {
      const [row] = await tx
        .select()
        .from(event)
        .where(and(eq(event.id, input.undoId), eq(event.action, CONTEXT_CHANGE)));
      const payload = z
        .object({
          before: Digest,
          after: Digest,
          version: z.number(),
          legacy_before: z
            .array(
              z.object({
                id: z.string(),
                body: z.string(),
                memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
                evidence_ids: z.array(z.string()),
                payload: z.record(z.string(), z.unknown()),
              }),
            )
            .default([]),
        })
        .parse(row?.payload);
      for (const fact of payload.legacy_before) {
        for (const id of fact.evidence_ids) await lockEventDerivationSources(tx, id);
        const allowed = await allowedEventIds(tx, fact.evidence_ids);
        if (fact.evidence_ids.some((id) => !allowed.has(id)))
          throw new Error('restricted legacy undo evidence');
      }
      await restoreLegacy(tx, payload.legacy_before, input.undoId);
      const keys = new Set([...payload.before.topics, ...payload.after.topics].map((t) => t.key));
      for (const key of keys) {
        const old = payload.before.topics.find((t) => t.key === key);
        const changed = payload.after.topics.find((t) => t.key === key);
        if (JSON.stringify(old) === JSON.stringify(changed)) continue;
        if (JSON.stringify(after.topics.find((t) => t.key === key)) !== JSON.stringify(changed))
          throw new Error('topic has later changes; correct it instead');
        after.topics = after.topics.filter((t) => t.key !== key);
        if (old)
          after.topics.push({
            ...old,
            updated_at: new Date().toISOString(),
            facts: old.facts.map((f) => ({
              ...f,
              id: newId(),
              supersedes: [f.id],
              written_by: 'learner',
              kind: 'correction',
            })),
          });
      }
    } else if (input.withdrawKey) {
      after.topics = after.topics.filter((t) => t.key !== input.withdrawKey);
    } else {
      for (const patch of input.patches ?? []) {
        const legacyIds = patch.replaces.filter((id) => id.startsWith('mem0:'));
        const legacy = legacyIds.length
          ? (await readLegacyFacts(tx)).filter((f) => legacyIds.includes(f.id))
          : [];
        legacyChanged.push(...legacy);
        const replaced = after.topics
          .flatMap((t) => t.facts)
          .filter((f) => patch.replaces.includes(f.id))
          .concat(
            legacy.map((f) => ({
              ...f,
              kind: 'fact' as const,
              written_by: 'curator' as const,
              as_of: '',
              supersedes: [],
              knowledge_ids: [],
            })),
          );
        if (replaced.length !== new Set(patch.replaces).size)
          throw new Error('unknown replacement fact');
        if (
          replaced.length > 1 &&
          (patch.memory_kind === 'weakness' ||
            patch.memory_kind === 'event' ||
            replaced.some((f) => f.memory_kind === 'weakness' || f.memory_kind === 'event'))
        )
          return result([
            {
              kind: 'unmergeable',
              detail: 'weakness/event facts must remain separate; supersede individually',
            },
          ]);
        if (input.actor === 'curator' && replaced.some((f) => f.kind === 'correction'))
          return result([
            {
              kind: 'correction_protected',
              detail: 'Learner correction wins; add new evidence without replacing it',
            },
          ]);
        let topic = after.topics.find((t) => t.key === patch.key);
        if (topic?.facts.some((f) => f.body === patch.body) && !replaced.length) {
          const name = patch.key === TALK_TOPIC ? '怎么和我说话' : patch.name;
          if (
            topic.name !== name ||
            topic.description !== patch.description ||
            topic.scope_key !== patch.scope_key
          ) {
            topic.name = name;
            topic.description = patch.description;
            topic.scope_key = patch.scope_key;
            topic.updated_at = new Date().toISOString();
          }
          continue;
        }
        const evidence = [
          ...new Set([...input.sourceIds, ...replaced.flatMap((f) => f.evidence_ids)]),
        ];
        if (!evidence.length) throw new Error('context write requires server-bound evidence');
        for (const t of after.topics)
          t.facts = t.facts.filter((f) => !patch.replaces.includes(f.id));
        if (!topic) {
          topic = {
            key: patch.key,
            scope_key: patch.scope_key,
            name: patch.name,
            description: patch.description,
            facts: [],
            updated_at: '',
          };
          after.topics.push(topic);
        }
        topic.name = patch.key === TALK_TOPIC ? '怎么和我说话' : patch.name;
        topic.description = patch.description;
        topic.updated_at = new Date().toISOString();
        topic.facts.push({
          id: newId(),
          body: patch.body,
          kind: input.actor === 'learner' ? 'correction' : 'fact',
          memory_kind: patch.memory_kind,
          written_by: input.actor,
          evidence_ids: evidence,
          as_of: new Date().toISOString(),
          supersedes: patch.replaces,
          knowledge_ids: patch.knowledge_ids,
        });
      }
      after.topics = after.topics.filter((t) => t.facts.length);
      if (input.asOf && (!after.as_of || input.asOf > after.as_of)) after.as_of = input.asOf;
      if (input.overnight !== undefined) after.overnight = input.overnight;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return result([]);
    return persist(tx, before, after, version, {
      ...input,
      undoOf: input.undoId,
      legacy: legacyChanged,
    });
  });
}

export async function topicBoard(db: Db, now = new Date()) {
  const { digest, version } = await readTopics(db);
  const changes = await db
    .select({ id: event.id, at: event.created_at, payload: event.payload })
    .from(event)
    .where(eq(event.action, CONTEXT_CHANGE))
    .orderBy(desc(event.created_at))
    .limit(30);
  const visibleChanges = [];
  for (const change of changes) {
    const snapshot = z.object({ before: Digest, after: Digest }).parse(change.payload);
    const refs = [
      ...new Set(
        [...snapshot.before.topics, ...snapshot.after.topics].flatMap((t) =>
          t.facts.flatMap((f) => f.evidence_ids),
        ),
      ),
    ];
    const allowed = await allowedEventIds(db, refs);
    if (refs.every((id) => allowed.has(id))) visibleChanges.push(change);
  }
  const ids = [...new Set(digest.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)))];
  const evidence = ids.length
    ? await db
        .select({ id: event.id, at: event.created_at })
        .from(event)
        .where(inArray(event.id, ids))
    : [];
  const times = new Map(evidence.map((e) => [e.id, e.at.getTime()]));
  const knowledgeIds = [
    ...new Set(digest.topics.flatMap((t) => t.facts.flatMap((f) => f.knowledge_ids))),
  ];
  const judgments = knowledgeIds.length
    ? await readLearnerJudgments(db, { knowledge_ids: knowledgeIds, context: 'any', as_of: now })
    : null;
  const retention = new Map(
    judgments?.items.map((item) => {
      const r = item.retention;
      const value =
        r.kind === 'available'
          ? typeof r.reading === 'number'
            ? r.reading
            : r.reading.kind === 'score'
              ? r.reading.value
              : null
          : null;
      return [item.knowledge_id, value] as const;
    }),
  );
  return {
    version,
    topics: digest.topics.map((t) => {
      const dates = t.facts
        .flatMap((f) => f.evidence_ids.map((id) => times.get(id)))
        .filter((x): x is number => x !== undefined);
      const evidenceAt = dates.length ? Math.max(...dates) : null;
      const freshness =
        evidenceAt === null
          ? null
          : Math.exp(-Math.max(0, now.getTime() - evidenceAt) / (30 * 86400000));
      const ks = [...new Set(t.facts.flatMap((f) => f.knowledge_ids))];
      const weights = ks.map((k) => retention.get(k) ?? null);
      const memoryWeight = !ks.length
        ? 1
        : weights.some((w) => w === null)
          ? null
          : Math.min(...weights.filter((w): w is number => w !== null));
      const weightedFreshness =
        freshness === null || memoryWeight === null ? null : freshness * memoryWeight;
      return {
        ...t,
        memory_weight: memoryWeight,
        evidence_at: evidenceAt === null ? null : new Date(evidenceAt).toISOString(),
        freshness: weightedFreshness,
        stale: weightedFreshness === null || weightedFreshness < 0.5,
      };
    }),
    changes: visibleChanges,
  };
}
