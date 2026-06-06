// YUK-216 S2 slice 2 (题源扩展 Strategy D) — SourcingTask handler (tier 2).
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3 / §5
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3.
//
// Tool-calling agent (SourcingTask): given a subject + 考点/题型 + count, searches
// the web for EXISTING practice questions (HTML/TEXT only — OF-1), restructures
// each into a SourcedQuestion, and self-declares the origin URL per question (§0:
// provenance is NOT recoverable from runner logs, so the agent MUST self-report).
//
// Skeleton + MCP mount copied from quiz_gen.ts (parse → INSERT draft → writeEvent →
// catch). The MCP mount mirrors quiz_gen.ts:275-295 (in-process domain-tool MCP +
// env-gated Tavily remote MCP via buildTavilyMcpServer — graceful degradation when
// TAVILY_API_KEY is unset). The chained source_verify enqueue mirrors quiz_gen →
// quiz_verify.
//
// Gate = Option B (owner-confirmed, R6): each sourced question is INSERTed with
// draft_status='draft' (NOT in the review pool, no FSRS yet). The chained
// source_verify job (tier-2 check-set) promotes draft→active + FSRS-enrolls on pass.
//
// OF-2 拍板 (plan §12): off-whitelist sources ARE ingested but DEMOTED —
// metadata.web_sourced.whitelist_match=false. The demotion (sorting them BEHIND
// whitelist_match=true within tier 2) happens at SELECTION time (slice 5a); this
// handler only records the flag correctly. The current profile carries no whitelist
// (slice 4 adds it), so the whitelist is treated as empty here → every question
// lands whitelist_match=false. The verification gate is NOT relaxed for demoted
// questions — demotion only affects selection priority.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import {
  type SourcedQuestionT,
  SourcingTaskOutput,
  type SourcingTaskOutputT,
} from '@/core/schema/sourcing';
import type { Db } from '@/db/client';
import { knowledge, learning_item, question } from '@/db/schema';
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import { type TaskTextResult, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolName,
  toMcpAllowedToolName,
} from '@/server/ai/tools/allowlists';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// The trigger surface mirrors quiz_gen: 'knowledge' / 'learning_item' resolve a
// real row (for the subject profile + knowledge_ids); 'manual' best-effort resolves
// a knowledge node but never skips the run.
export const SOURCING_TRIGGERS = ['knowledge', 'learning_item', 'manual'] as const;
export type SourcingTrigger = (typeof SOURCING_TRIGGERS)[number];

export interface SourcingJobData {
  trigger: SourcingTrigger;
  ref_id: string;
  count?: number;
}

// Default question count when the trigger doesn't specify one.
export const SOURCING_DEFAULT_COUNT = 3;

// Read-only domain-tool surface SourcingTask mounts — enough to confirm the
// knowledge graph so sourced questions attach to real knowledge_ids. Deliberately
// READ-only (the only write is the draft INSERT below). Mirrors QUIZ_GEN_READ_TOOLS.
export const SOURCING_READ_TOOLS = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
] as const satisfies readonly DomainToolName[];

// The handler only consumes { text, task_run_id?, cost_usd? } from the run result,
// so the seam returns the loose TaskTextResult shape (mirrors quiz_gen).
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer | McpHttpServerConfig>;
    allowedTools?: string[];
  },
) => Promise<TaskTextResult>;

type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type BuildTavilyMcpServerFn = () => McpHttpServerConfig | null;
// Chained source_verify enqueue. Mirrors quiz_gen's EnqueueQuizVerifyFn seam so DB
// tests inject a vi.fn().
export type EnqueueSourceVerifyFn = (questionIds: string[]) => Promise<void>;

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
}

async function defaultEnqueueSourceVerify(questionIds: string[]): Promise<void> {
  // Worker process already has boss started; getStartedBoss() returns the same
  // instance (mirrors quiz_gen → quiz_verify). source_verify creates + works the queue.
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds });
}

// Read the subject profile's source whitelist. The field is added by slice 4
// (profile-schema.ts); until then it is absent on every profile, so this resolves to
// an empty list and every sourced question lands whitelist_match=false (OF-2 default
// — logic unchanged whether whitelist is empty or populated).
function profileSourceWhitelist(profile: SubjectProfile): string[] {
  const raw = (profile as { sourceWhitelist?: unknown }).sourceWhitelist;
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
}

