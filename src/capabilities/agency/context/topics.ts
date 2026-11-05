// Current topics reuse the brief row; immutable before/after versions live in
// the event ledger so C1 can migrate both without losing reversibility.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { allowedEventIds, lockEventDerivationSources } from '@/kernel/events/derivation-policy';
import { ApiError } from '@/kernel/http';
import { lockPurposeBrief } from '@/kernel/locks/memory-locks';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { briefPurposeCurrent, latestPurposeWithdrawal } from '@/kernel/read-models/purpose-change';
import { markBriefPurpose } from '../server/memory/brief-purpose';
import { type LegacyFact, readLegacyFacts, restoreLegacy, supersedeLegacy } from './legacy-facts';
import { readMemoryBriefNote } from './memory-brief';

import {
  CONTEXT_CHANGE,
  ChangeResult,
  DIGEST_SCOPE,
  Digest,
  type DigestT,
  EDIT_MAX_PATCHES,
  EDIT_MAX_REPLACEMENTS,
  type FactT,
  TALK_TOPIC,
  type TopicPatchT,
} from './topic-contract';

const empty = (): DigestT => ({
  format: 1,
  topics: [],
  as_of: null,
  overnight: null,
  legacy_global_version: null,
  withdrawals: [],
});

async function storedTopics(db: Db | Tx) {
  const [row] = await db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, DIGEST_SCOPE))
    .limit(1);
  if (row) {
    const digest = Digest.parse(JSON.parse(row.long_term_md));
    for (const withdrawal of digest.withdrawals.filter(
      (w) => !w.evidence_ids.length || w.retained_fact_ids === undefined,
    )) {
      const [change] = await db
        .select({ payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, CONTEXT_CHANGE),
            sql`${event.payload}->'after'->'withdrawals' @> ${JSON.stringify([{ key: withdrawal.key, at: withdrawal.at }])}::jsonb`,
          ),
        )
        .orderBy(event.created_at)
        .limit(1);
      if (change) {
        const before = z.object({ before: Digest }).parse(change.payload).before;
        withdrawal.retained_fact_ids ??= before.topics
          .filter((t) => t.key !== withdrawal.key)
          .flatMap((t) => t.facts.map((f) => f.id));
        withdrawal.evidence_ids = withdrawal.evidence_ids.length
          ? withdrawal.evidence_ids
          : [
              ...new Set(
                before.topics
                  .filter((t) => t.key === withdrawal.key)
                  .flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)),
              ),
            ];
      }
    }
    return { digest, version: row.version };
  }
  const { note } = await readMemoryBriefNote(db, 'global');
  const digest = empty();
  if (note) {
    digest.legacy_global_version = note.version;
    const parts = [
      [note.recent_week_md, note.recent_week_evidence_ids],
      [note.recent_months_md, note.recent_months_evidence_ids],
      [note.long_term_md, note.long_term_evidence_ids],
    ] as const;
    const facts = parts.flatMap(([body, ids], part) =>
      !body || !ids.length
        ? []
        : Array.from({ length: Math.ceil(body.length / 400) }, (_, chunk) => ({
            id: `legacy-global:${part}:${chunk}`,
            body: body.slice(chunk * 400, (chunk + 1) * 400),
            kind: 'fact' as const,
            memory_kind: 'event' as const,
            written_by: 'curator' as const,
            evidence_ids: ids,
            as_of: note.refreshed_at?.toISOString() ?? '',
            supersedes: [],
            knowledge_ids: [],
          })),
    );
    if (facts.length)
      digest.topics.push({
        key: 'legacy-global',
        scope_key: 'global',
        name: '学习近况',
        description: '最近的学习经历与习惯',
        facts,
        updated_at: note.refreshed_at?.toISOString() ?? '',
      });
  }
  return { digest, version: 0 };
}

export function withdrawnTopicEvidence(digest: DigestT) {
  return new Set(digest.withdrawals.flatMap((w) => w.evidence_ids));
}

