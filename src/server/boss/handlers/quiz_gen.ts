// Search-grounded QuizGen — Q3 handler.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §3 / §4.
//
// Tool-calling agent (QuizGenTask): plans, searches Tavily for SOURCE MATERIAL
// (not questions), writes ORIGINAL questions grounded in those sources, and
// self-declares every used URL into source_refs (§0 — provenance is NOT
// recoverable from runner logs, so the agent MUST self-report).
//
// Skeleton copied from embedded_check_generate.ts (parse → INSERT → writeEvent →
// catch). MCP mount copies the verbatim chat.ts:298-306 pattern (Tavily remote
// MCP via buildTavilyMcpServer() — env-gated graceful degradation — + the
// in-process domain-tool MCP that reads the user's mistakes + knowledge graph).
// The chained quiz_verify enqueue mirrors attribution_followup → variant_gen.
//
// Gate = Option B (owner-confirmed §3): each generated question is INSERTed with
// draft_status='draft' (NOT in the review pool, no FSRS yet). The chained
// quiz_verify job (Q5) promotes draft→active + FSRS-enrolls on pass.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import {
  PROSE_KINDS,
  defaultJudgeKindForQuestion,
  nonEmptyStrings,
} from '@/core/schema/judge-routing';
import {
  type QuizGenMetadataT,
  QuizGenOutput,
  type QuizGenOutputT,
  type QuizGenQuestionT,
} from '@/core/schema/quiz_gen';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item, question, source_document } from '@/db/schema';
import { RUNNABLE_ROUTES } from '@/server/ai/judges/question-contract';
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
import { type FewShotExample, renderFewShotBlock } from '@/server/quiz/fewshot-retrieve';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { kindsMatch } from '@/subjects/question-kind';
import {
  resolveQuizGenSkills,
  resolveQuizGenSkillsForSubject,
  skillKindToQuestionKind,
} from '@/subjects/quiz-gen-skills';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// §3 / §4 — the trigger surface. 'manual' carries a free-form ref_id (we still
// try to resolve it as a knowledge node for the subject profile, but never skip
// the run on a manual trigger). 'knowledge' / 'learning_item' resolve a real row.
export const QUIZ_GEN_TRIGGERS = ['knowledge', 'learning_item', 'manual'] as const;
export type QuizGenTrigger = (typeof QUIZ_GEN_TRIGGERS)[number];

export interface QuizGenJobData {
  trigger: QuizGenTrigger;
  ref_id: string;
  count?: number;
  // YUK-226 S2-5b F1 — the §3.2 找题次序 pins which tier it asked for (step 3
  // material_grounded vs step 4 closed_book). Absent on a bare manual quiz_gen
  // trigger, in which case the agent free-chooses the method as before.
  generation_method?: 'material_grounded' | 'closed_book';
  // YUK-226 S2-5b F3 — the knowledge node a manual/free-form trigger should attribute
  // produced questions to (the next 找题次序 round keys off this node's pool).
  knowledge_id?: string;
  // YUK-226 S2-5b F4 — the 题型 hint the次序 selected this line for (additive). Threaded
  // into the QuizGenTask input so the agent can target the题型.
  kind?: string;
}

// §4 — default question count when the trigger doesn't specify one.
export const QUIZ_GEN_DEFAULT_COUNT = 3;

// YUK-225 (S2 slice 4) — cap on total few-shot exemplars folded into the prompt
// across all skill-backed kinds (spec §5: 2-4 per kind; keep the merged block tight).
const FEWSHOT_MAX_TOTAL = 4;

// The read-only domain-tool surface QuizGen mounts: enough to read the user's
// mistakes + knowledge graph so the agent can pick difficulty / types / coverage
// (§1 / §3). Deliberately READ-only — QuizGen never proposes/writes via DomainTools
// (its only write is the draft question INSERT below). Reuses the same domain MCP
// builder Copilot / Dreaming use; we keep the list local rather than adding a new
// `DomainToolSurface` enum (that would widen the shared allowlist matrix).
export const QUIZ_GEN_READ_TOOLS = [
  'query_mistakes',
  'get_attempt_context',
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
  'get_question_context',
] as const satisfies readonly DomainToolName[];