// OF-2: does the question's source URL host match a whitelisted domain? Suffix match
// on the hostname (so 'example.edu' matches 'www.example.edu'). An unparseable URL
// never matches (treated as off-whitelist → demoted, not rejected).
export function matchesWhitelist(sourceUrl: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return whitelist.some((domain) => {
    const d = domain.trim().toLowerCase().replace(/^\*\./, '');
    if (d.length === 0) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}

function parseOutput(text: string): SourcingTaskOutputT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('sourcing parseOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`sourcing parseOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = SourcingTaskOutput.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `sourcing parseOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface RunSourcingParams {
  db: Db;
  trigger: SourcingTrigger;
  refId: string;
  count?: number;
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
}

export type RunSourcingStatus = 'ready' | 'skipped:ref_not_found';

export interface RunSourcingResult {
  status: RunSourcingStatus;
  question_ids?: string[];
}

interface ResolvedTrigger {
  refId: string;
  knowledgeNode: { id: string; name: string; domain: string | null } | null;
  knowledgeIds: string[];
  title: string | null;
}

async function resolveTrigger(
  db: Db,
  trigger: SourcingTrigger,
  refId: string,
): Promise<ResolvedTrigger | null> {
  if (trigger === 'knowledge') {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, refId))
      .limit(1);
    const k = rows[0];
    if (!k) return null;
    return { refId, knowledgeNode: k, knowledgeIds: [k.id], title: k.name };
  }
  if (trigger === 'learning_item') {
    const rows = await db
      .select({
        id: learning_item.id,
        title: learning_item.title,
        knowledge_ids: learning_item.knowledge_ids,
      })
      .from(learning_item)
      .where(eq(learning_item.id, refId))
      .limit(1);
    const li = rows[0];
    if (!li) return null;
    let knowledgeNode: ResolvedTrigger['knowledgeNode'] = null;
    const primaryKnowledgeId = li.knowledge_ids[0] ?? null;
    if (primaryKnowledgeId) {
      const kRows = await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, primaryKnowledgeId))
        .limit(1);
      knowledgeNode = kRows[0] ?? null;
    }
    return { refId, knowledgeNode, knowledgeIds: li.knowledge_ids, title: li.title };
  }
  // 'manual' — never skips. Best-effort resolve the ref as a knowledge node.
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(eq(knowledge.id, refId))
    .limit(1);
  const k = rows[0] ?? null;
  return {
    refId,
    knowledgeNode: k,
    knowledgeIds: k ? [k.id] : [],
    title: k?.name ?? null,
  };
}

