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
import { briefPurposeCurrent, latestPurposeWithdrawal } from '@/kernel/read-models/purpose-change';
import { markBriefPurpose } from '../server/memory/brief-purpose';

export const DIGEST_SCOPE = 'global:digest';
export const CONTEXT_CHANGE = 'experimental:context_change';
export const TALK_TOPIC = 'communication';
const Fact = z.object({
  id: z.string(), body: z.string().min(1).max(400),
  kind: z.enum(['fact', 'correction']),
  memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
  written_by: z.enum(['companion', 'curator', 'learner']),
  evidence_ids: z.array(z.string()), as_of: z.string(),
  supersedes: z.array(z.string()),
});
export const Topic = z.object({
  key: z.string().min(1).max(100), name: z.string().min(1).max(80),
  description: z.string().max(160), facts: z.array(Fact), updated_at: z.string(),
});
export const Digest = z.object({
  format: z.literal(1), topics: z.array(Topic),
  as_of: z.string().nullable(), overnight: z.string().nullable(),
});
export type DigestT = z.infer<typeof Digest>;
export type TopicT = z.infer<typeof Topic>;
export type FactT = z.infer<typeof Fact>;
export const TopicPatch = z.object({
  key: z.string().min(1).max(100), name: z.string().min(1).max(80),
  description: z.string().max(160), body: z.string().min(1).max(400),
  memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
  replaces: z.array(z.string()).default([]),
});
export type TopicPatchT = z.infer<typeof TopicPatch>;
export const ChangeResult = z.object({
  status: z.enum(['changed', 'unchanged', 'issue']), change_id: z.string().nullable(),
  version: z.number().int(), before: z.array(Topic), after: z.array(Topic),
  issues: z.array(z.object({ kind: z.enum(['unmergeable', 'correction_protected']), detail: z.string() })),
});
const empty = (): DigestT => ({ format: 1, topics: [], as_of: null, overnight: null });

export async function readTopics(db: Db | Tx) {
  const [row] = await db.select().from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, DIGEST_SCOPE)).limit(1);
  if (!row) return { digest: empty(), version: 0 };
  if (!(await briefPurposeCurrent(db, DIGEST_SCOPE, row.version)))
    throw new Error('context purpose repair required');
  return { digest: Digest.parse(JSON.parse(row.long_term_md)), version: row.version };
}

function portrait(digest: DigestT) {
  return digest.topics.filter(t => t.key !== TALK_TOPIC)
    .map(t => `${t.name}：${t.facts.map(f => f.body).join('；')}`).join('\n');
}

async function persist(tx: Tx, before: DigestT, after: DigestT, version: number,
  input: { actor: FactT['written_by']; taskRunId: string; sourceIds: string[]; undoOf?: string }) {
  const now = new Date();
  const changeId = newId();
  const allIds = [...new Set(after.topics.flatMap(t => t.facts.flatMap(f => f.evidence_ids)))];
  for (const id of [...new Set([...allIds, ...input.sourceIds])].sort())
    await lockEventDerivationSources(tx, id);
  const allowed = await allowedEventIds(tx, [...new Set([...allIds, ...input.sourceIds])]);
  if ([...allIds, ...input.sourceIds].some(id => !allowed.has(id)))
    throw new Error('restricted or missing context evidence');
  const withdrawal = await latestPurposeWithdrawal(tx);
  await writeEvent(tx, {
    id: changeId, action: CONTEXT_CHANGE, actor_kind: input.actor === 'learner' ? 'user' : 'agent',
    actor_ref: input.actor, subject_kind: 'query', subject_id: DIGEST_SCOPE,
    payload: { format: 1, before, after, version: version + 1, task_run_id: input.taskRunId,
      undo_of: input.undoOf ?? null, evidence_ids: allIds },
    affected_scopes: [], ingest_at: now,
  });
  const md = portrait(after);
  await tx.insert(memory_brief_note).values({
    id: `memory_brief:${DIGEST_SCOPE}`, scope_key: DIGEST_SCOPE,
    recent_week_md: md, recent_months_md: '', long_term_md: JSON.stringify(after),
    recent_week_evidence_ids: allIds, recent_months_evidence_ids: [], long_term_evidence_ids: allIds,
    evidence_count: allIds.length, source_event_id: input.sourceIds[0] ?? null,
    latest_evidence_at: now, refreshed_at: now, created_at: now, updated_at: now, version: version + 1,
  }).onConflictDoUpdate({ target: memory_brief_note.scope_key, set: {
    recent_week_md: md, long_term_md: JSON.stringify(after), recent_week_evidence_ids: allIds,
    long_term_evidence_ids: allIds, evidence_count: allIds.length,
    source_event_id: input.sourceIds[0] ?? null, latest_evidence_at: now,
    refreshed_at: now, updated_at: now, version: version + 1,
  } });
  await markBriefPurpose(tx, DIGEST_SCOPE, version + 1, withdrawal);
  return ChangeResult.parse({ status: 'changed', change_id: changeId, version: version + 1,
    before: before.topics, after: after.topics, issues: [] });
}