// The handler only consumes { text, task_run_id?, cost_usd? } from the run
// result (parse + provenance + cost), so the seam returns the loose
// TaskTextResult shape — structurally satisfied by runAgentTask's RunTaskResult,
// and easy to fixture in DB tests (mirrors embedded_check_generate's RunTaskFn).
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer | McpHttpServerConfig>;
    allowedTools?: string[];
    // YUK-225 (S2 slice 4) — Agent Skill whitelist + subject context threaded to
    // the runner so the (subject, kind) 规范包 is loaded into the model's listing.
    skills?: string[];
    subjectProfile?: SubjectProfile;
  },
) => Promise<TaskTextResult>;

type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type BuildTavilyMcpServerFn = () => McpHttpServerConfig | null;
// YUK-225 (S2 slice 4) — 轨 2 few-shot retrieval seam. The handler injects a few
// already-pooled同题型 examples into the prompt; DB tests inject a vi.fn(). Keyed by
// the trigger's knowledge ids (the run's target topics).
export type RetrieveFewShotFn = (params: {
  db: Db;
  kind: string;
  knowledgeIds: string[];
}) => Promise<FewShotExample[]>;
// Chained quiz_verify enqueue (Q5 owns the queue + handler). Mirrors
// attribution_followup's EnqueueVariantGenFn seam so DB tests inject a vi.fn().
export type EnqueueQuizVerifyFn = (questionIds: string[]) => Promise<void>;

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueQuizVerify?: EnqueueQuizVerifyFn;
  retrieveFewShotFn?: RetrieveFewShotFn;
}

async function defaultRetrieveFewShot(params: {
  db: Db;
  kind: string;
  knowledgeIds: string[];
}): Promise<FewShotExample[]> {
  const { retrieveFewShotExamples } = await import('@/server/quiz/fewshot-retrieve');
  return retrieveFewShotExamples(params);
}

async function defaultEnqueueQuizVerify(questionIds: string[]): Promise<void> {
  // Worker process already has boss started; getStartedBoss() returns the same
  // instance (mirrors attribution_followup). Q5 creates + works the queue.
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('quiz_verify', { question_ids: questionIds });
}

// §2 / §5 — output JSON parse + judge-contract assertion (shared with
// EmbeddedCheckGenerate via judge-routing). A generated prose / derivation
// question that cannot be graded by its declared route is rejected so downstream
// judges never see an ungradeable question.
function assertGeneratedQuestionHasJudgeContract(q: QuizGenQuestionT): void {
  const route = defaultJudgeKindForQuestion(q);
  if (route === 'keyword' && nonEmptyStrings(q.rubric_json?.keywords).length === 0) {
    throw new Error(`quiz_gen question '${q.prompt_md}' uses keyword judge without keywords`);
  }
  if (route === 'semantic' && nonEmptyStrings(q.rubric_json?.required_points).length === 0) {
    throw new Error(
      `quiz_gen question '${q.prompt_md}' uses semantic judge without required_points`,
    );
  }
  if ((PROSE_KINDS.has(q.kind) || q.kind === 'derivation') && route === 'exact') {
    throw new Error(`quiz_gen ${q.kind} question '${q.prompt_md}' cannot use exact judge`);
  }
  // Defense-in-depth: a generated question must route to a judge the invoker can
  // actually run. The output schema already restricts judge_kind_override to
  // exact|keyword|semantic and defaultJudgeKindForQuestion never derives a
  // non-runnable route, so this only fires on an upstream contract change — but it
  // guarantees we never persist a draft that would return `unsupported` at answer
  // time.
  if (!(RUNNABLE_ROUTES as ReadonlySet<string>).has(route)) {
    throw new Error(`quiz_gen question '${q.prompt_md}' routes to non-runnable judge '${route}'`);
  }
}

