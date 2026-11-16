// KnowledgeReviewTask — maintenance agent runtime for ONE subject. Mounts the shared
// knowledge_review tools through piDomainMount; proposals still land in the inbox, and
// strength-A node creation is auto-applied there by the automated lane.
//
// The subject is the unit of work: each run sees only its own active subtree, its own
// profile and its own recent failures, so one subject's granularity never rewrites
// another's tree and a quiet subject is never crowded out by a busy one's rows.

import { and, inArray, isNull } from 'drizzle-orm';
import { piDomainMount } from '@/ai/pi-tool-mount';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  type FailureAttempt,
  getFailureAttemptsForDerivation,
} from '@/kernel/read-models/failure-attempts';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { subjectRootId } from '@/kernel/records/knowledge-node-birth';
import { DOMAIN_TOOL_MCP_SERVER_NAME, resolveDomainToolNames } from '@/kernel/tools/allowlists';
import { streamTask } from '@/server/ai/runner';
import {
  type SubjectProfile,
  getDefaultSubjectRegistry,
  resolveSelectableSubjectId,
  resolveSubjectProfile,
} from '@/subjects/profile';

/** Model-input cap for one subject; the scan itself is bounded by time, not by this. */
const RECENT_MISTAKES_LIMIT = 100;

/**
 * "New failures" for a nightly run. There is no per-subject watermark, so this is a
 * plain window: the last day of failures a subject could still have acted on. A
 * subject whose newest failure predates it costs no model call.
 */
const RECENT_MISTAKES_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MaintenanceTreeRow = {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  version: number;
  merged_from: string[];
};

export type MaintenanceRecentMistake = {
  id: string;
  // Prompt recipe field is `question_id`, not the ActivityRef legacy name.
  question_id: string;
  knowledge_ids: string[];
  cause: {
    source: string;
    primary_category: string;
    secondary_categories: string[];
    analysis_md: string | null;
    confidence: number | null;
  } | null;
};

export type MaintenanceAgentNote = {
  id: string;
  signal_kind: string;
  summary_md: string;
  refs: Array<{ kind: string; id: string }>;
  source_task_kind: string;
  confidence?: number;
};

export interface MaintenanceReviewTarget {
  subject: string;
  subjectProfile: SubjectProfile;
  input: {
    tree: MaintenanceTreeRow[];
    recent_mistakes: MaintenanceRecentMistake[];
    // HINTS left by narrow tasks, not facts: direct attention, never ground truth.
    // Empty means the task behaves as before.
    agent_notes: MaintenanceAgentNote[];
  };
}

export interface MaintenanceReviewPlan {
  /** Subjects with failures inside the window, in stable subject order. */
  targets: MaintenanceReviewTarget[];
  /** Selectable subjects with nothing new; reported so an idle night is explainable. */
  skipped_subjects: string[];
}

/** Active nodes of one subject, plus its synthetic seed anchor as the root parent. */
async function loadSubjectTree(db: Db, subjectId: string): Promise<MaintenanceTreeRow[]> {
  // The subject resolver treats the seed root as structural scaffolding and drops it,
  // but the model still needs it as the parent it may propose new KCs under.
  const ids = [
    ...new Set([...(await resolveSubjectKnowledgeIds(db, subjectId)), subjectRootId(subjectId)]),
  ];
  return db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .where(and(isNull(knowledge.archived_at), inArray(knowledge.id, ids)))
    .orderBy(knowledge.created_at);
}

function toRecentMistake(failure: FailureAttempt): MaintenanceRecentMistake {
  const cause = effectiveCauseForFailureAttempt(failure);
  return {
    id: failure.attempt_event_id,
    question_id: failure.question_id,
    knowledge_ids: failure.referenced_knowledge_ids,
    cause: cause
      ? {
          source: cause.source,
          primary_category: cause.primary_category,
          secondary_categories: cause.secondary_categories,
          analysis_md: cause.analysis_md ?? cause.user_notes,
          confidence: cause.confidence,
        }
      : null,
  };
}