async function permittedDigest(db: Db | Tx, stored: DigestT) {
  const digest = structuredClone(stored);
  const ids = digest.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids));
  const allowed = await allowedEventIds(db, ids);
  digest.topics = digest.topics
    .map((t) => ({
      ...t,
      facts: t.facts.filter(
        (f) =>
          f.evidence_ids.length > 0 &&
          f.evidence_ids.every((id) => allowed.has(id)) &&
          stored.withdrawals.every(
            (w) =>
              !f.evidence_ids.some((id) => w.evidence_ids.includes(id)) ||
              w.retained_fact_ids?.includes(f.id),
          ),
      ),
    }))
    .filter((t) => t.facts.length);
  return digest;
}

export async function readTopics(db: Db | Tx) {
  const { digest, version } = await storedTopics(db);
  const visible = await permittedDigest(db, digest);
  if (!(await briefPurposeCurrent(db, DIGEST_SCOPE, version))) visible.overnight = null;
  return { digest: visible, version };
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
    remainingChanges?: string[];
    requestComplete?: boolean;
  },
) {
  const now = new Date();
  const changeId = newId();
  const allIds = [...new Set(after.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)))];
  for (const id of [...new Set([...allIds, ...input.sourceIds])].sort())
    await lockEventDerivationSources(tx, id);
  const allowed = await allowedEventIds(tx, [...new Set([...allIds, ...input.sourceIds])]);
  if ([...allIds, ...input.sourceIds].some((id) => !allowed.has(id)))
    throw new ApiError(
      'context_evidence_restricted',
      'restricted or missing context evidence',
      409,
    );
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
      derivation_policy: 'answer_only',
      before,
      after,
      version: version + 1,
      task_run_id: input.taskRunId,
      legacy_before: input.legacy ?? [],
      undo_of: input.undoOf ?? null,
      remaining_changes: input.remainingChanges ?? [],
      request_complete: input.requestComplete ?? false,
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
    before: (await permittedDigest(tx, before)).topics,
    after: after.topics,
    issues: [],
    remaining_changes: input.remainingChanges ?? [],
    request_complete: input.requestComplete ?? false,
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
    editScope?: { topicKey?: string };
    legacyGlobalVersion?: number;
    remainingChanges?: string[];
    requestComplete?: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const preview = await storedTopics(tx);
    if (preview.version !== input.expectedVersion)
      throw new ApiError('context_version_conflict', 'context version conflict; reload', 409);
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
      ? z
          .object({
            before: Digest,
            after: Digest,
            legacy_before: z.array(z.object({ evidence_ids: z.array(z.string()) })).default([]),
          })
          .parse(undo[0].payload)
      : null;
    const refs = [
      ...new Set([
        ...input.sourceIds,
        ...preview.digest.topics.flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)),
        ...legacy.flatMap((f) => f.evidence_ids),
        ...(prior?.legacy_before.flatMap((f) => f.evidence_ids) ?? []),
        ...[...(prior?.before.topics ?? []), ...(prior?.after.topics ?? [])].flatMap((t) =>
          t.facts.flatMap((f) => f.evidence_ids),
        ),
      ]),
    ];
    // Purpose mutation locks source documents before the global brief lock.
    // Match that order, then CAS the projection before applying any change.
    for (const id of refs.sort()) await lockEventDerivationSources(tx, id);
    await lockPurposeBrief(tx);
    const { digest: before, version } = await storedTopics(tx);
    if (
      version !== input.expectedVersion ||
      JSON.stringify(before) !== JSON.stringify(preview.digest)
    )
      throw new ApiError('context_version_conflict', 'context version conflict; reload', 409);
    const after = await permittedDigest(tx, before);
    const purposeCurrent = await briefPurposeCurrent(tx, DIGEST_SCOPE, version);
    if (!purposeCurrent) after.overnight = null;
    const legacyChanged: LegacyFact[] = [];
    const result = (issues: z.infer<typeof ChangeResult>['issues']) =>
      ChangeResult.parse({
        status: issues.length ? 'issue' : 'unchanged',
        change_id: null,
        version,
        before: after.topics,
        after: after.topics,
        issues,
      });
    if (input.editScope) {
      const patches = input.patches ?? [];
      const replacements = patches.flatMap((patch) => {
        const topic = after.topics.find((t) => t.key === patch.key);
        return [
          ...new Set([
            ...patch.replaces,
            ...(patch.key === TALK_TOPIC ? (topic?.facts.map((f) => f.id) ?? []) : []),
          ]),
        ];
      });
      if (
        !patches.length ||
        patches.length > EDIT_MAX_PATCHES ||
        replacements.length > EDIT_MAX_REPLACEMENTS ||
        new Set(replacements).size !== replacements.length ||
        patches.some(
          (patch) =>
            patch.body.length > 400 ||
            (input.editScope?.topicKey && patch.key !== input.editScope.topicKey) ||
            patch.replaces.some(
              (id) =>
                !after.topics.find((t) => t.key === patch.key)?.facts.some((f) => f.id === id),
            ),
        ) ||
        patches.filter((p) => p.key === TALK_TOPIC).length > 1
      )
        return result([
          {
            kind: 'edit_scope_exceeded',
            detail: `Nothing was written. Submit up to ${EDIT_MAX_PATCHES} patches, replacing at most ${EDIT_MAX_REPLACEMENTS} facts total from their own topics; each body <=400 characters. Put unsaved requests in remaining_changes. Do not clean up unrelated facts.`,
          },
        ]);
    }
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
          undo_of: z.string().nullable().optional(),
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
      if (payload.undo_of)
        throw new ApiError(
          'context_undo_depth',
          'undo of an undo is not supported; correct the topic instead',
          409,
        );
      for (const fact of payload.legacy_before) {
        for (const id of fact.evidence_ids) await lockEventDerivationSources(tx, id);
        const allowed = await allowedEventIds(tx, fact.evidence_ids);
        if (fact.evidence_ids.some((id) => !allowed.has(id)))
          throw new ApiError('context_undo_restricted', 'restricted legacy undo evidence', 409);
      }
      await restoreLegacy(tx, payload.legacy_before, input.undoId);
      const keys = new Set([...payload.before.topics, ...payload.after.topics].map((t) => t.key));
      for (const key of keys) {
        const old = payload.before.topics.find((t) => t.key === key);
        const changed = payload.after.topics.find((t) => t.key === key);
        if (JSON.stringify(old) === JSON.stringify(changed)) continue;
        if (JSON.stringify(after.topics.find((t) => t.key === key)) !== JSON.stringify(changed))
          throw new ApiError(
            'context_undo_conflict',
            'topic has later changes; correct it instead',
            409,
          );
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
      const touched = [...keys].filter(
        (key) =>
          JSON.stringify(payload.before.topics.find((t) => t.key === key)) !==
          JSON.stringify(payload.after.topics.find((t) => t.key === key)),
      );
      for (const key of touched) {
        const expected = payload.after.withdrawals.find((w) => w.key === key);
        if (
          JSON.stringify(after.withdrawals.find((w) => w.key === key)) !== JSON.stringify(expected)
        )
          throw new ApiError('context_undo_conflict', 'topic withdrawal has later changes', 409);
        after.withdrawals = after.withdrawals.filter((w) => w.key !== key);
        const old = payload.before.withdrawals.find((w) => w.key === key);
        if (old) after.withdrawals.push(old);
      }
    } else if (input.withdrawKey) {
      const evidenceIds = [
        ...new Set([
          ...after.withdrawals
            .filter((w) => w.key === input.withdrawKey)
            .flatMap((w) => w.evidence_ids),
          ...before.topics
            .filter((t) => t.key === input.withdrawKey)
            .flatMap((t) => t.facts.flatMap((f) => f.evidence_ids)),
        ]),
      ];
      after.withdrawals = after.withdrawals.filter((w) => w.key !== input.withdrawKey);
      after.withdrawals.push({
        key: input.withdrawKey,
        at: new Date().toISOString(),
        evidence_ids: evidenceIds,
        retained_fact_ids: after.topics
          .filter((t) => t.key !== input.withdrawKey)
          .flatMap((t) => t.facts.map((f) => f.id)),
      });
      after.topics = after.topics.filter((t) => t.key !== input.withdrawKey);
    } else {
      for (const rawPatch of input.patches ?? []) {
        const patch = { ...rawPatch, replaces: [...rawPatch.replaces] };
        if (patch.key === TALK_TOPIC && patch.body.length > 400)
          return result([
            {
              kind: 'unmergeable',
              detail: 'Communication must fit one complete summary of at most 400 characters.',
            },
          ]);
        const bodies: string[] = [];
        let remaining = patch.body;
        while (remaining.length > 400) {
          const prefix = remaining.slice(0, 400);
          const boundary =
            Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf('\n')) +
            1;
          const size = boundary >= 200 ? boundary : 400;
          bodies.push(remaining.slice(0, size));
          remaining = remaining.slice(size);
        }
        if (remaining) bodies.push(remaining);
        const withdrawal = after.withdrawals.find((w) => w.key === patch.key);
        const withheld = withdrawnTopicEvidence(after);
        if (input.sourceIds.some((id) => withheld.has(id)))
          throw new ApiError(
            'context_topic_withdrawn',
            'withdrawn evidence cannot recreate a fact',
            409,
          );
        let patchSourceIds = input.sourceIds;
        if (withdrawal) {
          const sources = patchSourceIds.length
            ? await tx
                .select({
                  id: event.id,
                  at: event.created_at,
                  actor: event.actor_kind,
                  action: event.action,
                })
                .from(event)
                .where(inArray(event.id, patchSourceIds))
            : [];
          patchSourceIds = sources
            .filter(
              (e) =>
                e.actor === 'user' &&
                [
                  'experimental:copilot_user_ask',
                  'experimental:copilot_chip_trigger',
                  'experimental:context_edit_request',
                ].includes(e.action) &&
                e.at.getTime() > Date.parse(withdrawal.at),
            )
            .map((e) => e.id);
          if (!patchSourceIds.length)
            throw new ApiError(
              'context_topic_withdrawn',
              'topic needs new learner evidence after withdrawal',
              409,
            );
        }
        if (patch.key === TALK_TOPIC) {
          const current = after.topics.find((t) => t.key === TALK_TOPIC);
          // Communication has one complete compact brief, never an ever-growing
          // startup list. The writer receives all prior preferences in context.
          if (
            current?.facts.length === 1 &&
            current.facts[0]?.body === patch.body &&
            current.description === patch.description
          )
            continue;
          patch.replaces = [
            ...new Set([...patch.replaces, ...(current?.facts.map((f) => f.id) ?? [])]),
          ];
        }
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
              kind:
                f.payload.corrected_by_owner === true ? ('correction' as const) : ('fact' as const),
              written_by:
                f.payload.corrected_by_owner === true ? ('learner' as const) : ('curator' as const),
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
        const existingFacts = topic?.facts;
        if (
          topic &&
          bodies.every((body) => existingFacts?.some((f) => f.body === body)) &&
          !replaced.length
        ) {
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
          ...new Set([
            ...patchSourceIds,
            ...replaced.flatMap((f) => f.evidence_ids.filter((id) => !withheld.has(id))),
          ]),
        ];
        if (evidence.some((id) => withheld.has(id)))
          throw new ApiError(
            'context_topic_withdrawn',
            'withdrawn evidence cannot recreate a fact',
            409,
          );
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
        for (const body of bodies)
          topic.facts.push({
            id: newId(),
            body,
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
      if (input.legacyGlobalVersion !== undefined) {
        const [global] = await tx
          .select({ version: memory_brief_note.version })
          .from(memory_brief_note)
          .where(eq(memory_brief_note.scope_key, 'global'))
          .limit(1);
        if (global?.version === input.legacyGlobalVersion)
          after.legacy_global_version = input.legacyGlobalVersion;
      }
    }
    // Metadata alone must not shadow the legacy global while its purpose repair is pending.
    if (version === 0 && !after.topics.length) return result([]);
    if (purposeCurrent && JSON.stringify(before) === JSON.stringify(after)) return result([]);
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
    // The ledger row stays readable; only its before/after content is withheld
    // once the evidence it cites is restricted. The caller renders "已移除".
    visibleChanges.push({ ...change, restricted: refs.some((id) => !allowed.has(id)) });
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

/** Retry only the local CAS; never repeat the provider turn after it has written. */
export async function refreshTopicMetadata(
  db: Db,
  input: {
    taskRunId: string;
    asOf?: string;
    overnight?: string | null;
    legacyGlobalVersion?: number;
  },
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { version } = await readTopics(db);
    try {
      const change = await changeTopics(db, {
        expectedVersion: version,
        actor: 'curator',
        sourceIds: [],
        patches: [],
        ...input,
      });
      return change.version > 0;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'context_version_conflict') throw error;
    }
  }
  return false;
}