function parseOutput(text: string): QuizGenOutputT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = QuizGenOutput.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  for (const q of parsed.data.questions) {
    assertGeneratedQuestionHasJudgeContract(q);
  }
  return parsed.data;
}

// YUK-224 F1 (PR #314 round-1) — read-model passthrough, v1 self-contained.
// For a material_grounded question the题干 references a passage the learner can
// only see if it is rendered alongside the prompt. The review / practice
// render only reads prompt_md, so we EMBED the passage into prompt_md at persist
// time as a leading blockquote ("阅读材料") followed by the original prompt. Pure
// function so it is unit-testable.
//
// phase-deferred: the structural fix — a read-model that renders 题面 and 素材
// separately and de-duplicates one passage across many questions (instead of
// inlining a copy per question) — is a follow-up. See YUK-216 spec §6.1 row 3.
// Until that read-model lands, the embedded copy keeps the learner-visible
// material self-contained.
export function embedMaterialInPrompt(promptMd: string, materialBodyMd: string): string {
  const trimmed = materialBodyMd.trim();
  if (trimmed.length === 0) return promptMd;
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `> **阅读材料**\n${quoted}\n\n${promptMd}`;
}

// YUK-224 F3 (PR #314 round-1) — synthesize per-question source_refs from the
// top-level material so the deterministic copy-safety overlap (quiz_verify reads
// meta.source_refs[].snippet) has the actual passage to compare against. A
// material_grounded question that left source_refs empty would lose the overlap
// signal entirely. We do NOT force the agent to re-emit the passage per question;
// the handler folds ONE synthesized ref (the material URL + a snippet截段 of the
// passage) into each question's source_refs, in addition to whatever the agent
// declared. Pure function so it is unit-testable.
const MATERIAL_SNIPPET_MAX = 500;
export function synthesizeMaterialSourceRefs(
  declared: QuizGenQuestionT['source_refs'],
  material: { url: string; title: string; body_md: string },
): QuizGenQuestionT['source_refs'] {
  const snippet = material.body_md.trim().slice(0, MATERIAL_SNIPPET_MAX);
  // Skip if the agent already declared a ref carrying the material URL with a
  // snippet (don't duplicate). Otherwise prepend the synthesized material ref.
  const alreadyHasMaterialSnippet = declared.some(
    (r) => r.url === material.url && typeof r.snippet === 'string' && r.snippet.length > 0,
  );
  if (alreadyHasMaterialSnippet) return declared;
  return [
    {
      url: material.url,
      title: material.title,
      snippet,
      used_for: 'fact' as const,
      extracted: true,
    },
    ...declared,
  ];
}

export interface RunQuizGenParams {
  db: Db;
  trigger: QuizGenTrigger;
  refId: string;
  count?: number;
  // YUK-226 S2-5b F1 — when set, the 找题次序 pins the generation_method (the agent is
  // instructed to honour it). Absent → original free-choice behaviour preserved.
  generationMethod?: 'material_grounded' | 'closed_book';
  // YUK-226 S2-5b F3 — attribution anchor for manual/free-form triggers: when present,
  // resolveTrigger keys the produced questions to this knowledge node.
  knowledgeId?: string;
  // YUK-226 S2-5b F4 — 题型 hint forwarded into the QuizGenTask input.
  kind?: string;
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  enqueueQuizVerify?: EnqueueQuizVerifyFn;
  retrieveFewShotFn?: RetrieveFewShotFn;
}

export type RunQuizGenStatus = 'ready' | 'skipped:ref_not_found';

export interface RunQuizGenResult {
  status: RunQuizGenStatus;
  question_ids?: string[];
  tool_quiz_artifact_id?: string;
}

interface ResolvedTrigger {
  refId: string;
  knowledgeNode: { id: string; name: string; domain: string | null } | null;
  knowledgeIds: string[];
  title: string | null;
}

