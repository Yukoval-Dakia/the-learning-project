// Root-placement refile: teaching-draft questions authored before their topic
// node exists are filed under the synthetic subject root and keep the topic
// words in `metadata.teaching_draft.learner_topic`. When exactly one live kc
// node inside that subject's tree matches the topic under the shared
// normalized-equality rule, `question.knowledge_ids` becomes [node]. Zero or
// multiple matches skip without guessing; semantic similarity is out of scope
// by design.
//
// Apply mode serializes under the shared learning-state write lock, then
// FOR SHAREs the matched node before the question row FOR UPDATE — the same
// node→question order the retract path uses, so a concurrent archive/undo
// cannot leave the question pointing at a dead id. Eligibility is
// event-chronology, not version: only a row with zero attribution-changing
// QUESTION_EDIT_ACTION events is a candidate — the first recorded change is
// this move itself (once-ever), so a manual PATCH, a resubmit rewrite, a
// merge, or an earlier refile/undo all permanently disqualify the row.
// version is deliberately ignored: admission bumps it without choosing an
// attachment. The apply-time CAS still pins the observed knowledge_ids and
// version under FOR UPDATE. Each move writes a QUESTION_EDIT_ACTION event
// with before/after attribution (the undo path later uses it as the
// auto-ownership proof); draft questions never enroll scheduling. Report
// mode performs no writes — the flag gate is checked by the job wrapper,
// not inside the move.

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getConfigFlag } from '@/core/config/store';
import { normalizeKnowledgeNodeName } from '@/core/knowledge-name';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import {
  ROOT_PLACEMENT_REFILE_REASON,
  loadAttachmentChangeMap,
} from '@/kernel/proposals/node-question-attachments';
import { SYNTHETIC_SUBJECT_ROOT_RE } from '@/kernel/read-models/placement-scope';
import { enrollAddedKnowledgeScheduling } from './question-scheduling-enrollment';

/** Per-run bounds: one sweep reports on at most this many candidates, and apply
 * mode writes at most this many moves so a large backlog drains over sweeps. */
export const REFILE_SCAN_LIMIT = 500;
export const REFILE_APPLY_LIMIT = 25;

export type RefileStatus =
  | 'moved'
  | 'would_move'
  | 'skip:no_match'
  | 'skip:ambiguous'
  | 'skip:changed';

export interface RefileRow {
  question_id: string;
  learner_topic: string;
  root_id: string;
  subject: string;
  matched_node_ids: string[];
  matched_node_name: string | null;
  status: RefileStatus;
  detail?: string;
}

export interface RefileReport {
  mode: 'report' | 'apply';
  scanned: number;
  truncated: boolean;
  counts: Record<RefileStatus, number>;
  rows: RefileRow[];
}

interface CandidateRow {
  id: string;
  rootId: string;
  subject: string;
  learnerTopic: string;
  normTopic: string;
}

/** Live kc nodes keyed by effective-domain → normalized name. The effective
 * domain is the nearest ancestor's `domain` column (the read-model rule:
 * archived ancestors absent from the set end the walk). */
type DomainNameIndex = Map<string, Map<string, Array<{ id: string; name: string }>>>;

async function buildLiveDomainIndex(db: Db | Tx): Promise<DomainNameIndex> {
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parentId: knowledge.parent_id,
      role: knowledge.role,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const index: DomainNameIndex = new Map();
  for (const row of rows) {
    if (row.role !== 'kc') continue;
    let current: { id: string; domain: string | null; parentId: string | null } | undefined = row;
    const seen = new Set<string>();
    let domain: string | null = null;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.domain) {
        domain = current.domain;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!domain) continue;
    const normName = normalizeKnowledgeNodeName(row.name);
    if (!normName) continue;
    let byName = index.get(domain);
    if (!byName) {
      byName = new Map();
      index.set(domain, byName);
    }
    const list = byName.get(normName) ?? [];
    list.push({ id: row.id, name: row.name });
    byName.set(normName, list);
  }
  return index;
}

function rootSubject(rootId: string): string | null {
  const match = /^seed:([^:]+):root$/.exec(rootId);
  return match?.[1] ?? null;
}

