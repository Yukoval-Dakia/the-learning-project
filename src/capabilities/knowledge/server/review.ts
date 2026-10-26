// KnowledgeReviewTask — maintenance agent runtime. Mounts the shared
// knowledge_review tools through piDomainMount; proposals are proposal-only and the
// user accepts in the inbox. runWriteProposal is a compatibility adapter for
// existing programmatic callers and forwards to the same registered tools.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { DOMAIN_TOOL_MCP_SERVER_NAME, resolveDomainToolNames } from '@/kernel/tools/allowlists';
import type { ToolContext } from '@/kernel/tools/types';
import { streamTask } from '@/server/ai/runner';
import { piDomainMount } from '@/server/ai/tools/pi-tools';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type KnowledgeMutationOutput,
  type ProposeKnowledgeEdgeOutput,
  proposeKnowledgeEdgeTool,
  proposeKnowledgeMutationTool,
} from './tools/proposal-tools';

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

// Compatibility adapter: existing programmatic callers pass the retired tool's arg
// shape; this forwards to the registered DomainTools so there is one proposal
// implementation. Strict schemas throw instead of silently writing a cast-shaped event.

export interface WriteProposalArgs {
  mutation?: string;
  payload: unknown;
  reasoning: string;
  evidence_event_ids?: string[];
}

interface WriteProposalCtx {
  taskRunId?: string;
}

export type WriteProposalResult =
  | {
      proposal_id?: string;
      event_id?: string;
      kind: 'tree_mutation' | 'knowledge_edge_propose';
    }
  | {
      proposal_id: string;
      kind: 'skipped_duplicate';
      cooldown_key: string;
    }
  | {
      proposal_id: string;
      kind: 'skipped_cooldown';
      cooldown_key: string;
      cooldown_until: string;
    }
  | {
      edge_id: string;
      kind: 'skipped:duplicate_live_edge';
    }
  // P5.4 — rubric-rejected edge: the event is still written; the verdict reaches
  // the agent as structured feedback.
  | {
      event_id: string;
      kind: 'rubric_rejected';
      gate: string;
      reason: string;
    }
  // YUK-1553 — shared-tool world-state skips; `status` carries the exact tool
  // status string.
  | {
      kind: 'skipped';
      status: string;
      proposal_id?: string;
      cooldown_key?: string;
      reason?: string;
    };

export async function runWriteProposal(
  db: Db,
  args: WriteProposalArgs,
  ctx: WriteProposalCtx = {},
): Promise<WriteProposalResult> {
  // Preserve the retired executor's agent actor so rubric/adaptive gates stay
  // agent-strict for existing callers.
  const toolCtx: ToolContext = {
    db,
    taskRunId: ctx.taskRunId ?? '',
    callerActor: { kind: 'agent', ref: 'dreaming' },
  };
  const payload =
    typeof args.payload === 'object' && args.payload !== null
      ? (args.payload as Record<string, unknown>)
      : {};
  const mutation =
    typeof args.mutation === 'string' && args.mutation.length > 0
      ? args.mutation
      : typeof payload.mutation === 'string'
        ? payload.mutation
        : undefined;
  // Shared schemas re-parse inside execute; invalid shapes throw at the tool boundary.
  if (mutation === 'propose_knowledge_edge') {
    const out = await proposeKnowledgeEdgeTool.execute(toolCtx, {
      ...payload,
      reasoning: args.reasoning,
      evidence_event_ids: args.evidence_event_ids,
    } as never);
    return mapEdgeResult(out);
  }
  const out = await proposeKnowledgeMutationTool.execute(toolCtx, {
    change: { ...payload, mutation },
    reasoning: args.reasoning,
    evidence_event_ids: args.evidence_event_ids,
  } as never);
  return mapMutationResult(out);
}

function mapEdgeResult(out: ProposeKnowledgeEdgeOutput): WriteProposalResult {
  switch (out.status) {
    case 'proposed':
      return { kind: 'knowledge_edge_propose', event_id: out.proposal_id ?? '' };
    case 'skipped:duplicate_live_edge':
      return { kind: 'skipped:duplicate_live_edge', edge_id: out.edge_id ?? out.reason ?? '' };
    case 'skipped:duplicate_pending':
      return {
        kind: 'skipped_duplicate',
        proposal_id: out.proposal_id ?? '',
        cooldown_key: out.cooldown_key ?? '',
      };
    case 'skipped:cooldown':
      return {
        kind: 'skipped_cooldown',
        proposal_id: out.proposal_id ?? '',
        cooldown_key: out.cooldown_key ?? '',
        cooldown_until: out.cooldown_until ?? '',
      };
    case 'skipped:rubric_rejected':
      return {
        kind: 'rubric_rejected',
        event_id: out.proposal_id ?? '',
        gate: out.gate ?? '',
        reason: out.reason ?? '',
      };
    default:
      return {
        kind: 'skipped',
        status: out.status,
        ...(out.proposal_id ? { proposal_id: out.proposal_id } : {}),
        ...(out.cooldown_key ? { cooldown_key: out.cooldown_key } : {}),
        ...(out.reason ? { reason: out.reason } : {}),
      };
  }
}

function mapMutationResult(out: KnowledgeMutationOutput): WriteProposalResult {
  switch (out.status) {
    case 'proposed':
      return { kind: 'tree_mutation', proposal_id: out.proposal_id ?? '' };
    case 'skipped:duplicate_pending':
      return {
        kind: 'skipped_duplicate',
        proposal_id: out.proposal_id ?? '',
        cooldown_key: out.cooldown_key ?? '',
      };
    case 'skipped:cooldown':
      return {
        kind: 'skipped_cooldown',
        proposal_id: out.proposal_id ?? '',
        cooldown_key: out.cooldown_key ?? '',
        cooldown_until: out.cooldown_until ?? '',
      };
    default:
      return {
        kind: 'skipped',
        status: out.status,
        ...(out.proposal_id ? { proposal_id: out.proposal_id } : {}),
        ...(out.cooldown_key ? { cooldown_key: out.cooldown_key } : {}),
        ...(out.reason ? { reason: out.reason } : {}),
      };
  }
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