async function resolveTrigger(
  db: Db,
  trigger: QuizGenTrigger,
  refId: string,
  // YUK-226 S2-5b F3 — explicit knowledge anchor (from the 找题次序). When present it
  // resolves the attribution node directly, regardless of the (free-form) refId.
  knowledgeId?: string,
): Promise<ResolvedTrigger | null> {
  // F3 — a 找题次序-driven job carries the knowledge node explicitly. Resolve it as the
  // attribution anchor so produced questions key to that node even when refId is a
  // free-form manual string. ref_id (the trigger pointer) is preserved verbatim.
  if (knowledgeId) {
    // YUK-226 S2-5b F3 — the explicit anchor must clear the SAME archived guard as the
    // other knowledge lookups (knowledge / learning_item primary node + the constrain
    // step's existence check all filter archived_at). An archived anchor is treated as
    // missing → fall through to per-trigger resolution (which, for a manual trigger, runs
    // its own unarchived best-effort lookup), so a stale/archived 找题次序 anchor never
    // mounts new drafts onto a dead node.
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
    // YUK-226 S2-5b F2 (PR #320 round-4) — guard archived here too. Without it, an
    // archived explicit anchor that was rejected above (isNull(archived_at)) would fall
    // through to THIS branch and, when refId === the same archived id, re-resolve the dead
    // node WITHOUT the guard — silently mounting drafts onto an archived node (the exact
    // bypass the anchor guard exists to prevent). The archived knowledge trigger now skips.
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
      // F2 — same archived guard: a learning_item pointing at an archived primary node
      // must not resolve that dead node as the attribution anchor.
      const kRows = await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(and(eq(knowledge.id, primaryKnowledgeId), isNull(knowledge.archived_at)))
        .limit(1);
      knowledgeNode = kRows[0] ?? null;
    }
    return { refId, knowledgeNode, knowledgeIds: li.knowledge_ids, title: li.title };
  }
  // 'manual' — never skips. Best-effort resolve the ref as a knowledge node for
  // the subject profile; the run proceeds either way (§4 manual-first). F2 — guard
  // archived: a manual ref pointing at an archived node resolves to no node (run still
  // proceeds, just without that dead node as the attribution anchor).
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