/**
 * One target per selectable subject with failures inside the window, in stable
 * subject order, plus the subjects that had none. The failure scan happens once and
 * groups in memory: adding subjects does not add scans, and no subject's volume can
 * starve another.
 *
 * Subject membership uses the shared knowledge → profile resolution, so this axis
 * matches review scheduling and activity reads instead of inventing a second one.
 */
export async function planMaintenanceReview(
  db: Db,
  now: Date = new Date(),
): Promise<MaintenanceReviewPlan> {
  const selectableSubjects = getDefaultSubjectRegistry().getSelectableSubjectIds().sort();
  const failures = await getFailureAttemptsForDerivation(db, {
    includeReviewFailures: true,
    since: new Date(now.getTime() - RECENT_MISTAKES_WINDOW_MS),
    // No shared row cap: a cap is what used to let one busy subject hide another.
    limit: null,
  });
  if (failures.length === 0) {
    return { targets: [], skipped_subjects: selectableSubjects };
  }

  const subjectByAttempt = await batchResolveSubjectIds(
    db,
    failures.map((failure) => ({
      id: failure.attempt_event_id,
      knowledge_ids: failure.referenced_knowledge_ids,
    })),
  );

  const failuresBySubject = new Map<string, FailureAttempt[]>();
  for (const failure of failures) {
    const subjectId = resolveSelectableSubjectId(subjectByAttempt.get(failure.attempt_event_id));
    // `general`, retired and unknown ids are not maintenance units. A failure with no
    // knowledge reference has no subject to attribute it to, so it cannot join a
    // per-subject run at all.
    if (!subjectId) continue;
    const bucket = failuresBySubject.get(subjectId) ?? [];
    if (bucket.length < RECENT_MISTAKES_LIMIT) bucket.push(failure);
    failuresBySubject.set(subjectId, bucket);
  }

  // U8 / AF §4 — un-expired hints for 'maintenance'. Additive context only; never
  // durable facts. Empty on the common path.
  const agentNotes: MaintenanceAgentNote[] = (
    await readAgentNotes(db, { for_agent: 'maintenance', now })
  ).map((n) => ({
    id: n.id,
    signal_kind: n.signal_kind,
    summary_md: n.summary_md,
    refs: n.refs,
    source_task_kind: n.source_task_kind,
    ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
  }));

  const targets: MaintenanceReviewTarget[] = [];
  for (const subjectId of selectableSubjects) {
    const subjectFailures = failuresBySubject.get(subjectId);
    if (!subjectFailures || subjectFailures.length === 0) continue;
    targets.push({
      subject: subjectId,
      subjectProfile: resolveSubjectProfile(subjectId),
      input: {
        tree: await loadSubjectTree(db, subjectId),
        recent_mistakes: subjectFailures.map(toRecentMistake),
        agent_notes: agentNotes,
      },
    });
  }
  return {
    targets,
    skipped_subjects: selectableSubjects.filter((id) => !failuresBySubject.has(id)),
  };
}

export interface MaintenanceReviewRunCtx {
  db: Db;
  target: MaintenanceReviewTarget;
}

/**
 * Start the model run for one prepared subject. The caller owns draining the stream
 * and settling the run.
 */
export function runMaintenanceReview(ctx: MaintenanceReviewRunCtx): Response {
  const { db, target } = ctx;
  const taskRunId = newId();
  return streamTask('KnowledgeReviewTask', target.input, {
    db,
    subjectProfile: target.subjectProfile,
    piToolMounts: [
      // YUK-1553 — registered knowledge_review surface via the shared DomainTool
      // bridge; actor 'maintenance' matches the agent-notes channel.
      piDomainMount({
        ctx: {
          db,
          taskRunId,
          providerAttemptCaller: 'worker',
          callerActor: { kind: 'agent', ref: 'maintenance' },
        },
        serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
        toolNames: resolveDomainToolNames('knowledge_review'),
        taskKind: 'KnowledgeReviewTask',
      }),
    ],
    taskRunId,
    // The bridge already logs each call; keep the runner's input-only log off.
    autoLogToolCalls: false,
  });
}