async function scanCandidates(db: Db): Promise<{ candidates: CandidateRow[]; truncated: boolean }> {
  // The root-attached predicate lives in SQL: single-element knowledge_ids
  // matching the synthetic subject-root shape plus a recorded learner_topic.
  // Ownership is then proven by event chronology: any attribution-changing
  // QUESTION_EDIT_ACTION event — a manual PATCH, a resubmit rewrite, a merge,
  // an earlier refile or undo — permanently removes the row from candidacy
  // (each question moves at most once, and only before anyone chose for it).
  // random() ordering is the fairness mechanism: questions that can never
  // match (no live node / ambiguous name) stay in the set, and a fixed id
  // order would let enough of them starve every later candidate out of the
  // 500-row page. Stateless rotation gives each candidate an equal share of
  // every run without cursor bookkeeping.
  const rows = await db
    .select({
      id: question.id,
      knowledgeIds: question.knowledge_ids,
      learnerTopic: sql<
        string | null
      >`${question.metadata} -> 'teaching_draft' ->> 'learner_topic'`,
    })
    .from(question)
    .where(
      and(
        sql`jsonb_array_length(${question.knowledge_ids}) = 1`,
        sql`${question.knowledge_ids} ->> 0 ~ '^seed:[^:]+:root$'`,
        sql`${question.metadata} -> 'teaching_draft' ->> 'learner_topic' is not null`,
      ),
    )
    .orderBy(sql`random()`)
    .limit(REFILE_SCAN_LIMIT + 1);
  const truncated = rows.length > REFILE_SCAN_LIMIT;
  const shaped: CandidateRow[] = [];
  for (const row of rows.slice(0, REFILE_SCAN_LIMIT)) {
    const [only] = row.knowledgeIds;
    if (typeof only !== 'string' || !SYNTHETIC_SUBJECT_ROOT_RE.test(only)) continue;
    const subject = rootSubject(only);
    if (subject == null) continue;
    const learnerTopic = row.learnerTopic ?? '';
    const normTopic = normalizeKnowledgeNodeName(learnerTopic);
    if (!normTopic) continue;
    shaped.push({ id: row.id, rootId: only, subject, learnerTopic, normTopic });
  }
  const changes = await loadAttachmentChangeMap(
    db,
    shaped.map((row) => row.id),
  );
  return {
    candidates: shaped.filter((row) => (changes.get(row.id)?.length ?? 0) === 0),
    truncated,
  };
}

function countStatuses(rows: RefileRow[]): Record<RefileStatus, number> {
  const counts: Record<RefileStatus, number> = {
    moved: 0,
    would_move: 0,
    'skip:no_match': 0,
    'skip:ambiguous': 0,
    'skip:changed': 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

async function applyOneMove(
  tx: Tx,
  candidate: CandidateRow,
  now: Date,
): Promise<{ status: 'moved' | 'skip:changed'; detail?: string }> {
  await acquireLearningStateWriteLock(tx);

  // Lock order mirrors the retract path (node before question): SHARE the
  // matched node so a concurrent archive/undo waits for this commit — or, if
  // the archive already committed, the share resolves to no live row.
  const index = await buildLiveDomainIndex(tx);
  const matches = index.get(candidate.subject)?.get(candidate.normTopic) ?? [];
  if (matches.length !== 1) {
    return { status: 'skip:changed', detail: `matches now ${matches.length}` };
  }
  const node = matches[0] as { id: string; name: string };
  const [liveNode] = await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(eq(knowledge.id, node.id), isNull(knowledge.archived_at)))
    .for('share');
  if (liveNode == null) return { status: 'skip:changed', detail: 'node archived mid-move' };

  const [row] = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      knowledgeIds: question.knowledge_ids,
      version: question.version,
      learnerTopic: sql<
        string | null
      >`${question.metadata} -> 'teaching_draft' ->> 'learner_topic'`,
    })
    .from(question)
    .where(eq(question.id, candidate.id))
    .limit(1)
    .for('update');
  if (row == null) return { status: 'skip:changed', detail: 'question gone' };
  // Edits — learner, editor, an earlier move — must stick: only rows still
  // root-attached in the same tree are eligible.
  if (row.knowledgeIds.length !== 1 || row.knowledgeIds[0] !== candidate.rootId) {
    return { status: 'skip:changed', detail: 'no longer root-attached' };
  }
  // A changed learner_topic re-matches against this transaction's index; only
  // the exact same unique node still qualifies.
  const liveTopic = normalizeKnowledgeNodeName(row.learnerTopic ?? '');
  const liveMatches = index.get(candidate.subject)?.get(liveTopic) ?? [];
  if (liveMatches.length !== 1 || liveMatches[0]?.id !== node.id) {
    return { status: 'skip:changed', detail: 'learner_topic changed' };
  }

  // Generated parts snapshot the parent's persisted labels at materialization;
  // a part still pointing at the same synthetic root may follow the parent —
  // but only when its own history is just as untouched (checked per part
  // below, never assumed from the parent's proof).
  const parts = await tx
    .select({
      id: question.id,
      knowledgeIds: question.knowledge_ids,
      version: question.version,
      draftStatus: question.draft_status,
    })
    .from(question)
    .where(
      and(
        eq(question.parent_question_id, row.id),
        sql`${question.knowledge_ids} = ${JSON.stringify([candidate.rootId])}::jsonb`,
      ),
    )
    .orderBy(asc(question.id))
    .for('update');

  // Re-prove ownership under the row locks: the candidate scan ran outside
  // this transaction, and every attribution writer serializes on these rows.
  const changes = await loadAttachmentChangeMap(tx, [row.id, ...parts.map((part) => part.id)]);
  if ((changes.get(row.id)?.length ?? 0) > 0) {
    return { status: 'skip:changed', detail: 'attribution history exists' };
  }
  const movableParts = parts.filter((part) => (changes.get(part.id)?.length ?? 0) === 0);

  const updated = await tx
    .update(question)
    .set({ knowledge_ids: [node.id], updated_at: now, version: row.version + 1 })
    .where(
      and(
        eq(question.id, row.id),
        eq(question.version, row.version),
        sql`${question.knowledge_ids} = ${JSON.stringify(row.knowledgeIds)}::jsonb`,
      ),
    )
    .returning({ id: question.id });
  if (updated.length === 0) return { status: 'skip:changed', detail: 'row changed under CAS' };

  const eventId = createId();
  const enrolledKnowledgeIds = new Set<string>();
  const enroll = async (draftStatus: string | null) => {
    if (draftStatus === 'draft') return;
    for (const id of await enrollAddedKnowledgeScheduling(tx, {
      knowledgeIds: [node.id],
      evidenceEventId: eventId,
      now,
    })) {
      enrolledKnowledgeIds.add(id);
    }
  };
  const writeRefileEvent = (
    questionId: string,
    beforeIds: string[],
    previousVersion: number,
    extra?: Record<string, unknown>,
  ) =>
    writeEvent(tx, {
      id: createId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'root_placement_refile',
      action: QUESTION_EDIT_ACTION,
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        previous_version: previousVersion,
        next_version: previousVersion + 1,
        before: { knowledge_ids: beforeIds },
        after: { knowledge_ids: [node.id] },
        reason: ROOT_PLACEMENT_REFILE_REASON,
        learner_topic: row.learnerTopic,
        matched_node_name: node.name,
        ...extra,
      },
    });

  for (const part of movableParts) {
    const moved = await tx
      .update(question)
      .set({ knowledge_ids: [node.id], updated_at: now, version: part.version + 1 })
      .where(
        and(
          eq(question.id, part.id),
          eq(question.version, part.version),
          sql`${question.knowledge_ids} = ${JSON.stringify(part.knowledgeIds)}::jsonb`,
        ),
      )
      .returning({ id: question.id });
    if (moved.length === 0) continue;
    await enroll(part.draftStatus);
    await writeRefileEvent(part.id, part.knowledgeIds, part.version, {
      part_of_question_id: row.id,
    });
  }

  await enroll(row.draftStatus);
  await writeRefileEvent(row.id, row.knowledgeIds, row.version, {
    ...(enrolledKnowledgeIds.size > 0
      ? { enrolled_knowledge_ids: [...enrolledKnowledgeIds].sort() }
      : {}),
  });
  return { status: 'moved' };
}

