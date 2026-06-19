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
// YUK-227 S3 Slice C — image-type sources become proposals (NOT auto-extracted, 守
// ADR-0002). writeAiProposal is the实证 writer (writeProposal does not exist).
// listProposalInboxRows (FIX-6) gives the live-pending dedup the same way variant_gen
// does (handlers/variant_gen.ts:190) — reuse the inbox projection's status derivation
// rather than re-deriving "live" from raw rows.
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { writeAiProposal } from '@/server/proposals/writer';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { kindsMatch } from '@/subjects/question-kind';
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
  // YUK-226 S2-5b F2 — attribution anchor from the 找题次序 (additive). When a manual
  // trigger carries a free-form ref_id, the orchestrator forwards the real knowledge node
  // here so produced questions attribute to it (mirrors quiz_gen's knowledge_id anchor —
  // same anchor semantics). resolveTrigger consumes it preferentially.
  knowledge_id?: string;
  // YUK-226 S2-5b F4 — the 题型 hint the次序 selected this line for (additive). Forwarded
  // into the SourcingTask input's existing `kinds?` field so the agent can target the题型.
  kind?: string;
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
    // The resolved subject profile drives getTaskSystemPrompt's voice/rules. Omitting
    // it makes the runner fall back to the default (wenyan) prompt even for math /
    // physics triggers — pass it through like other subject-specific handlers.
    subjectProfile?: SubjectProfile;
  },
) => Promise<TaskTextResult>;

type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type BuildTavilyMcpServerFn = () => McpHttpServerConfig | null;
// Chained source_verify enqueue. Mirrors quiz_gen's EnqueueQuizVerifyFn seam so DB
// tests inject a vi.fn().
export type EnqueueSourceVerifyFn = (questionIds: string[]) => Promise<void>;
// YUK-227 S3 Slice C — image_candidate proposal writer seam. Defaults to
// writeAiProposal; DB tests inject a vi.fn() to assert the propose path runs WITHOUT
// any question INSERT / VLM call. Loose shape (Pick of writeAiProposal's inputs the
// handler supplies) so the seam stays narrow.
export type WriteImageCandidateProposalFn = (
  db: Db,
  input: Parameters<typeof writeAiProposal>[1],
) => Promise<string>;

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
  writeImageCandidateProposalFn?: WriteImageCandidateProposalFn;
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
  // YUK-226 S2-5b F2 — attribution anchor for manual/free-form triggers: when present,
  // resolveTrigger keys the produced questions to this knowledge node.
  knowledgeId?: string;
  // YUK-226 S2-5b F4 — 题型 hint forwarded into the SourcingTask input (existing `kinds?`).
  kind?: string;
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
  writeImageCandidateProposalFn?: WriteImageCandidateProposalFn;
}

export type RunSourcingStatus = 'ready' | 'skipped:ref_not_found';