export async function runQuizGen(params: RunQuizGenParams): Promise<RunQuizGenResult> {
  const { db, trigger, refId } = params;
  const count = params.count ?? QUIZ_GEN_DEFAULT_COUNT;
  const run = params.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = params.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const buildTavily = params.buildTavilyMcpServerFn ?? buildTavilyMcpServer;
  const enqueueQuizVerify = params.enqueueQuizVerify ?? defaultEnqueueQuizVerify;
  const retrieveFewShot = params.retrieveFewShotFn ?? defaultRetrieveFewShot;

  const resolved = await resolveTrigger(db, trigger, refId, params.knowledgeId);
  // knowledge / learning_item triggers must resolve a real row; manual always
  // resolves (best-effort) so it never skips.
  if (!resolved) return { status: 'skipped:ref_not_found' };

  const subjectProfile = resolveSubjectProfile(resolved.knowledgeNode?.domain ?? null);
  const triggerEventId = `quiz_gen_trigger_${createId()}`;
  const toolContextTaskRunId = `quiz_gen_tool_${createId()}`;

  // ── MCP mount: copy chat.ts:298-306 verbatim pattern ──────────────────────
  // In-process domain-tool MCP (read user mistakes + knowledge graph) + the
  // env-gated Tavily remote MCP. When TAVILY_API_KEY is unset, buildTavily()
  // returns null → no tavily server, no tavily tools (graceful degradation).
  const domainMcpServer = buildMcpServer({
    ctx: {
      db,
      taskRunId: toolContextTaskRunId,
      callerActor: { kind: 'agent', ref: 'quiz_gen' },
      causedByEventId: triggerEventId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: QUIZ_GEN_READ_TOOLS,
    taskKind: 'QuizGenTask',
  });

  const tavilyCfg = buildTavily();
  const mcpServers: Record<string, SdkMcpServer | McpHttpServerConfig> = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: domainMcpServer,
    ...(tavilyCfg ? { [TAVILY_MCP_SERVER_NAME]: tavilyCfg } : {}),
  };
  const allowedTools = [
    ...QUIZ_GEN_READ_TOOLS.map((name) => toMcpAllowedToolName(name)),
    ...(tavilyCfg ? TAVILY_MCP_ALLOWED_TOOLS : []),
  ];

  // YUK-225 (S2 slice 4) — 规范双轨.
  // 轨 1: whitelist the subject's quiz-gen SKILL.md规范包 so the model loads them
  //       (the runner already mirrored every subject skill into the isolated
  //       CLAUDE_CONFIG_DIR/skills; `skills` keys which ones are visible). 降级链:
  //       resolveQuizGenSkillsForSubject returns undefined when the subject has no
  //       pack → no skills option → promptFragments fallback.
  // 轨 2: retrieve a few already-pooled同题型 examples (high-tier first) and fold a
  //       few-shot block into the prompt. Best-effort: a retrieval failure must not
  //       block generation, so we log + continue with no block (降级).
  const subjectSkills = resolveQuizGenSkillsForSubject(subjectProfile.id);

  let fewShotBlock = '';
  if (resolved.knowledgeIds.length > 0) {
    // QuizGen runs emit mixed kinds; retrieve few-shot across the subject's
    // skill-backed kinds (translation / reading_comprehension / calculation …)
    // and merge a small set so each kind the model writes has an exemplar.
    const skillBackedKinds = (subjectProfile.questionKinds ?? []).filter(
      (k) => resolveQuizGenSkills(subjectProfile.id, k) !== undefined,
    );
    const collected: FewShotExample[] = [];
    for (const k of skillBackedKinds) {
      try {
        const examples = await retrieveFewShot({
          db,
          // `k` is a profile SubjectQuestionKind ('calculation'); the few-shot SQL
          // filters persisted `question.kind` which stores 'computation'. Normalize
          // so the WHERE clause matches real rows (PR #319 F3 — same map as the skill
          // resolver, so出题/验题/few-shot agree on the kind key).
          kind: skillKindToQuestionKind(k),
          knowledgeIds: resolved.knowledgeIds,
        });
        collected.push(...examples);
      } catch (fewShotErr) {
        console.error('[quiz_gen] few-shot retrieval failed (non-fatal) for kind', k, fewShotErr);
      }
    }
    fewShotBlock = renderFewShotBlock(collected.slice(0, FEWSHOT_MAX_TOTAL));
  }

  const input = {
    trigger,
    ref: {
      id: resolved.refId,
      name: resolved.title,
      knowledge_node: resolved.knowledgeNode,
    },
    knowledge_context: resolved.knowledgeNode ? [resolved.knowledgeNode] : [],
    count,
    // 轨 2 — injected exemplars (empty string when no hits / no skill-backed kinds).
    ...(fewShotBlock ? { few_shot_examples_md: fewShotBlock } : {}),
    // YUK-226 S2-5b F1 — the 找题次序 pins which tier it asked for. The agent prompt
    // (buildQuizGenPrompt) instructs honouring requested_generation_method when present;
    // absent → the agent free-chooses (original behaviour).
    ...(params.generationMethod ? { requested_generation_method: params.generationMethod } : {}),
    // YUK-226 S2-5b F4 — the 题型 hint the次序 selected this line for. Forwarded additively
    // so the agent can target it; absent → the agent free-targets (original behaviour).
    ...(params.kind ? { requested_kind: params.kind } : {}),
  };

  let taskResult: TaskTextResult | null = null;
  try {
    const result = await run('QuizGenTask', input, {
      db,
      mcpServers,
      allowedTools,
      subjectProfile,
      ...(subjectSkills ? { skills: subjectSkills } : {}),
    });
    taskResult = result;
    const parsed = parseOutput(result.text);

    // YUK-226 S2-5b F1 — when the 找题次序 PINNED a generation_method (step 3
    // material_grounded vs step 4 closed_book), the agent prompt instructs honouring it,
    // but the prompt is only a hint — a model that ignores the pin would persist the WRONG
    // tier (a closed_book draft where the次序 asked for material_grounded, or vice versa).
    // Assert the pin held; on mismatch throw so the run fails loudly (the catch writes a
    // failure event and re-throws → pg-boss retries) rather than silently mis-tiering the
    // draft into the pool. Unpinned runs (bare manual quiz_gen) keep the agent's free choice.
    if (params.generationMethod && parsed.generation_method !== params.generationMethod) {
      throw new Error(
        `quiz_gen pinned generation_method='${params.generationMethod}' but agent produced '${parsed.generation_method}'`,
      );
    }

    // YUK-226 S2-5b F3 (PR #320 验证轮 A3) — pre-persist assert for the 题型 pin. When the
    // 找题次序 requested a specific kind (params.kind), every produced question MUST be that
    // kind; the prompt only HINTS requested_kind, so a model that wrote a different kind
    // would persist an off-target draft. Compare via kindsMatch, which normalizes BOTH
    // sides to canonical (持久 QuestionKind) — so a `reading_comprehension` request matches
    // a `reading` output and `calculation` matches `computation`, regardless of which
    // vocabulary params.kind arrived in. On mismatch throw (the catch writes a failure
    // event + re-throws → pg-boss retries) rather than silently persisting the wrong 题型.
    // Unpinned runs keep the agent's choice.
    if (params.kind) {
      for (const q of parsed.questions) {
        if (!kindsMatch(q.kind, params.kind)) {
          throw new Error(
            `quiz_gen pinned kind='${params.kind}' but agent produced question of kind '${q.kind}'`,
          );
        }
      }
    }

    // Constrain self-reported knowledge_ids to REAL knowledge nodes. The agent may
    // hallucinate ids; an unattributable draft would pass verify yet never resolve
    // to a real node (knowledge page / subject resolution / aggregation can't place
    // it). Mirror the ingestion-import guard (reject unknown/archived), but salvage
    // partial hallucination: intersect each question's ids with existing nodes,
    // fall back to the trigger's resolved knowledge_ids when the agent's set is
    // fully bogus, and throw only when neither yields an attribution.
    const referencedKnowledgeIds = [...new Set(parsed.questions.flatMap((q) => q.knowledge_ids))];
    const existingKnowledgeRows = referencedKnowledgeIds.length
      ? await db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, referencedKnowledgeIds), isNull(knowledge.archived_at)))
      : [];
    const existingKnowledgeIds = new Set(existingKnowledgeRows.map((r) => r.id));
    const resolveQuestionKnowledgeIds = (q: QuizGenQuestionT): string[] => {
      const valid = q.knowledge_ids.filter((kid) => existingKnowledgeIds.has(kid));
      if (valid.length > 0) return valid;
      if (resolved.knowledgeIds.length > 0) return resolved.knowledgeIds;
      throw new Error(
        `quiz_gen question '${q.prompt_md}' references no known knowledge_id (got [${q.knowledge_ids.join(', ')}]) and the trigger resolved none`,
      );
    };

    const questionIds: string[] = [];
    const quizKnowledgeIds = new Set<string>();
    const toolQuizArtifactId = createId();
    const now = new Date();
    // YUK-224 (slice 3, tier 3) — material_grounded persists the fetched REAL source
    // material to a source_document row FIRST (with the URL in provenance), then every
    // generated question carries that row id in metadata.quiz_gen.material_source_document_id.
    // The output schema guarantees `parsed.material` is present when the method is
    // material_grounded (superRefine). source_document has no step9 invariant audit
    // (only event / learning_session / material_fsrs_state / artifact are audited), so
    // this new writer needs no allowlist registration. The id is shared across all
    // questions in the run (one passage → many questions probing it).
    let materialSourceDocumentId: string | null = null;
    await db.transaction(async (tx) => {
      if (parsed.generation_method === 'material_grounded' && parsed.material) {
        materialSourceDocumentId = createId();
        await tx.insert(source_document).values({
          id: materialSourceDocumentId,
          title: parsed.material.title,
          source_asset_ids: [],
          body_md: parsed.material.body_md,
          // URL provenance — the fetched material's origin. source_kind tags it as a
          // quiz_gen-fetched material so audits can distinguish it from ingestion docs.
          provenance: {
            source_kind: 'quiz_gen_material',
            url: parsed.material.url,
            fetched_at: parsed.material.fetched_at,
            captured_by: aiAgentRef('QuizGenTask', result),
          } as never,
          created_at: now,
          updated_at: now,
          version: 0,
        });
      }
      for (const q of parsed.questions) {
        const id = createId();
        const judgeKind = defaultJudgeKindForQuestion(q);
        const questionKnowledgeIds = resolveQuestionKnowledgeIds(q);
        for (const kid of questionKnowledgeIds) {
          quizKnowledgeIds.add(kid);
        }
        // YUK-224 F3 — material_grounded: synthesize a per-question source_ref from
        // the top-level material (url + passage snippet) so the deterministic
        // copy-safety overlap has the passage to compare against. Non-material runs
        // keep the agent-declared refs verbatim.
        const effectiveSourceRefs =
          parsed.generation_method === 'material_grounded' && parsed.material
            ? synthesizeMaterialSourceRefs(q.source_refs, parsed.material)
            : q.source_refs;

        // YUK-224 F1 — material_grounded: embed the passage into prompt_md so the
        // review / practice render (which only reads prompt_md) shows the learner
        // the material the题干 references. Non-material runs keep the prompt verbatim.
        const effectivePromptMd =
          parsed.generation_method === 'material_grounded' && parsed.material
            ? embedMaterialInPrompt(q.prompt_md, parsed.material.body_md)
            : q.prompt_md;

        // §2 — metadata.quiz_gen: the agent self-reports source_pack + per-run
        // copy_safety; we fold the per-question source_refs into the row's
        // metadata so each draft carries its own provenance.
        const metaQuizGen: QuizGenMetadataT = {
          source_pack: parsed.source_pack,
          source_refs: effectiveSourceRefs,
          generation_method: parsed.generation_method,
          // V1 LOW — the agent self-reports verdict + max_overlap, but the gen
          // stage MUST stamp checked_by='agent_self' itself; an agent claiming
          // checked_by='quiz_verify' here would forge a verification it never ran.
          // QuizVerify (Q5) overwrites this whole block with checked_by='quiz_verify'
          // once it actually runs.
          copy_safety: {
            verdict: parsed.self_copy_safety.verdict,
            ...(parsed.self_copy_safety.max_overlap !== undefined
              ? { max_overlap: parsed.self_copy_safety.max_overlap }
              : {}),
            checked_by: 'agent_self',
          },
          generation_status: 'ready',
          // YUK-224 tier 3 — back-fill the persisted material's source_document id so
          // deriveSourceTier lands tier 3 (material_grounded + material_source_document_id).
          // Only set for material_grounded; the QuizGenMetadata superRefine requires it
          // when generation_method='material_grounded', so this is the live writer that
          // naturally satisfies that contract.
          ...(materialSourceDocumentId
            ? { material_source_document_id: materialSourceDocumentId }
            : {}),
        };
        await tx.insert(question).values({
          id,
          kind: q.kind,
          source: 'quiz_gen',
          prompt_md: effectivePromptMd,
          reference_md: q.reference_md,
          rubric_json: q.rubric_json ?? null,
          choices_md: q.choices_md ?? null,
          judge_kind_override: judgeKind,
          knowledge_ids: questionKnowledgeIds,
          difficulty: q.difficulty,
          // §2 — trigger pointer (knowledge_id / learning_item_id), NOT a web URL.
          source_ref: resolved.refId,
          // Option B (§3) — generated drafts do NOT enter the pool / FSRS until
          // quiz_verify passes (Q5 promotes draft→active + enrolls).
          draft_status: 'draft',
          created_by: aiAgentRef('QuizGenTask', result),
          metadata: { quiz_gen: metaQuizGen },
          created_at: now,
          updated_at: now,
        });
        questionIds.push(id);
      }

      await tx.insert(artifact).values({
        id: toolQuizArtifactId,
        type: 'tool_quiz',
        title: resolved.title ? `${resolved.title} 组卷` : '自定义组卷',
        parent_artifact_id: null,
        knowledge_ids: [...quizKnowledgeIds],
        intent_source: 'quiz_gen',
        source: 'ai_generated',
        source_ref: resolved.refId,
        body_blocks: null,
        attrs: {
          trigger,
          generation_method: parsed.generation_method,
          source_pack: parsed.source_pack,
        } as never,
        tool_kind: 'quiz_gen',
        tool_state: {
          question_ids: questionIds,
          session_meta: {
            trigger,
            ref_id: resolved.refId,
            generation_method: parsed.generation_method,
            tool_context_task_run_id: toolContextTaskRunId,
          },
        } as never,
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: aiAgentRef('QuizGenTask', result) as never,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });
    });

    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'quiz_gen',
      action: 'experimental:quiz_gen',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        trigger,
        ref_id: resolved.refId,
        question_ids: questionIds,
        tool_quiz_artifact_id: toolQuizArtifactId,
        count: questionIds.length,
        generation_method: parsed.generation_method,
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: null,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: new Date(),
    });

    // Chain the verification job (Q5). Best-effort, mirroring the ingestion route's
    // attribution_followup enqueue: the draft questions are already committed, so a
    // transient enqueue failure must NOT re-throw. Re-throwing would let pg-boss
    // redeliver the quiz_gen job, re-run the expensive QuizGenTask, and INSERT a
    // DUPLICATE batch of drafts (the handler has no per-trigger idempotency key).
    // On failure we log the orphaned ids — recoverable by re-enqueueing quiz_verify,
    // which is itself idempotent per question.
    try {
      await enqueueQuizVerify(questionIds);
    } catch (enqueueErr) {
      console.error(
        '[quiz_gen] quiz_verify enqueue failed; drafts persisted but unverified:',
        questionIds,
        enqueueErr,
      );
    }

    return {
      status: 'ready',
      question_ids: questionIds,
      tool_quiz_artifact_id: toolQuizArtifactId,
    };
  } catch (err) {
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'quiz_gen',
        action: 'experimental:quiz_gen',
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
      console.error('[quiz_gen] catch-block cleanup failed for', refId, cleanupErr);
    }
    throw err;
  }
}

export function buildQuizGenHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<QuizGenJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.trigger || !data?.ref_id) {
        console.warn('[quiz_gen] job missing trigger/ref_id', job.id);
        continue;
      }
      const result = await runQuizGen({
        db,
        trigger: data.trigger,
        refId: data.ref_id,
        count: data.count,
        // YUK-226 S2-5b F1/F3/F4 — honour the 找题次序's pinned method + attribution anchor + 题型 hint.
        ...(data.generation_method ? { generationMethod: data.generation_method } : {}),
        ...(data.knowledge_id ? { knowledgeId: data.knowledge_id } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        runAgentTaskFn: deps.runAgentTaskFn,
        buildMcpServerFn: deps.buildMcpServerFn,
        buildTavilyMcpServerFn: deps.buildTavilyMcpServerFn,
        enqueueQuizVerify: deps.enqueueQuizVerify,
        retrieveFewShotFn: deps.retrieveFewShotFn,
      });
      console.log(`[quiz_gen] ${data.trigger}:${data.ref_id} -> ${result.status}`);
    }
  };
}