/** One refile run: scan → report each candidate; apply mode additionally writes
 * up to REFILE_APPLY_LIMIT unique matches, each in its own transaction. */
export async function runRootPlacementRefile(
  db: Db,
  mode: 'report' | 'apply',
): Promise<RefileReport> {
  const { candidates, truncated } = await scanCandidates(db);
  const index = await buildLiveDomainIndex(db);
  const rows: RefileRow[] = [];
  let applied = 0;
  const now = new Date();
  for (const candidate of candidates) {
    const matches = index.get(candidate.subject)?.get(candidate.normTopic) ?? [];
    const matchedNodeIds = matches.map((match) => match.id).sort();
    const base: Omit<RefileRow, 'status'> = {
      question_id: candidate.id,
      learner_topic: candidate.learnerTopic,
      root_id: candidate.rootId,
      subject: candidate.subject,
      matched_node_ids: matchedNodeIds,
      matched_node_name: matches.length === 1 ? (matches[0]?.name ?? null) : null,
    };
    if (matches.length !== 1) {
      rows.push({
        ...base,
        status: matches.length === 0 ? 'skip:no_match' : 'skip:ambiguous',
      });
      continue;
    }
    if (mode === 'report' || applied >= REFILE_APPLY_LIMIT) {
      rows.push({ ...base, status: 'would_move' });
      continue;
    }
    try {
      const result = await db.transaction(async (tx) => applyOneMove(tx, candidate, now));
      rows.push({
        ...base,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });
      if (result.status === 'moved') applied += 1;
    } catch (err) {
      rows.push({
        ...base,
        status: 'skip:changed',
        detail: `tx failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return {
    mode,
    scanned: candidates.length,
    truncated,
    counts: countStatuses(rows),
    rows,
  };
}

export const QUESTION_ROOT_PLACEMENT_REFILE_ENABLED_KEY = 'QUESTION_ROOT_PLACEMENT_REFILE_ENABLED';

/** Dry-run by default: while the flag is off the sweep only logs what it would
 * move. Flip the flag to start writing; the report contract is unchanged. */
export function buildRootPlacementRefileHandler(db: Db) {
  return async () => {
    const mode = getConfigFlag(QUESTION_ROOT_PLACEMENT_REFILE_ENABLED_KEY) ? 'apply' : 'report';
    const report = await runRootPlacementRefile(db, mode);
    console.log(
      '[root_placement_refile]',
      JSON.stringify({
        mode: report.mode,
        scanned: report.scanned,
        truncated: report.truncated,
        counts: report.counts,
      }),
    );
  };
}
