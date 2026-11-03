// KnowledgeReviewTask — maintenance agent runtime. Mounts the shared
// knowledge_review tools through piDomainMount; proposals are proposal-only and the
// user accepts in the inbox.

import { piDomainMount } from '@/ai/pi-tool-mount';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { DOMAIN_TOOL_MCP_SERVER_NAME, resolveDomainToolNames } from '@/kernel/tools/allowlists';
import { streamTask } from '@/server/ai/runner';
import { resolveSubjectProfile } from '@/subjects/profile';

const RECENT_MISTAKES_LIMIT = 100;

async function buildReviewInput(db: Db) {
  const tree = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      version: knowledge.version,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .orderBy(knowledge.created_at);

  // U8 / AF §4 — un-expired hints for 'maintenance'. Additive context only; never
  // durable facts. Empty on the common path.
  const agent_notes = (await readAgentNotes(db, { for_agent: 'maintenance', now: new Date() })).map(
    (n) => ({
      id: n.id,
      signal_kind: n.signal_kind,
      summary_md: n.summary_md,
      refs: n.refs,
      source_task_kind: n.source_task_kind,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
    }),
  );

  const attempts = await getFailureAttempts(db, {
    includeReviewFailures: true,
    limit: RECENT_MISTAKES_LIMIT,
  });
  const recent_mistakes = attempts.map((fa) => {
    const cause = effectiveCauseForFailureAttempt(fa);
    return {
      id: fa.attempt_event_id,
      // Prompt recipe field is `question_id`, not the ActivityRef legacy name.
      question_id: fa.question_id,
      knowledge_ids: fa.referenced_knowledge_ids,
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
  });

  return {
    input: {
      tree,
      recent_mistakes,
      // HINTS left by narrow tasks, not facts: direct attention, never ground truth.
      // Empty means the task behaves as before.
      agent_notes,
    },
    subjectProfile: resolveSubjectProfile(resolveSingleTreeDomain(tree)),
  };
}

function resolveSingleTreeDomain(tree: Array<{ domain: string | null }>): string | null {
  const domains = new Set(
    tree.map((row) => row.domain).filter((domain): domain is string => Boolean(domain)),
  );
  return domains.size === 1 ? ([...domains][0] ?? null) : null;
}

export interface StreamReviewTaskCtx {
  db: Db;
}

export async function streamReviewTask(ctx: StreamReviewTaskCtx): Promise<Response> {
  const { input, subjectProfile } = await buildReviewInput(ctx.db);
  const taskRunId = newId();
  return streamTask('KnowledgeReviewTask', input, {
    db: ctx.db,
    subjectProfile,
    piToolMounts: [
      // YUK-1553 — registered knowledge_review surface via the shared DomainTool
      // bridge; actor 'maintenance' matches the agent-notes channel.
      piDomainMount({
        ctx: {
          db: ctx.db,
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