export async function changeTopics(db: Db, input: {
  expectedVersion: number; actor: FactT['written_by']; taskRunId: string;
  sourceIds: string[]; patches?: TopicPatchT[]; withdrawKey?: string; undoId?: string;
  asOf?: string; overnight?: string | null;
}) {
  return db.transaction(async tx => {
    await lockPurposeBrief(tx);
    const { digest: before, version } = await readTopics(tx);
    if (version !== input.expectedVersion) throw new Error('context version conflict; reload');
    const after = structuredClone(before);
    const result = (issues: z.infer<typeof ChangeResult>['issues']) => ChangeResult.parse({
      status: issues.length ? 'issue' : 'unchanged', change_id: null, version,
      before: before.topics, after: before.topics, issues,
    });
    if (input.undoId) {
      const [row] = await tx.select().from(event).where(and(eq(event.id, input.undoId), eq(event.action, CONTEXT_CHANGE)));
      const payload = z.object({ before: Digest, after: Digest, version: z.number() }).parse(row?.payload);
      if (payload.version !== version) throw new Error('later changes exist; correct the affected topic instead');
      after.topics = payload.before.topics.map(t => ({ ...t, updated_at: new Date().toISOString(),
        facts: t.facts.map(f => ({ ...f, id: newId(), supersedes: [f.id] })) }));
      after.as_of = payload.before.as_of;
      after.overnight = payload.before.overnight;
    } else if (input.withdrawKey) {
      after.topics = after.topics.filter(t => t.key !== input.withdrawKey);
    } else {
      for (const patch of input.patches ?? []) {
        const replaced = after.topics.flatMap(t => t.facts).filter(f => patch.replaces.includes(f.id));
        if (replaced.length !== new Set(patch.replaces).size) throw new Error('unknown replacement fact');
        if (replaced.length > 1 && (patch.memory_kind === 'weakness' || patch.memory_kind === 'event' ||
          replaced.some(f => f.memory_kind === 'weakness' || f.memory_kind === 'event')))
          return result([{ kind: 'unmergeable', detail: 'weakness/event facts must remain separate; supersede individually' }]);
        if (input.actor === 'curator' && replaced.some(f => f.kind === 'correction'))
          return result([{ kind: 'correction_protected', detail: 'Learner correction wins; add new evidence without replacing it' }]);
        let topic = after.topics.find(t => t.key === patch.key);
        if (topic?.facts.some(f => f.body === patch.body) && !replaced.length) continue;
        const evidence = [...new Set([...input.sourceIds, ...replaced.flatMap(f => f.evidence_ids)])];
        if (!evidence.length) throw new Error('context write requires server-bound evidence');
        for (const t of after.topics) t.facts = t.facts.filter(f => !patch.replaces.includes(f.id));
        if (!topic) {
          topic = { key: patch.key, name: patch.name, description: patch.description, facts: [], updated_at: '' };
          after.topics.push(topic);
        }
        topic.name = patch.key === TALK_TOPIC ? '怎么和我说话' : patch.name;
        topic.description = patch.description;
        topic.updated_at = new Date().toISOString();
        topic.facts.push({ id: newId(), body: patch.body, kind: input.actor === 'learner' ? 'correction' : 'fact',
          memory_kind: patch.memory_kind, written_by: input.actor, evidence_ids: evidence,
          as_of: new Date().toISOString(), supersedes: patch.replaces });
      }
      after.topics = after.topics.filter(t => t.facts.length);
      if (input.asOf) after.as_of = input.asOf;
      if (input.overnight !== undefined) after.overnight = input.overnight;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return result([]);
    return persist(tx, before, after, version, { ...input, undoOf: input.undoId });
  });
}

export async function topicBoard(db: Db, now = new Date()) {
  const { digest, version } = await readTopics(db);
  const changes = await db.select({ id: event.id, at: event.created_at, payload: event.payload })
    .from(event).where(eq(event.action, CONTEXT_CHANGE)).orderBy(desc(event.created_at)).limit(30);
  const ids = [...new Set(digest.topics.flatMap(t => t.facts.flatMap(f => f.evidence_ids)))];
  const evidence = ids.length ? await db.select({ id: event.id, at: event.created_at }).from(event)
    .where(inArray(event.id, ids)) : [];
  const times = new Map(evidence.map(e => [e.id, e.at.getTime()]));
  return { version, topics: digest.topics.map(t => {
    const dates = t.facts.flatMap(f => f.evidence_ids.map(id => times.get(id))).filter((x): x is number => x !== undefined);
    const evidenceAt = dates.length ? Math.max(...dates) : null;
    const freshness = evidenceAt === null ? null : Math.exp(-Math.max(0, now.getTime() - evidenceAt) / (30 * 86400000));
    return { ...t, evidence_at: evidenceAt === null ? null : new Date(evidenceAt).toISOString(), freshness,
      stale: freshness === null || freshness < 0.5 };
  }), changes };
}
