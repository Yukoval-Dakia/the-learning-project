// KnowledgeReviewTask — Maintenance Agent runtime (pi agentLoop lane).
//
// YUK-1553 — the private `mcp__loom__write_proposal` custom mount is RETIRED.
// The task now mounts the registered `knowledge_review` DomainTool surface
// through `piDomainMount` → `executeDomainToolCall`, so its model calls the
// same `propose_knowledge_mutation` / `propose_knowledge_edge` shared tools
// every other surface uses (registry input/output schemas, bridge logging,
// unified cooldown gate). The `runWriteProposal` compatibility adapter below
// keeps the existing programmatic caller contract — it forwards to the same
// registered tool implementations rather than owning a parallel path.
//
// Flow:
//   1. Build the input payload (tree + recent failure attempts + agent notes).
//   2. `streamTask` runs the pi agentLoop with the domain mount exposing the
//      `knowledge_review` surface as `mcp__loom__*` tools; the bridge writes
//      the authoritative tool_call_log row per call.
//   3. Return the streamed Response.
//
// Proposals are proposal-only (event(action='propose') rows); the user accepts
// in the inbox — no direct mutation, per the knowledge capability boundary.

import { readAgentNotes } from '@/capabilities/agency/public';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
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

  // U8 / AF §4 — un-expired out-of-band hints addressed to 'maintenance'. HINTS,
  // not facts (labelled as such in the input below); additive context only,
  // never mutates durable learning facts (AF §2.4). Empty on the common path.
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
      // M3 closeout (2026-05-22): canonical LLM payload field name —
      // KnowledgeReviewTask prompt (src/ai/task-prompts.ts buildKnowledgeReviewPrompt)
      // documents `question_id` as the recipe field. NOT ActivityRef legacy.
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
      // U8 / AF §4 — these are HINTS left by narrow tasks, NOT facts: use them to
      // direct maintenance attention (e.g. a flagged structural gap), never as
      // ground truth, and keep proposing only (AF §2.4). Empty when no fresh
      // notes exist → the task behaves exactly as before.
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

// ── runWriteProposal compatibility adapter ──────────────────────────────────
//
// Existing programmatic callers (e.g. the maintenance nightly db tests) still
// invoke `runWriteProposal` with the retired tool's arg shape
// `{ mutation?, payload, reasoning, evidence_event_ids? }`, where the payload
// object IS the mutation change (it carries `payload.mutation` as its
// discriminator; `payload.mutation === 'propose_knowledge_edge'` selects the
// mesh-edge path). This adapter forwards to the REGISTERED DomainTools — there
// is exactly one proposal implementation now. Strict input schemas mean a
// malformed payload throws a zod error instead of silently writing a
// cast-shaped proposal event like the retired executor did.

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
  // P5.4 / YUK-143 (RB-6) — rubric-rejected agent edge. The propose event is
  // still written (folded, marked rubric-rejected); the verdict is surfaced to
  // the agent so it gets structured feedback instead of a silent drop.
  | {
      event_id: string;
      kind: 'rubric_rejected';
      gate: string;
      reason: string;
    }
  // YUK-1553 — the shared tools' own world-state skips that the retired
  // dispatcher never saw (node checks, cross-subject, parent-semantic
  // duplicate, edge_not_found, invalid_payload). `status` carries the shared
  // tool's exact status string so callers see the typed outcome.
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
  // The retired private executor always ran as agent actor 'dreaming'
  // (isAgent: true) — preserve that actor so rubric/adaptive gates keep the
  // same agent-strict behavior for existing callers.
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
  // The shared tool schemas re-parse inside execute, so raw objects are safe to
  // hand over (`as never` mirrors the bridge's execInput cast); invalid shapes
  // throw the typed zod error at the tool boundary.
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
      // YUK-1553 — the registered `knowledge_review` surface (readers +
      // propose_knowledge_mutation + propose_knowledge_edge) through the shared
      // DomainTool bridge. callerActor 'maintenance' matches this task's
      // agent-notes channel and the producers' default actor_ref.
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
    // The domain bridge already writes the authoritative tool_call_log row per
    // call (input, output, error_reason); the runner's input-only stream log
    // stays off so each call logs exactly once — same posture the retired
    // private mount used.
    autoLogToolCalls: false,
  });
}