export interface RunSourcingResult {
  status: RunSourcingStatus;
  question_ids?: string[];
  // YUK-227 S3 Slice C — proposal event ids written for image-type sources (one per
  // image_candidate the agent reported). Empty/absent when the run found none.
  image_candidate_proposal_ids?: string[];
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
  // YUK-226 S2-5b F2 — explicit knowledge anchor (from the 找题次序). When present it
  // resolves the attribution node directly, regardless of the (free-form) refId. Mirrors
  // quiz_gen's F3 anchor branch — same archived guard as the per-trigger lookups.
  knowledgeId?: string,
): Promise<ResolvedTrigger | null> {
  // F2 — a 找题次序-driven job carries the knowledge node explicitly. Resolve it as the
  // attribution anchor so produced questions key to that node even when refId is a
  // free-form manual string. An archived anchor is treated as missing (same guard as the
  // other lookups) → fall through to the per-trigger resolution. ref_id is preserved.
  if (knowledgeId) {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
      .limit(1);
    const k = rows[0];
    if (k) {
      return { refId, knowledgeNode: k, knowledgeIds: [k.id], title: k.name };
    }
    // Fall through to the per-trigger resolution when the anchor node is missing.
  }
  if (trigger === 'knowledge') {
    // Archived knowledge nodes are treated as missing (other write paths do the
    // same): an archived node must not receive new sourced practice material or FSRS
    // cards (CR — skip archived knowledge triggers).
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(and(eq(knowledge.id, refId), isNull(knowledge.archived_at)))
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
        .where(and(eq(knowledge.id, primaryKnowledgeId), isNull(knowledge.archived_at)))
        .limit(1);
      knowledgeNode = kRows[0] ?? null;
    }
    return { refId, knowledgeNode, knowledgeIds: li.knowledge_ids, title: li.title };
  }
  // 'manual' — never skips. Best-effort resolve the ref as a knowledge node, but an
  // archived node is treated as unresolved (same as the knowledge trigger) so manual
  // runs never attribute new material to archived knowledge (CR).
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, refId), isNull(knowledge.archived_at)))
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
  const writeImageCandidateProposal = params.writeImageCandidateProposalFn ?? writeAiProposal;

  const resolved = await resolveTrigger(db, trigger, refId, params.knowledgeId);
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
    // YUK-226 S2-5b F4 — the 题型 the 找题次序 selected this line for. Folds into the
    // SourcingTask prompt's existing `kinds?` input (plural — a single hint forwarded as a
    // one-element list) so the agent can target the题型. Absent → the agent free-targets.
    ...(params.kind ? { kinds: [params.kind] } : {}),
  };

  let taskResult: TaskTextResult | null = null;
  try {
    const result = await run('SourcingTask', input, {
      db,
      mcpServers,
      allowedTools,
      subjectProfile,
    });
    taskResult = result;
    const parsed = parseOutput(result.text);

    // YUK-226 S2-5b F4 (PR #320 验证轮 A3) — same 题型 pin enforcement as quiz_gen F3, same
    // semantics: when the 找题次序 requested a kind (params.kind, forwarded as the `kinds`
    // input hint), every sourced question MUST be that kind. The prompt only HINTS `kinds`,
    // so an agent that returned an off-target 题型 would ingest a wrong-kind draft. Compare
    // via kindsMatch, which normalizes BOTH sides to canonical (持久 QuestionKind) — so a
    // `reading_comprehension` request matches a `reading` output and `calculation` matches
    // `computation`, regardless of which vocabulary params.kind arrived in. On mismatch
    // throw to fail the whole job (the catch writes a failure event + re-throws → pg-boss
    // retries), the SAME loud-fail semantics F3 uses. Unpinned runs keep the agent's free
    // targeting.
    if (params.kind) {
      for (const q of parsed.questions) {
        if (!kindsMatch(q.kind, params.kind)) {
          throw new Error(
            `sourcing pinned kind='${params.kind}' but agent produced question of kind '${q.kind}'`,
          );
        }
      }
    }

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

    // The trigger-resolved fallback ids must clear the SAME existence + archived
    // filter as the agent-reported ids (CR — fallback must not bypass the live-node
    // check). A trigger carrying a stale/archived id would otherwise mount new
    // questions + FSRS cards onto a dead node. The fallback ids are NOT necessarily a
    // subset of referencedKnowledgeIds (the agent may report none, or only ids the
    // trigger never resolved), so re-query them through the same archived filter
    // rather than reusing existingKnowledgeIds.
    const resolvedKnowledgeRows = resolved.knowledgeIds.length
      ? await db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, resolved.knowledgeIds), isNull(knowledge.archived_at)))
      : [];
    const fallbackKnowledgeIds = resolvedKnowledgeRows.map((r) => r.id);
    const resolveQuestionKnowledgeIds = (q: SourcedQuestionT): string[] => {
      const valid = q.knowledge_ids.filter((kid) => existingKnowledgeIds.has(kid));
      if (valid.length > 0) return valid;
      if (fallbackKnowledgeIds.length > 0) return fallbackKnowledgeIds;
      throw new Error(
        `sourcing question '${q.prompt_md}' references no known knowledge_id (got [${q.knowledge_ids.join(', ')}]) and the trigger resolved none`,
      );
    };

    const questionIds: string[] = [];
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const q of parsed.questions) {
        const id = createId();
        // Preserve the model's EXPLICIT judge_kind_override; only derive a default
        // when the agent left it absent (CR — never clobber an explicit route like
        // 'keyword' with the structural default). defaultJudgeKindForQuestion already
        // returns q.judge_kind_override first, but pinning it here keeps the contract
        // explicit and robust to future helper changes.
        const judgeKind = q.judge_kind_override ?? defaultJudgeKindForQuestion(q);
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
          // Persist the agent's extracted source passage so source_verify can run a
          // DETERMINISTIC prompt↔source overlap without refetching the network (§2.1
          // contract; mirrors quiz_gen source_pack snippet → quiz_verify overlap).
          // REQUIRED (F2): SourcedQuestion.extract is non-optional, so this is always
          // present — source_verify fails any web_sourced row missing it.
          extract: q.extract,
        };

        await tx.insert(question).values(
          withAnswerClass({
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
          }),
        );
        questionIds.push(id);
      }
    });

    // YUK-227 S3 Slice C — image-type sources do NOT enter the question INSERT path.
    // Each is written as an `image_candidate` proposal; the page's image is downloaded
    // + VLM-extracted ONLY on explicit user accept (守 ADR-0002 — there is NO auto VLM
    // 抽图 path here). Best-effort, OUTSIDE the question tx (a proposal write failure
    // must not roll back the already-committed text drafts; the proposals are
    // re-derivable by re-running the cheap text-only path or re-sourcing).
    const candidates = parsed.image_candidates ?? [];
    const imageCandidateProposalIds: string[] = [];
    // FIX-R2-9 — the prompt tells the agent to report a source as EITHER a question OR an
    // image_candidate (二选一), but a misbehaving run can violate that and report the same
    // source_url in BOTH lists. The text question is already INSERTed (higher priority — it
    // is real, extracted text) and accepting the duplicate image_candidate would re-extract
    // the same source via a paid VLM call and stack a duplicate question. So we filter
    // (NOT schema-superRefine: an LLM contract violation must not fail the whole run) any
    // candidate whose source_url already entered the questions path this run, and warn.
    const questionSourceUrls = new Set(parsed.questions.map((q) => q.source_url));
    // FIX-8 — track propose attempts vs failures so an image-only run whose every
    // proposal write FAILED reports failure instead of伪 success (see below). A
    // skipped (already-live) candidate is NOT a failure — it just isn't re-proposed.
    let proposeAttempted = 0;
    let proposeFailed = 0;
    // FIX-6 — live-pending dedup. A sourcing job retried / re-run that re-reports the
    // SAME image URL must not stack duplicate pending image_candidate proposals in the
    // inbox. Reuse the inbox projection's status derivation (same as variant_gen.ts:190)
    // so "live" means exactly what the inbox shows as pending. Snapshot ONCE before the
    // loop: within a single run we also dedup against earlier candidates we just wrote.
    const livePendingCooldownKeys =
      candidates.length > 0
        ? new Set(
            (await listProposalInboxRows(db, { status: 'pending' }))
              .filter((p) => p.kind === 'image_candidate')
              .map((p) => p.payload.cooldown_key)
              .filter((key): key is string => typeof key === 'string'),
          )
        : new Set<string>();
    for (const candidate of candidates) {
      // FIX-R2-9 — the agent reported this URL in BOTH questions and image_candidates
      // (violating the 二选一 prompt contract). The text question already INSERTed wins;
      // skip the duplicate candidate so accept can't re-extract the same source via a paid
      // VLM call and double the question. Warn so the contract violation is visible.
      if (questionSourceUrls.has(candidate.source_url)) {
        console.warn(
          '[sourcing] image_candidate source_url also reported as a text question; skipping the candidate (text wins):',
          candidate.source_url,
        );
        continue;
      }
      const cooldownKey = `image_candidate:${candidate.source_url}`;
      // Skip a URL that already has a live (pending) proposal — or that an earlier
      // candidate in THIS run already proposed (a run can report the same URL twice).
      if (livePendingCooldownKeys.has(cooldownKey)) {
        continue;
      }
      proposeAttempted += 1;
      try {
        const proposalId = await writeImageCandidateProposal(db, {
          actor_ref: 'sourcing',
          // 'partial' = pending in the inbox (mirrors the other producers); accept
          // flips it via the chained rate event.
          outcome: 'partial',
          payload: {
            kind: 'image_candidate',
            // subject_id is null at propose time — the source_asset does not exist
            // until accept downloads + persists the image.
            target: { subject_kind: 'source_asset', subject_id: null },
            reason_md: candidate.summary_md,
            evidence_refs: [],
            proposed_change: {
              source_url: candidate.source_url,
              source_title: candidate.source_title,
              summary_md: candidate.summary_md,
              // YUK-227 S3 Slice C (FIX-3) — carry the run's already-resolved live
              // knowledge nodes so accept attributes the materialized question to
              // the originating 知识点 (the text path stamps these same ids on
              // question.knowledge_ids). fallbackKnowledgeIds is the archived-
              // filtered set the text path uses; image candidates have no
              // per-question knowledge hint (the stem is unread until accept's VLM),
              // so the run-level resolved nodes are the correct attribution. Empty
              // when the trigger resolved no live node (e.g. a manual free-form ref).
              knowledge_ids: fallbackKnowledgeIds,
              // YUK-227 S3 Slice C (FIX-R2-5) — carry the run's 题型约束 (if pinned) so
              // accept materializes the question as that kind. The text path enforces
              // kindsMatch per question (above); image candidates have no per-question
              // kind until accept's VLM, so the run-level requested kind is the correct
              // constraint. Absent on an unpinned run → accept falls back to short_answer.
              ...(params.kind ? { requested_kind: params.kind } : {}),
            },
            // Dedup key so re-sourcing the same image page does not stack duplicate
            // pending proposals (mirrors the cooldown_key precedent on other kinds).
            cooldown_key: cooldownKey,
          },
          task_run_id: result.task_run_id ?? null,
          cost_usd: undefined,
          created_at: now,
        });
        imageCandidateProposalIds.push(proposalId);
        // In-run dedup: a later candidate reporting the same URL is now "live".
        livePendingCooldownKeys.add(cooldownKey);
      } catch (proposalErr) {
        proposeFailed += 1;
        console.error(
          '[sourcing] image_candidate proposal write failed for',
          candidate.source_url,
          proposalErr,
        );
      }
    }

    // FIX-8 — an image-only run (0 text questions) whose every attempted proposal
    // write FAILED is NOT a success: the old code swallowed each write error and
    // still wrote a success event + returned 'ready', silently dropping the run's
    // only output. Throw so the catch writes a failure event + re-throws → pg-boss
    // retries. Guarded on attempted>0 (a run that found candidates but skipped them
    // all as already-live is a legit no-op success, not a failure) and on
    // questionIds.length===0 (a mixed run that ingested ≥1 text draft already
    // produced useful output, so a proposal write failure stays best-effort).
    if (questionIds.length === 0 && proposeAttempted > 0 && proposeFailed === proposeAttempted) {
      throw new Error(
        `sourcing image-only run: all ${proposeAttempted} image_candidate proposal write(s) failed`,
      );
    }

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
        // YUK-227 S3 Slice C — audit the image-type sources surfaced as proposals.
        image_candidate_proposal_ids: imageCandidateProposalIds,
        image_candidate_count: imageCandidateProposalIds.length,
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
    //
    // FIX-8 — only enqueue when there are text drafts to verify. An image-only run
    // produces 0 text questions; enqueueing source_verify([]) is a pointless empty
    // job (source_verify's gate is for text drafts — image drafts get their own
    // verify at accept time). Skip it.
    if (questionIds.length > 0) {
      try {
        await enqueueSourceVerify(questionIds);
      } catch (enqueueErr) {
        console.error(
          '[sourcing] source_verify enqueue failed; drafts persisted but unverified:',
          questionIds,
          enqueueErr,
        );
      }
    }

    return {
      status: 'ready',
      question_ids: questionIds,
      image_candidate_proposal_ids: imageCandidateProposalIds,
    };
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
        // YUK-226 S2-5b F2/F4 — honour the 找题次序's attribution anchor + 题型 hint.
        ...(data.knowledge_id ? { knowledgeId: data.knowledge_id } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        runAgentTaskFn: deps.runAgentTaskFn,
        buildMcpServerFn: deps.buildMcpServerFn,
        buildTavilyMcpServerFn: deps.buildTavilyMcpServerFn,
        enqueueSourceVerify: deps.enqueueSourceVerify,
        writeImageCandidateProposalFn: deps.writeImageCandidateProposalFn,
      });
      console.log(`[sourcing] ${data.trigger}:${data.ref_id} -> ${result.status}`);
    }
  };
}