export async function runSourcing(params: RunSourcingParams): Promise<RunSourcingResult> {
  const { db, trigger, refId } = params;
  const count = params.count ?? SOURCING_DEFAULT_COUNT;
  const run = params.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = params.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const buildTavily = params.buildTavilyMcpServerFn ?? buildTavilyMcpServer;
  const enqueueSourceVerify = params.enqueueSourceVerify ?? defaultEnqueueSourceVerify;

  const resolved = await resolveTrigger(db, trigger, refId);
  if (!resolved) return { status: 'skipped:ref_not_found' };

  const subjectProfile = resolveSubjectProfile(resolved.knowledgeNode?.domain ?? null);
  const whitelist = profileSourceWhitelist(subjectProfile);
  const triggerEventId = `sourcing_trigger_${createId()}`;
  const toolContextTaskRunId = `sourcing_tool_${createId()}`;

  // ── MCP mount: mirror quiz_gen.ts:275-295 ─────────────────────────────────
  const domainMcpServer = buildMcpServer({
    ctx: {
      db,
      taskRunId: toolContextTaskRunId,
      callerActor: { kind: 'agent', ref: 'sourcing' },
      causedByEventId: triggerEventId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: SOURCING_READ_TOOLS,
    taskKind: 'SourcingTask',
  });

  const tavilyCfg = buildTavily();
  const mcpServers: Record<string, SdkMcpServer | McpHttpServerConfig> = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: domainMcpServer,
    ...(tavilyCfg ? { [TAVILY_MCP_SERVER_NAME]: tavilyCfg } : {}),
  };
  const allowedTools = [
    ...SOURCING_READ_TOOLS.map((name) => toMcpAllowedToolName(name)),
    ...(tavilyCfg ? TAVILY_MCP_ALLOWED_TOOLS : []),
  ];

  const input = {
    subject: subjectProfile.id,
    trigger,
    ref: {
      id: resolved.refId,
      name: resolved.title,
      knowledge_node: resolved.knowledgeNode,
    },
    knowledge_context: resolved.knowledgeNode ? [resolved.knowledgeNode] : [],
    count,
    whitelist,
  };

  let taskResult: TaskTextResult | null = null;
  try {
    const result = await run('SourcingTask', input, { db, mcpServers, allowedTools });
    taskResult = result;
    const parsed = parseOutput(result.text);

    // Constrain self-reported knowledge_ids to REAL knowledge nodes (mirror quiz_gen):
    // the agent may hallucinate ids; intersect with existing nodes and fall back to
    // the trigger's resolved ids, throwing only when neither yields an attribution.
    const referencedKnowledgeIds = [...new Set(parsed.questions.flatMap((q) => q.knowledge_ids))];
    const existingKnowledgeRows = referencedKnowledgeIds.length
      ? await db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, referencedKnowledgeIds), isNull(knowledge.archived_at)))
      : [];
    const existingKnowledgeIds = new Set(existingKnowledgeRows.map((r) => r.id));
    const resolveQuestionKnowledgeIds = (q: SourcedQuestionT): string[] => {
      const valid = q.knowledge_ids.filter((kid) => existingKnowledgeIds.has(kid));
      if (valid.length > 0) return valid;
      if (resolved.knowledgeIds.length > 0) return resolved.knowledgeIds;
      throw new Error(
        `sourcing question '${q.prompt_md}' references no known knowledge_id (got [${q.knowledge_ids.join(', ')}]) and the trigger resolved none`,
      );
    };

    const questionIds: string[] = [];
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const q of parsed.questions) {
        const id = createId();
        const judgeKind = defaultJudgeKindForQuestion(q);
        const questionKnowledgeIds = resolveQuestionKnowledgeIds(q);

        // §2.1 web_sourced provenance contract. OF-2: whitelist_match flags
        // off-whitelist sources for selection-time demotion (slice 5a) — it never
        // blocks ingestion or relaxes the verify gate.
        const webSourced: WebSourcedProvenanceT = {
          url: q.source_url,
          title: q.source_title,
          fetched_at: parsed.fetched_at,
          whitelist_match: matchesWhitelist(q.source_url, whitelist),
          ...(q.extraction_hash ? { extraction_hash: q.extraction_hash } : {}),
        };

        await tx.insert(question).values({
          id,
          kind: q.kind,
          source: 'web_sourced',
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          rubric_json: q.rubric_json ?? null,
          choices_md: q.choices_md ?? null,
          judge_kind_override: judgeKind,
          knowledge_ids: questionKnowledgeIds,
          difficulty: q.difficulty,
          // source_ref = the fetched URL; source_ref_kind='url' disambiguates the
          // overloaded source_ref column (合约三). Both land tier 2 via deriveSourceTier.
          source_ref: q.source_url,
          // Option B (R6) — sourced drafts do NOT enter the pool / FSRS until
          // source_verify passes.
          draft_status: 'draft',
          created_by: aiAgentRef('SourcingTask', result),
          metadata: { web_sourced: webSourced, source_ref_kind: 'url' },
          created_at: now,
          updated_at: now,
        });
        questionIds.push(id);
      }
    });

    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'sourcing',
      action: 'experimental:sourcing',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        trigger,
        ref_id: resolved.refId,
        question_ids: questionIds,
        count: questionIds.length,
        query_plan: parsed.query_plan,
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: null,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: new Date(),
    });

    // Chain the verification job. Best-effort (mirror quiz_gen): the drafts are
    // already committed, so a transient enqueue failure must NOT re-throw (that would
    // let pg-boss redeliver the sourcing job, re-run the expensive SourcingTask, and
    // INSERT a duplicate batch). On failure we log the orphaned ids — recoverable by
    // re-enqueueing source_verify, which is idempotent per question.
    try {
      await enqueueSourceVerify(questionIds);
    } catch (enqueueErr) {
      console.error(
        '[sourcing] source_verify enqueue failed; drafts persisted but unverified:',
        questionIds,
        enqueueErr,
      );
    }

    return { status: 'ready', question_ids: questionIds };
  } catch (err) {
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'sourcing',
        action: 'experimental:sourcing',
        subject_kind: 'query',
        subject_id: triggerEventId,
        outcome: 'failure',
        payload: {
          trigger,
          ref_id: resolved.refId,
          error: String((err as Error).message ?? err),
          tool_context_task_run_id: toolContextTaskRunId,
        },
        caused_by_event_id: null,
        task_run_id: taskResult?.task_run_id ?? null,
        cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[sourcing] catch-block cleanup failed for', refId, cleanupErr);
    }
    throw err;
  }
}

export function buildSourcingHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SourcingJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.trigger || !data?.ref_id) {
        console.warn('[sourcing] job missing trigger/ref_id', job.id);
        continue;
      }
      const result = await runSourcing({
        db,
        trigger: data.trigger,
        refId: data.ref_id,
        count: data.count,
        runAgentTaskFn: deps.runAgentTaskFn,
        buildMcpServerFn: deps.buildMcpServerFn,
        buildTavilyMcpServerFn: deps.buildTavilyMcpServerFn,
        enqueueSourceVerify: deps.enqueueSourceVerify,
      });
      console.log(`[sourcing] ${data.trigger}:${data.ref_id} -> ${result.status}`);
    }
  };
}
